/**
 * Stream 2 scheduling (SPEC §5.3 table): one `conversations.poll` job per polling source and
 * workspace when it is due, then a `conversations.score` job while threads wait for scoring.
 * Sources run only for workspaces with an approved offer (its intent phrases are the queries).
 */
import {
  DEFAULT_STACKEXCHANGE_SITES,
  THREAD_SOURCE_SCHEDULE,
  THREAD_SOURCES,
  type ThreadSource,
} from '@le/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../api/context.ts';
import type { Tx } from '../db/client.ts';
import { conversationSources, jobs, workspaces } from '../db/schema.ts';
import { ContinueJob, enqueue, PermanentJobError, type JobHandler } from '../jobs/queue.ts';
import { maskSecrets } from '../log-mask.ts';
import { approvedOffers } from '../offer/approved.ts';
import {
  BudgetExceededError,
  ProviderCallError,
  ProviderKeyMissingError,
} from '../providers/errors.ts';
import { compileOffers, unionPhrases } from './prefilter.ts';
import { githubSource } from './sources/github.ts';
import { hnSource } from './sources/hn.ts';
import { redditSource } from './sources/reddit.ts';
import { stackexchangeSource } from './sources/stackexchange.ts';
import { ingestThreads, pendingCount } from './store.ts';
import type { PollingSource } from './types.ts';

export const POLLING_SOURCES: Record<Exclude<ThreadSource, 'bluesky'>, PollingSource> = {
  hn: hnSource,
  stackexchange: stackexchangeSource,
  github: githubSource,
  reddit: redditSource,
};

const SLICE_MS = 20_000;
const WAIT_RETRY_MS = 60 * 60_000;

export type SourceRow = typeof conversationSources.$inferSelect;

export function sourceRow(
  tx: Tx,
  workspaceId: string,
  source: ThreadSource,
  now: number,
): SourceRow {
  const row = tx
    .select()
    .from(conversationSources)
    .where(
      and(eq(conversationSources.workspaceId, workspaceId), eq(conversationSources.source, source)),
    )
    .get();
  if (row) return row;
  tx.insert(conversationSources)
    .values({ workspaceId, source, updatedAt: now })
    .onConflictDoNothing()
    .run();
  return tx
    .select()
    .from(conversationSources)
    .where(
      and(eq(conversationSources.workspaceId, workspaceId), eq(conversationSources.source, source)),
    )
    .get()!;
}

export function updateSource(
  tx: Tx,
  workspaceId: string,
  source: ThreadSource,
  values: Partial<SourceRow>,
  now: number,
): void {
  sourceRow(tx, workspaceId, source, now);
  tx.update(conversationSources)
    .set({ ...values, updatedAt: now })
    .where(
      and(eq(conversationSources.workspaceId, workspaceId), eq(conversationSources.source, source)),
    )
    .run();
}

export function conversationSettings(tx: Tx, workspaceId: string) {
  const ws = tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  const c = ws?.settings.conversations ?? {};
  return {
    stackexchangeSites: c.stackexchangeSites?.length
      ? c.stackexchangeSites
      : [...DEFAULT_STACKEXCHANGE_SITES],
  };
}

function hasPendingJob(tx: Tx, workspaceId: string, type: string, source?: string): boolean {
  const conds = [
    eq(jobs.workspaceId, workspaceId),
    eq(jobs.type, type),
    inArray(jobs.state, ['queued', 'running', 'waiting']),
  ];
  if (source) conds.push(sql`json_extract(${jobs.payload}, '$.source') = ${source}`);
  return !!tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(...conds))
    .get();
}

/** Queues the scoring job when threads are waiting and none is queued. */
export function ensureScoreJob(ctx: AppContext, workspaceId: string): boolean {
  if (pendingCount(ctx.db, workspaceId) === 0) return false;
  if (hasPendingJob(ctx.db, workspaceId, 'conversations.score')) return false;
  enqueue(ctx.db, { workspaceId, type: 'conversations.score', payload: {} }, ctx.now());
  return true;
}

