/**
 * Stack Exchange questions (docs/providers.md "Stack Exchange API", checked 2026-11-16):
 * `GET https://api.stackexchange.com/2.3/search/advanced` with the workspace's API key as the
 * `key` query parameter (Stack Apps "API Authentication (2025)"). With a key the quota is
 * 10,000 requests/day per IP; `backoff` must be honoured per method. The call goes through the
 * provider layer: counted against the free daily quota, paid calls capped at $0.
 *
 * Phrase × site pairs rotate, at most `SE_CALLS_PER_RUN` per hourly run, each from the pair's
 * last poll. Content is CC BY-SA 4.0: the inbox links to the question and names the author.
 */
import { USER_AGENT } from '../../crawler/crawler.ts';
import { defaultHttp, readJson, type HttpFetch } from '../../people/http.ts';
import { callProvider, ProviderAuthError, ProviderCallError } from '../../providers/index.ts';
import type { ProviderAdapter } from '../../providers/types.ts';
import { htmlToText, oneLine } from '../text.ts';
import type { PollInput, PollOutput, PollingSource, RawThread } from '../types.ts';

export const SE_URL = 'https://api.stackexchange.com/2.3/search/advanced';
export const SE_FREE_PER_DAY = 10_000;
export const SE_CALLS_PER_RUN = 24;
export const SE_PAGE_SIZE = 50;
/** Stop for the day when fewer requests than this are left. */
export const SE_QUOTA_FLOOR = 50;
const FIRST_LOOKBACK_S = 3 * 24 * 3600;

export interface SeSearchInput {
  q: string;
  site: string;
  fromdate: number;
}

export interface SeSearchOutput {
  items: RawThread[];
  quotaRemaining: number | null;
  /** Seconds to wait before calling this method again (only when the API sets it). */
  backoff: number | null;
}

interface SeItem {
  question_id?: unknown;
  title?: unknown;
  body?: unknown;
  link?: unknown;
  creation_date?: unknown;
  tags?: unknown;
  owner?: { display_name?: unknown };
  content_license?: unknown;
}

