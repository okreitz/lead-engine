import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { costLedger, jobs, workspaces } from '../src/db/schema.ts';
import { enqueue, JobRunner, PermanentJobError, resumeWaitingJobs } from '../src/jobs/queue.ts';
import { nextMonthStart } from '../src/providers/budget.ts';
import { fakeProvider } from '../src/providers/fake.ts';
import { callProvider } from '../src/providers/index.ts';
import { makeCtx } from './helpers.ts';

const T0 = Date.UTC(2026, 10, 9, 12);

function setup(budget = 1) {
  let now = T0;
  const ctx = makeCtx({}, () => now);
  ctx.db
    .insert(workspaces)
    .values({ id: 'ws_1', name: 'W', slug: 'w', monthlyBudgetUsd: budget, createdAt: T0 })
    .run();
  return { ctx, advance: (ms: number) => (now += ms) };
}

describe('job queue', () => {
  it('runs due jobs and stores the result', async () => {
    const { ctx } = setup();
    const id = enqueue(ctx.db, { workspaceId: 'ws_1', type: 'echo', payload: { x: 1 } }, T0);
    const runner = new JobRunner(ctx, { echo: async ({ job }) => job.payload });
    expect(await runner.tick()).toBe(1);
    expect(ctx.db.select().from(jobs).where(eq(jobs.id, id)).get()).toMatchObject({
      state: 'done',
      result: { x: 1 },
      attempts: 1,
    });
  });

  it('waits with the reason "budget reached" and resumes when the budget is raised', async () => {
    const { ctx } = setup(0.01);
    ctx.db
      .insert(costLedger)
      .values({
        id: 'l',
        workspaceId: 'ws_1',
        provider: 'x',
        operation: 'test',
        units: 1,
        usd: 0.01,
        stream: 'personas',
        at: T0,
      })
      .run();
    const p = fakeProvider();
    const runner = new JobRunner(ctx, {
      enrich: async ({ ctx: c }) =>
        callProvider(
          c,
          p,
          { fullName: 'J', domain: 'acme.com' },
          { workspaceId: 'ws_1', stream: 'personas' },
        ),
    });
    const id = enqueue(ctx.db, { workspaceId: 'ws_1', type: 'enrich', payload: {} }, T0);
    await runner.tick();
    let job = ctx.db.select().from(jobs).where(eq(jobs.id, id)).get()!;
    expect(job).toMatchObject({
      state: 'waiting',
      waitReason: 'budget reached',
      attempts: 0,
      runAt: nextMonthStart(T0),
    });
    expect(p.calls).toHaveLength(0);

    ctx.db.update(workspaces).set({ monthlyBudgetUsd: 5 }).run();
    resumeWaitingJobs(ctx.db, 'ws_1', T0);
    await runner.tick();
    job = ctx.db.select().from(jobs).where(eq(jobs.id, id)).get()!;
    expect(job.state).toBe('done');
    expect(p.calls).toHaveLength(1);
  });

  it('retries with backoff, then fails', async () => {
    const { ctx, advance } = setup();
    const id = enqueue(
      ctx.db,
      { workspaceId: 'ws_1', type: 'flaky', payload: {}, maxAttempts: 2 },
      T0,
    );
    const runner = new JobRunner(ctx, {
      flaky: async () => {
        throw new Error('network down, key sk-ant-abcdefghijklmnopqrst');
      },
    });
    await runner.tick();
    let job = ctx.db.select().from(jobs).where(eq(jobs.id, id)).get()!;
    expect(job).toMatchObject({ state: 'queued', attempts: 1 });
    expect(job.lastError).not.toContain('abcdefghijklmnop');
    expect(await runner.tick()).toBe(0); // not due yet
    advance(60_000);
    await runner.tick();
    job = ctx.db.select().from(jobs).where(eq(jobs.id, id)).get()!;
    expect(job).toMatchObject({ state: 'failed', attempts: 2 });
  });

  it('fails permanent errors at once', async () => {
    const { ctx } = setup();
    const id = enqueue(ctx.db, { workspaceId: 'ws_1', type: 'bad', payload: {} }, T0);
    await new JobRunner(ctx, {
      bad: async () => {
        throw new PermanentJobError('no');
      },
    }).tick();
    expect(ctx.db.select().from(jobs).where(eq(jobs.id, id)).get()!.state).toBe('failed');
  });

  it('requeues jobs left running by a crash', () => {
    const { ctx } = setup();
    const id = enqueue(ctx.db, { workspaceId: 'ws_1', type: 'x', payload: {} }, T0);
    ctx.db.update(jobs).set({ state: 'running' }).run();
    new JobRunner(ctx, {}).recover();
    expect(ctx.db.select().from(jobs).where(eq(jobs.id, id)).get()!.state).toBe('queued');
  });
});
