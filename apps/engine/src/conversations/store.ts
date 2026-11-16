/**
 * Stream 2 pipeline steps 1–2 (SPEC §5.3): prefilter, then dedupe by URL, then store as a
 * `pending` thread for LLM scoring. Plus retention (unactioned threads expire after 90 days)
 * and the per-workspace feedback examples the scorer uses as few-shot examples.
 */
import { THREAD_TTL_DAYS, type ThreadFeedback } from '@le/shared';
import { and, desc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.ts';
import { threads } from '../db/schema.ts';
import { newId } from '../ids.ts';
import { matchText, type CompiledPhrase } from './prefilter.ts';
import { excerptOf, normalizeThreadUrl, oneLine } from './text.ts';
import type { RawThread } from './types.ts';

const DAY = 86_400_000;
export const THREAD_TTL_MS = THREAD_TTL_DAYS * DAY;
/** Posts older than this are ignored even if a search returns them. */
export const MAX_POST_AGE_MS = 14 * DAY;

export interface IngestResult {
  seen: number;
  matched: number;
  inserted: number;
  ids: string[];
}

/** Prefilter → dedupe by URL → insert pending threads. Returns counts for the source status. */
export function ingestThreads(
  tx: Tx,
  workspaceId: string,
  compiled: CompiledPhrase[],
  items: RawThread[],
  now: number,
): IngestResult {
  const result: IngestResult = { seen: items.length, matched: 0, inserted: 0, ids: [] };
  const batch = new Set<string>();
  for (const item of items) {
    if (item.postedAt < now - MAX_POST_AGE_MS) continue;
    const url = normalizeThreadUrl(item.url);
    if (!url || batch.has(url)) continue;
    const match = matchText(compiled, `${item.title}\n${item.text}`);
    if (!match) continue;
    result.matched++;
    batch.add(url);
    const exists = tx
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.workspaceId, workspaceId), eq(threads.url, url)))
      .get();
    if (exists) continue;
    const id = newId('thr');
    tx.insert(threads)
      .values({
        id,
        workspaceId,
        source: item.source,
        externalId: item.externalId.slice(0, 300),
        url,
        title: oneLine(item.title, 300),
        excerpt: excerptOf(item.text),
        author: item.author ? oneLine(item.author, 80) : null,
        postedAt: Math.min(item.postedAt, now),
        matchedPhrase: match.phrase,
        phraseKind: match.kind,
        meta: item.meta ?? {},
        createdAt: now,
        updatedAt: now,
        expiresAt: Math.max(item.postedAt, now) + THREAD_TTL_MS,
      })
      .onConflictDoNothing()
      .run();
    result.inserted++;
    result.ids.push(id);
  }
  return result;
}

/**
 * Deletes unactioned threads past their expiry (SPEC §9: 90 days). Threads someone acted on
 * (replied, converted, or gave feedback) are kept: they are the CRM record and the scorer's
 * examples.
 */
export function purgeExpiredThreads(tx: Db, now: number): number {
  return tx
    .delete(threads)
    .where(
      and(
        lte(threads.expiresAt, now),
        inArray(threads.state, ['new', 'dismissed']),
        isNull(threads.feedback),
      ),
    )
    .run().changes;
}

/** Honours Bluesky deletion events: the post is removed from every workspace. */
export function deleteBySourceId(tx: Db, source: 'bluesky', externalId: string): number {
  return tx
    .delete(threads)
    .where(and(eq(threads.source, source), eq(threads.externalId, externalId)))
    .run().changes;
}

export interface FeedbackExample {
  verdict: ThreadFeedback;
  title: string;
  excerpt: string;
}

/** Most recent feedback of each kind, used as few-shot examples (SPEC §5.3). */
export function feedbackExamples(tx: Tx, workspaceId: string, perKind = 3): FeedbackExample[] {
  const out: FeedbackExample[] = [];
  for (const verdict of ['good', 'not_relevant'] as const) {
    const rows = tx
      .select({ title: threads.title, excerpt: threads.excerpt })
      .from(threads)
      .where(
        and(
          eq(threads.workspaceId, workspaceId),
          eq(threads.feedback, verdict),
          isNotNull(threads.feedbackAt),
        ),
      )
      .orderBy(desc(threads.feedbackAt))
      .limit(perKind)
      .all();
    for (const r of rows) out.push({ verdict, title: r.title, excerpt: r.excerpt.slice(0, 400) });
  }
  return out;
}

export function pendingCount(tx: Tx, workspaceId: string): number {
  return (
    tx
      .select({ n: sql<number>`count(*)` })
      .from(threads)
      .where(and(eq(threads.workspaceId, workspaceId), eq(threads.scoreStatus, 'pending')))
      .get()?.n ?? 0
  );
}