export function parseSeItems(json: unknown, site: string): RawThread[] {
  const items = (json as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const out: RawThread[] = [];
  for (const it of items as SeItem[]) {
    const id = typeof it.question_id === 'number' ? it.question_id : null;
    const created = typeof it.creation_date === 'number' ? it.creation_date : null;
    const link = typeof it.link === 'string' ? it.link : null;
    if (!id || !created || !link?.startsWith('https://')) continue;
    out.push({
      source: 'stackexchange',
      externalId: `${site}:${id}`,
      url: link,
      title: oneLine(htmlToText(typeof it.title === 'string' ? it.title : ''), 300) || '(untitled)',
      text: htmlToText(typeof it.body === 'string' ? it.body : ''),
      author: typeof it.owner?.display_name === 'string' ? htmlToText(it.owner.display_name) : null,
      postedAt: created * 1000,
      meta: {
        site,
        tags: Array.isArray(it.tags)
          ? it.tags.filter((t) => typeof t === 'string').slice(0, 6)
          : [],
        license: typeof it.content_license === 'string' ? it.content_license : 'CC BY-SA 4.0',
      },
    });
  }
  return out;
}

export function seSearchUrl(input: SeSearchInput, key: string | null): string {
  const p = new URLSearchParams({
    q: input.q,
    site: input.site,
    fromdate: String(Math.floor(input.fromdate)),
    sort: 'creation',
    order: 'desc',
    pagesize: String(SE_PAGE_SIZE),
    filter: 'withbody',
  });
  if (key) p.set('key', key);
  return `${SE_URL}?${p.toString()}`;
}

export function stackexchangeAdapter(
  http: HttpFetch,
): ProviderAdapter<SeSearchInput, SeSearchOutput> {
  return {
    provider: 'stackexchange',
    operation: 'threadSearch',
    keyProvider: 'stackexchange',
    cacheTtlMs: 0,
    freeQuota: { limit: SE_FREE_PER_DAY, period: 'day' },
    // Free API: never paid. Past the daily quota the call is refused until tomorrow.
    maxPaidUsdPerMonth: 0,
    estimateUsd: () => 0.0001,
    async call(input, { apiKey }) {
      const res = await http(seSearchUrl(input, apiKey), {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        timeoutMs: 20_000,
      });
      const json = (await readJson(res, 10_000_000)) as Record<string, unknown> | null;
      const errorName = typeof json?.error_name === 'string' ? json.error_name : null;
      if (errorName === 'bad_parameter' && /key/i.test(String(json?.error_message ?? ''))) {
        throw new ProviderAuthError('Stack Exchange rejected the API key');
      }
      if (
        errorName === 'access_denied' ||
        errorName === 'invalid_access_token' ||
        res.status === 401
      ) {
        throw new ProviderAuthError('Stack Exchange refused the key');
      }
      if (errorName === 'throttle_violation') {
        throw new ProviderCallError(
          'Stack Exchange throttle violation: quota or rate exceeded',
          null,
          false,
        );
      }
      if (res.status !== 200 || !json || errorName) {
        throw new ProviderCallError(
          `Stack Exchange HTTP ${res.status}${errorName ? ` ${errorName}` : ''}`,
        );
      }
      return {
        value: {
          items: parseSeItems(json, input.site),
          quotaRemaining: typeof json.quota_remaining === 'number' ? json.quota_remaining : null,
          backoff: typeof json.backoff === 'number' ? json.backoff : null,
        },
        usd: 0,
        units: 1,
        confident: true,
        meta: { site: input.site },
      };
    },
  };
}

export const stackexchangeSource: PollingSource = {
  id: 'stackexchange',
  async poll(input: PollInput): Promise<PollOutput> {
    const { ctx } = input;
    const adapter = stackexchangeAdapter(ctx.http ?? defaultHttp);
    const now = ctx.now();
    const nowS = Math.floor(now / 1000);
    const sites = input.settings.stackexchangeSites;
    const pairs = sites.flatMap((site) => input.phrases.map((p) => ({ site, q: p.phrase })));
    const since = { ...((input.cursor.since as Record<string, number> | undefined) ?? {}) };
    const backoffUntil =
      typeof input.cursor.backoffUntil === 'number' ? input.cursor.backoffUntil : 0;
    let rot = typeof input.cursor.rot === 'number' ? input.cursor.rot : 0;
    const items: RawThread[] = [];
    let calls = 0;
    let nextBackoff = 0;
    if (backoffUntil > now || !pairs.length) {
      return { items, cursor: input.cursor, done: true, calls };
    }
    const n = Math.min(SE_CALLS_PER_RUN, pairs.length);
    for (let i = 0; i < n; i++) {
      const pair = pairs[(rot + i) % pairs.length]!;
      const key = `${pair.site}|${pair.q}`;
      const fromdate = since[key] ?? nowS - FIRST_LOOKBACK_S;
      if (calls > 0) await input.sleep(150);
      const res = await callProvider(
        ctx,
        adapter,
        { q: pair.q, site: pair.site, fromdate },
        {
          workspaceId: input.workspaceId,
          stream: 'conversations',
          ...(input.jobId ? { jobId: input.jobId } : {}),
        },
      );
      calls++;
      if (res.status !== 'ok') continue;
      items.push(...res.value.items);
      since[key] = Math.max(fromdate, nowS - 3600);
      if (res.value.backoff) {
        nextBackoff = now + res.value.backoff * 1000;
        break;
      }
      if (res.value.quotaRemaining !== null && res.value.quotaRemaining < SE_QUOTA_FLOOR) {
        // The quota is per IP and shared by every workspace on this server: stop until it
        // resets (Stack Exchange resets it daily, UTC).
        nextBackoff = Date.UTC(
          new Date(now).getUTCFullYear(),
          new Date(now).getUTCMonth(),
          new Date(now).getUTCDate() + 1,
        );
        break;
      }
    }
    rot = (rot + calls) % Math.max(1, pairs.length);
    const keep = new Set(pairs.map((p) => `${p.site}|${p.q}`));
    for (const k of Object.keys(since)) if (!keep.has(k)) delete since[k];
    return {
      items,
      cursor: { since, rot, ...(nextBackoff ? { backoffUntil: nextBackoff } : {}) },
      done: true,
      calls,
    };
  },
};
