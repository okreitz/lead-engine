/**
 * Polite plain-HTTP crawler (SPEC §4.5):
 * - obeys robots.txt for our User-Agent (5xx or network errors on robots.txt = disallow),
 * - at most 1 request per 2 seconds per host, 10 s timeout, 2 MB page cap,
 * - never fetches LinkedIn or other ToS-protected sites (CLAUDE.md),
 * - only public addresses (SSRF guard), redirects re-checked hop by hop,
 * - HTML and plain text only.
 * Pages are untrusted data: callers pass them to the LLM only inside data blocks.
 */
import robotsParserModule from 'robots-parser';
import { Agent, fetch as undiciFetch } from 'undici';
import { VERSION } from '../version.ts';
import { extractPage, type ExtractedPage } from './extract.ts';
import { isPublicAddress, safeLookup } from './net-guard.ts';

// robots-parser is CommonJS (`module.exports = fn`); its bundled types don't model that.
const robotsParser = robotsParserModule as unknown as (
  url: string,
  body: string,
) => { isAllowed(url: string, ua?: string): boolean | undefined };

export const USER_AGENT_TOKEN = 'LeadEngineBot';
export const USER_AGENT = `${USER_AGENT_TOKEN}/${VERSION} (+https://github.com/okreitz/lead-engine)`;

/** Sites we never crawl directly (ToS). Subdomains included. */
export const BLOCKED_SITES = [
  'linkedin.com',
  'lnkd.in',
  'reddit.com',
  'redd.it',
  'g2.com',
  'capterra.com',
  'glassdoor.com',
  'facebook.com',
  'fb.com',
  'instagram.com',
];

export class CrawlError extends Error {
  override name = 'CrawlError';
  constructor(
    message: string,
    public readonly url: string,
    public readonly kind: 'blocked' | 'robots' | 'http' | 'network' | 'type' | 'size' | 'invalid',
  ) {
    super(message);
  }
}

export interface CrawledPage extends ExtractedPage {
  url: string;
  status: number;
}

type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; redirect: 'manual'; signal: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | null;
}>;

export interface CrawlerOptions {
  fetch?: FetchLike;
  /** Minimum gap between requests to one host. */
  hostIntervalMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function isBlockedSite(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return BLOCKED_SITES.some((s) => h === s || h.endsWith(`.${s}`));
}

/** Validates a user-supplied URL: http(s), public hostname, not a blocked site. */
export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new CrawlError('not a valid URL', raw, 'invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new CrawlError('only http(s) URLs', raw, 'invalid');
  if (url.username || url.password)
    throw new CrawlError('URLs with credentials are not allowed', raw, 'invalid');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isBlockedSite(host))
    throw new CrawlError(`${host} is not crawled (terms of service)`, raw, 'blocked');
  if (/^[\d.]+$|:/.test(host) && !isPublicAddress(host))
    throw new CrawlError('non-public address', raw, 'blocked');
  if (
    !host.includes('.') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'localhost'
  ) {
    throw new CrawlError('non-public hostname', raw, 'blocked');
  }
  url.hash = '';
  return url;
}

export class Crawler {
  private readonly fetchImpl: FetchLike;
  private readonly hostIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly nextSlot = new Map<string, number>();
  private readonly robots = new Map<
    string,
    { fetchedAt: number; allows: (url: string) => boolean }
  >();

  constructor(options: CrawlerOptions = {}) {
    if (options.fetch) {
      this.fetchImpl = options.fetch;
    } else {
      const dispatcher = new Agent({ connect: { lookup: safeLookup }, connectTimeout: 10_000 });
      this.fetchImpl = (url, init) =>
        undiciFetch(url, { ...init, dispatcher }) as ReturnType<FetchLike>;
    }
    this.hostIntervalMs = options.hostIntervalMs ?? 2_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? Date.now;
  }

