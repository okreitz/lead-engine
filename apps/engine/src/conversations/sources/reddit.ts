/**
 * Reddit, only through Google search via Serper (decision 2026-11-08; docs/providers.md
 * "Serper", checked 2026-11-16): `POST https://google.serper.dev/search` with `X-API-KEY`,
 * `{"q": "site:reddit.com (\"a\" OR \"b\")", "gl": "us", "hl": "en", "tbs": "qdr:d"}`.
 * Only URL, title and snippet are stored, and the inbox links out; nothing is fetched from
 * reddit.com. Serper's 2,500 free queries are a one-time grant per account: the provider layer
 * counts them per workspace and caps paid queries at $0, so a used-up grant stops the source
 * instead of buying a $50 pack. Phrases are OR-ed in groups to stretch the grant.
 */
import { defaultHttp, readJson, type HttpFetch } from '../../people/http.ts';
import { callProvider, ProviderAuthError, ProviderCallError } from '../../providers/index.ts';
import type { ProviderAdapter } from '../../providers/types.ts';
import { oneLine } from '../text.ts';
import type { PollInput, PollOutput, PollingSource, RawThread } from '../types.ts';

export const SERPER_URL = 'https://google.serper.dev/search';
export const SERPER_FREE_QUERIES = 2_500;
/** $50 for 50,000 credits: only used for the (refused) paid estimate. */
export const SERPER_PAID_USD = 0.001;
/** Phrases OR-ed into one query (Google allows about 32 words). */
export const REDDIT_PHRASES_PER_QUERY = 4;
/** Queries per daily run, so 2,500 free queries last months, not weeks. */
export const REDDIT_QUERIES_PER_DAY = 10;

export interface SerperInput {
  q: string;
}

export function redditQuery(phrases: string[]): string {
  const parts = phrases.map((p) => `"${p.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()}"`);
  return `site:reddit.com ${parts.length > 1 ? `(${parts.join(' OR ')})` : parts[0]}`;
}

interface Organic {
  link?: unknown;
  title?: unknown;
  snippet?: unknown;
}

/** Serper organic results → threads. Only reddit.com post URLs are kept. */
export function parseSerperOrganic(json: unknown, now: number): RawThread[] {
  const organic = (json as { organic?: unknown })?.organic;
  if (!Array.isArray(organic)) return [];
  const out: RawThread[] = [];
  for (const r of organic as Organic[]) {
    const link = typeof r.link === 'string' ? r.link : '';
    let u: URL;
    try {
      u = new URL(link);
    } catch {
      continue;
    }
    if (!/(^|\.)reddit\.com$/i.test(u.hostname) || !/\/comments\/[a-z0-9]+/i.test(u.pathname))
      continue;
    const sub = /^\/r\/([^/]+)/i.exec(u.pathname)?.[1] ?? null;
    out.push({
      source: 'reddit',
      externalId: /\/comments\/([a-z0-9]+)/i.exec(u.pathname)![1]!.toLowerCase(),
      url: link,
      title:
        oneLine(typeof r.title === 'string' ? r.title.replace(/ ?[:-] ?r\/\w+$/i, '') : '', 300) ||
        '(untitled)',
      text: typeof r.snippet === 'string' ? oneLine(r.snippet, 500) : '',
      // Reddit: no author is stored (search results only).
      author: null,
      // Serper's `date` is relative text ("4 hours ago"); the query covers the past 24 h.
      postedAt: now,
      meta: { ...(sub ? { subreddit: sub } : {}), via: 'Google search (Serper)' },
    });
  }
  return out;
}

export function serperAdapter(http: HttpFetch): ProviderAdapter<SerperInput, RawThread[]> {
  return {
    provider: 'serper',
    operation: 'serpSearch',
    keyProvider: 'serper',
    cacheTtlMs: 0,
    freeQuota: { limit: SERPER_FREE_QUERIES, period: 'lifetime' },
    // SPEC §8.1: the Reddit (Serper) sub-cap is $0; never buy a pack automatically.
    maxPaidUsdPerMonth: 0,
    estimateUsd: () => SERPER_PAID_USD,
    async call(input, { apiKey }) {
      const res = await http(SERPER_URL, {
        method: 'POST',
        headers: { 'x-api-key': apiKey ?? '', 'content-type': 'application/json' },
        body: JSON.stringify({ q: input.q, gl: 'us', hl: 'en', tbs: 'qdr:d', page: 1 }),
        timeoutMs: 20_000,
      });
      if (res.status === 401 || res.status === 403)
        throw new ProviderAuthError('Serper rejected the API key');
      if (res.status === 400 || res.status === 402)
        throw new ProviderCallError(
          `Serper refused the query (${res.status}; credits used up?)`,
          null,
          false,
        );
      if (res.status !== 200) throw new ProviderCallError(`Serper HTTP ${res.status}`);
      return {
        value: parseSerperOrganic(await readJson(res, 5_000_000), Date.now()),
        usd: SERPER_PAID_USD,
        units: 1,
        confident: true,
      };
    },
  };
}

export const redditSource: PollingSource = {
  id: 'reddit',
  async poll(input: PollInput): Promise<PollOutput> {
    const { ctx } = input;
    const adapter = serperAdapter(ctx.http ?? defaultHttp);
    const groups: string[][] = [];
    for (let i = 0; i < input.phrases.length; i += REDDIT_PHRASES_PER_QUERY)
      groups.push(input.phrases.slice(i, i + REDDIT_PHRASES_PER_QUERY).map((p) => p.phrase));
    // Rotate through the groups when there are more than one day's queries.
    let rot =
      typeof input.cursor.rot === 'number' ? input.cursor.rot % Math.max(1, groups.length) : 0;
    const items: RawThread[] = [];
    let calls = 0;
    const n = Math.min(REDDIT_QUERIES_PER_DAY, groups.length);
    for (let i = 0; i < n; i++) {
      const group = groups[(rot + i) % groups.length]!;
      if (calls > 0) await input.sleep(300);
      const res = await callProvider(
        ctx,
        adapter,
        { q: redditQuery(group) },
        {
          workspaceId: input.workspaceId,
          stream: 'conversations',
          ...(input.jobId ? { jobId: input.jobId } : {}),
        },
      );
      calls++;
      if (res.status === 'ok') items.push(...res.value.map((t) => ({ ...t, postedAt: ctx.now() })));
    }
    rot = (rot + calls) % Math.max(1, groups.length);
    return { items, cursor: { rot }, done: true, calls };
  },
};