/** Queues a poll now (the "Run now" button), unless one is already pending. */
export function queuePoll(ctx: AppContext, workspaceId: string, source: ThreadSource): boolean {
  if (source === 'bluesky') return false;
  if (hasPendingJob(ctx.db, workspaceId, 'conversations.poll', source)) return false;
  enqueue(ctx.db, { workspaceId, type: 'conversations.poll', payload: { source } }, ctx.now());
  return true;
}

/**
 * Runs every minute: for each workspace with an approved offer, queues due polls and the
 * scoring job. Returns the number of jobs queued.
 */
export function scheduleConversations(ctx: AppContext): number {
  const now = ctx.now();
  let queued = 0;
  for (const ws of ctx.db.select({ id: workspaces.id }).from(workspaces).all()) {
    if (!approvedOffers(ctx.db, ws.id).length) continue;
    for (const source of THREAD_SOURCES) {
      if (source === 'bluesky') continue;
      const row = sourceRow(ctx.db, ws.id, source, now);
      if (!row.enabled) continue;
      if (row.nextRunAt !== null && row.nextRunAt > now) continue;
      if (queuePoll(ctx, ws.id, source)) queued++;
    }
    if (ensureScoreJob(ctx, ws.id)) queued++;
  }
  return queued;
}

/** `conversations.poll` {source}: one source for one workspace, in ~20 s slices. */
export function conversationPollHandler(): JobHandler {
  return async ({ ctx, job }) => {
    const source = job.payload.source as ThreadSource;
    const adapter = POLLING_SOURCES[source as Exclude<ThreadSource, 'bluesky'>];
    if (!adapter) throw new PermanentJobError(`unknown source ${String(source)}`);
    const offers = approvedOffers(ctx.db, job.workspaceId);
    if (!offers.length) throw new PermanentJobError('no approved offer profile');
    const now = ctx.now();
    const row = sourceRow(ctx.db, job.workspaceId, source, now);
    if (!row.enabled) return { skipped: 'disabled' };
    const every = THREAD_SOURCE_SCHEDULE[source].everyMs ?? 3600_000;
    const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const progress = (job.result ?? {}) as { found?: number; inserted?: number };
    try {
      const out = await adapter.poll({
        ctx,
        workspaceId: job.workspaceId,
        phrases: unionPhrases(offers),
        cursor: row.cursor,
        jobId: job.id,
        deadline: now + SLICE_MS,
        sleep,
        settings: conversationSettings(ctx.db, job.workspaceId),
      });
      const compiled = compileOffers(offers);
      const ingest = ctx.db.transaction((tx) =>
        ingestThreads(tx, job.workspaceId, compiled, out.items, ctx.now()),
      );
      const found = (progress.found ?? 0) + ingest.seen;
      const inserted = (progress.inserted ?? 0) + ingest.inserted;
      updateSource(
        ctx.db,
        job.workspaceId,
        source,
        out.done
          ? {
              cursor: out.cursor,
              lastRunAt: ctx.now(),
              nextRunAt: now + every,
              lastStatus: 'ok',
              lastError: null,
              lastFound: found,
              lastNew: inserted,
            }
          : { cursor: out.cursor },
        ctx.now(),
      );
      ensureScoreJob(ctx, job.workspaceId);
      if (!out.done) return new ContinueJob(1_000, { found, inserted });
      return { found, inserted };
    } catch (err) {
      // Source trouble is shown on the source, and the source tries again later; it never
      // blocks the queue or the other sources.
      const message = maskSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300);
      const waiting = err instanceof BudgetExceededError || err instanceof ProviderKeyMissingError;
      const permanent = err instanceof ProviderCallError && !err.retryable;
      updateSource(
        ctx.db,
        job.workspaceId,
        source,
        {
          lastRunAt: ctx.now(),
          nextRunAt: now + (waiting || permanent ? Math.max(every, WAIT_RETRY_MS) : every),
          lastStatus: waiting ? 'waiting' : 'error',
          lastError: message,
        },
        ctx.now(),
      );
      return { error: message };
    }
  };
}
