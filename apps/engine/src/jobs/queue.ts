/**
 * SQLite-backed job queue (SPEC §2): retries with exponential backoff, and budget waits.
 * A job whose provider call hits the budget moves to `waiting` with the reason shown in the
 * UI; it resumes at the next budget month, or as soon as the budget is raised.
 */
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import type { AppContext } from '../api/context.ts';
import type { Db } from '../db/client.ts';
import { jobs } from '../db/schema.ts';
import { newId } from '../ids.ts';
import { maskSecrets } from '../log-mask.ts';
import { nextMonthStart } from '../providers/budget.ts';
import { BudgetExceededError, ProviderKeyMissingError } from '../providers/errors.ts';

export type JobRow = typeof jobs.$inferSelect;

export interface JobContext {
  ctx: AppContext;
  job: JobRow;
}

export type JobHandler = (job: JobContext) => Promise<unknown>;

/** Thrown by a handler for errors that retrying can't fix. */
export class PermanentJobError extends Error {
  override name = 'PermanentJobError';
}

export function enqueue(
  db: Db,
  input: {
    workspaceId: string;
    type: string;
    payload: Record<string, unknown>;
    runAt?: number;
    maxAttempts?: number;
  },
  now: number,
): string {
  const id = newId('job');
  db.insert(jobs)
    .values({
      id,
      workspaceId: input.workspaceId,
      type: input.type,
      payload: input.payload,
      state: 'queued',
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      runAt: input.runAt ?? now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

/** Called when a workspace's budget or keys change: waiting jobs become due now. */
export function resumeWaitingJobs(db: Db, workspaceId: string, now: number): void {
  db.update(jobs)
    .set({ state: 'queued', runAt: now, waitReason: null, updatedAt: now })
    .where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.state, 'waiting')))
    .run();
}

export const BACKOFF_BASE_MS = 30_000;

export class JobRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly handlers: Record<string, JobHandler>,
  ) {}

  /** Requeue jobs left `running` by a crash. */
  recover(): void {
    this.ctx.db
      .update(jobs)
      .set({ state: 'queued', updatedAt: this.ctx.now() })
      .where(eq(jobs.state, 'running'))
      .run();
  }

  start(intervalMs = 2_000): void {
    this.recover();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs every due job once, one at a time. Returns how many ran. */
  async tick(limit = 10): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const now = this.ctx.now();
      const due = this.ctx.db
        .select()
        .from(jobs)
        .where(and(inArray(jobs.state, ['queued', 'waiting']), lte(jobs.runAt, now)))
        .orderBy(asc(jobs.runAt))
        .limit(limit)
        .all();
      for (const job of due) await this.runOne(job);
      return due.length;
    } finally {
      this.running = false;
    }
  }

  private async runOne(job: JobRow): Promise<void> {
    const { db } = this.ctx;
    const handler = this.handlers[job.type];
    const set = (values: Partial<JobRow>) =>
      db
        .update(jobs)
        .set({ ...values, updatedAt: this.ctx.now() })
        .where(eq(jobs.id, job.id))
        .run();
    if (!handler) {
      set({ state: 'failed', lastError: `no handler for job type ${job.type}` });
      return;
    }
    const attempts = job.attempts + 1;
    set({ state: 'running', attempts, waitReason: null });
    try {
      const result = await handler({ ctx: this.ctx, job: { ...job, attempts } });
      set({ state: 'done', result: result ?? null, lastError: null });
    } catch (err) {
      const now = this.ctx.now();
      if (err instanceof BudgetExceededError) {
        // Not the job's fault: don't count the attempt, wait for the next budget month.
        set({
          state: 'waiting',
          attempts: job.attempts,
          waitReason: err.reason,
          runAt: nextMonthStart(now),
        });
        return;
      }
      const message = maskSecrets(err instanceof Error ? err.message : String(err)).slice(0, 500);
      if (err instanceof ProviderKeyMissingError) {
        set({
          state: 'waiting',
          attempts: job.attempts,
          waitReason: message,
          runAt: now + 3600_000,
        });
        return;
      }
      if (err instanceof PermanentJobError || attempts >= job.maxAttempts) {
        set({ state: 'failed', lastError: message });
        return;
      }
      set({
        state: 'queued',
        lastError: message,
        runAt: now + BACKOFF_BASE_MS * 2 ** (attempts - 1),
      });
    }
  }
}