  /** Waits for this host's next free slot (1 request per interval). */
  private async throttle(host: string): Promise<void> {
    const now = this.now();
    const slot = Math.max(now, this.nextSlot.get(host) ?? 0);
    this.nextSlot.set(host, slot + this.hostIntervalMs);
    if (slot > now) await this.sleep(slot - now);
  }

  private async rawGet(
    url: URL,
    accept: string,
  ): Promise<{ status: number; type: string; body: string; location: string | null }> {
    await this.throttle(url.host);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url.toString(), {
        headers: { 'user-agent': USER_AGENT, accept },
        redirect: 'manual',
        signal: controller.signal,
      });
      const length = Number(res.headers.get('content-length') ?? 0);
      if (length > this.maxBytes)
        throw new CrawlError('page larger than 2 MB', url.toString(), 'size');
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (res.body && res.status < 300) {
        for await (const chunk of res.body) {
          size += chunk.byteLength;
          if (size > this.maxBytes) {
            controller.abort();
            throw new CrawlError('page larger than 2 MB', url.toString(), 'size');
          }
          chunks.push(chunk);
        }
      }
      return {
        status: res.status,
        type: res.headers.get('content-type') ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        location: res.headers.get('location'),
      };
    } catch (err) {
      if (err instanceof CrawlError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new CrawlError(
        controller.signal.aborted ? 'timed out' : `fetch failed: ${msg}`,
        url.toString(),
        'network',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** robots.txt for an origin, cached for a day. 4xx = allow all; 5xx/network = disallow all. */
  async allowedByRobots(url: URL): Promise<boolean> {
    const origin = url.origin;
    const cached = this.robots.get(origin);
    if (cached && this.now() - cached.fetchedAt < 24 * 3600_000)
      return cached.allows(url.toString());
    let allows: (u: string) => boolean;
    try {
      const robotsUrl = new URL('/robots.txt', origin);
      let res = await this.rawGet(robotsUrl, 'text/plain');
      // Follow one same-site redirect (e.g. http → https).
      if (res.status >= 300 && res.status < 400 && res.location) {
        const next = checkUrl(new URL(res.location, robotsUrl).toString());
        res = await this.rawGet(next, 'text/plain');
      }
      if (res.status >= 200 && res.status < 300) {
        const robot = robotsParser(robotsUrl.toString(), res.body);
        allows = (u) => robot.isAllowed(u, USER_AGENT_TOKEN) !== false;
      } else if (res.status >= 400 && res.status < 500) {
        allows = () => true;
      } else {
        allows = () => false;
      }
    } catch {
      allows = () => false;
    }
    this.robots.set(origin, { fetchedAt: this.now(), allows });
    return allows(url.toString());
  }

  /** Fetches one page, following up to 5 redirects with every check repeated per hop. */
  async fetchPage(raw: string): Promise<CrawledPage> {
    let url = checkUrl(raw);
    for (let hop = 0; hop <= 5; hop++) {
      if (!(await this.allowedByRobots(url))) {
        throw new CrawlError('disallowed by robots.txt', url.toString(), 'robots');
      }
      const res = await this.rawGet(url, 'text/html,text/plain;q=0.9');
      if (res.status >= 300 && res.status < 400 && res.location) {
        url = checkUrl(new URL(res.location, url).toString());
        continue;
      }
      if (res.status >= 400) throw new CrawlError(`HTTP ${res.status}`, url.toString(), 'http');
      const type = res.type.toLowerCase();
      if (
        !type.includes('text/html') &&
        !type.includes('text/plain') &&
        !type.includes('application/xhtml')
      ) {
        throw new CrawlError(
          `unsupported content type ${type || 'unknown'}`,
          url.toString(),
          'type',
        );
      }
      const page = type.includes('text/plain')
        ? { title: '', description: '', text: res.body, links: [] }
        : extractPage(res.body, url.toString());
      return { ...page, url: url.toString(), status: res.status };
    }
    throw new CrawlError('too many redirects', raw, 'http');
  }
}
