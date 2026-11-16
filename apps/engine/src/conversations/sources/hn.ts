/**
 * Hacker News through the Algolia HN Search API (docs/providers.md "Hacker News", checked
 * 2026-11-16): `GET https://hn.algolia.com/api/v1/search_by_date`, no key, 10,000 requests per
 * hour per IP. One request per phrase every 15 minutes, `typoTolerance=false` (typo tolerance
 * turns "crm" into "com"), stories and comments created since the phrase's last poll.
 * Free and unmetered, so it does not go through the provider layer. Credit: "Hacker News
 * Search powered by Algolia" (shown in the inbox).
 */
import { USER_AGENT } from '../../crawler/crawler.ts';
import { defaultHttp, readJson } from '../../people/http.ts';
import { htmlToText, oneLine } from '../text.ts';
import type { PollInput, PollOutput, PollingSource, RawThread } from '../types.ts';

export const HN_URL = 'https://hn.algolia.com/api/v1/search_by_date';
export const HN_HITS_PER_PAGE = 100;
/** First poll of a phrase looks back this far. */
export const HN_FIRST_LOOKBACK_S = 24 * 3600;
const GAP_MS = 250;

interface HnHit {
  objectID?: unknown;
  title?: unknown;
  story_text?: unknown;
  comment_text?: unknown;
  story_title?: unknown;
  story_id?: unknown;
  author?: unknown;
  created_at_i?: unknown;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function hnSearchUrl(phrase: string, sinceUnix: number): string {
  const p = new URLSearchParams({
    query: phrase,
    tags: '(story,comment)',
    numericFilters: `created_at_i>${Math.floor(sinceUnix)}`,
    hitsPerPage: String(HN_HITS_PER_PAGE),
    typoTolerance: 'false',
  });
  return `${HN_URL}?${p.toString()}`;
}

/** Algolia hits → threads. Comments get "Re: <story title>" as their title. */
export function parseHnHits(json: unknown): RawThread[] {
  const hits = (json as { hits?: unknown })?.hits;
  if (!Array.isArray(hits)) return [];
  const out: RawThread[] = [];
  for (const h of hits as HnHit[]) {
    const id = str(h.objectID) || (typeof h.objectID === 'number' ? String(h.objectID) : '');
    const created = typeof h.created_at_i === 'number' ? h.created_at_i : NaN;
    if (!/^\d+$/.test(id) || !Number.isFinite(created)) continue;
    const isComment = typeof h.comment_text === 'string';
    const text = htmlToText(isComment ? str(h.comment_text) : str(h.story_text));
    const title = isComment
      ? `Re: ${oneLine(htmlToText(str(h.story_title)) || 'a Hacker News story', 280)}`
      : oneLine(htmlToText(str(h.title)), 300);
    if (!title && !text) continue;
    out.push({
      source: 'hn',
      externalId: id,
      url: `https://news.ycombinator.com/item?id=${id}`,
      title: title || '(untitled)',
      text,
      author: str(h.author) || null,
      postedAt: created * 1000,
      meta: {
        kind: isComment ? 'comment' : 'story',
        ...(typeof h.story_id === 'number' ? { storyId: h.story_id } : {}),
      },
    });
  }
  return out;
}

export const hnSource: PollingSource = {
  id: 'hn',
  async poll(input: PollInput): Promise<PollOutput> {
    const http = input.ctx.http ?? defaultHttp;
    const now = input.ctx.now();
    const since = { ...((input.cursor.since as Record<string, number> | undefined) ?? {}) };
    let index = typeof input.cursor.index === 'number' ? input.cursor.index : 0;
    const items: RawThread[] = [];
    let calls = 0;
    while (index < input.phrases.length) {
      if (calls > 0 && input.ctx.now() >= input.deadline) break;
      const phrase = input.phrases[index]!.phrase;
      const from = since[phrase] ?? Math.floor(now / 1000) - HN_FIRST_LOOKBACK_S;
      if (calls > 0) await input.sleep(GAP_MS);
      const res = await http(hnSearchUrl(phrase, from), {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        timeoutMs: 15_000,
      });
      calls++;
      if (res.status === 429) throw new Error('Hacker News search is rate limiting (429)');
      if (res.status !== 200) throw new Error(`Hacker News search HTTP ${res.status}`);
      const hits = parseHnHits(await readJson(res, 10_000_000));
      items.push(...hits);
      // Next time, only the last hour onwards: the overlap covers Algolia's indexing delay,
      // and the duplicates it returns are dropped by URL.
      since[phrase] = Math.max(from, Math.floor(now / 1000) - 3600);
      index++;
    }
    const done = index >= input.phrases.length;
    // Forget phrases that were removed from the offer.
    const keep = new Set(input.phrases.map((p) => p.phrase));
    for (const k of Object.keys(since)) if (!keep.has(k)) delete since[k];
    return { items, cursor: { since, index: done ? 0 : index }, done, calls };
  },
};
