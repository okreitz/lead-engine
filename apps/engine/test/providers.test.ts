import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { AppContext } from '../src/api/context.ts';
import { costLedger, fieldSources, suppressions, workspaces } from '../src/db/schema.ts';
import { budgetStatus, monthStart } from '../src/providers/budget.ts';
import { fakeProvider } from '../src/providers/fake.ts';
import {
  BudgetExceededError,
  callProvider,
  ProviderCallError,
  runWaterfall,
} from '../src/providers/index.ts';
import { stripLinkedIn } from '../src/providers/sanitize.ts';
import { makeCtx } from './helpers.ts';

const T0 = Date.UTC(2026, 10, 9, 12);

function workspace(ctx: AppContext, budget = 50, settings = {}): string {
  ctx.db
    .insert(workspaces)
    .values({ id: 'ws_1', name: 'W', slug: 'w', monthlyBudgetUsd: budget, settings, createdAt: T0 })
    .run();
  return 'ws_1';
}

function spend(ctx: AppContext, usd: number, at = T0, provider = 'other', stream = 'personas') {
  ctx.db
    .insert(costLedger)
    .values({
      id: `led_${Math.random()}`,
      workspaceId: 'ws_1',
      provider,
      operation: 'test',
      units: 1,
      usd,
      stream,
      at,
    })
    .run();
}

const opts = { workspaceId: 'ws_1', stream: 'personas' as const };
const input = { fullName: 'Jane Doe', domain: 'acme.com' };

describe('provider pipeline', () => {
  it('calls, meters and caches', async () => {
    const ctx = makeCtx({}, () => T0);
    workspace(ctx);
    const p = fakeProvider({ costUsd: 0.02 });
    const first = await callProvider(ctx, p, input, opts);
    const second = await callProvider(ctx, p, input, opts);
    expect(first).toMatchObject({ status: 'ok', cached: false, usd: 0.02 });
    expect(second).toMatchObject({ status: 'ok', cached: true, usd: 0 });
    expect(p.calls).toHaveLength(1);
    const ledger = ctx.db.select().from(costLedger).all();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      provider: 'fake',
      usd: 0.02,
      stream: 'personas',
      free: false,
    });
  });

  it('keeps caches per workspace', async () => {
    const ctx = makeCtx({}, () => T0);
    workspace(ctx);
    ctx.db.insert(workspaces).values({ id: 'ws_2', name: 'W2', slug: 'w2', createdAt: T0 }).run();
    const p = fakeProvider();
    await callProvider(ctx, p, input, opts);
    await callProvider(ctx, p, input, { ...opts, workspaceId: 'ws_2' });
    expect(p.calls).toHaveLength(2);
  });

  it('checks suppression before anything else, globally and per workspace', async () => {
    const ctx = makeCtx({}, () => T0);
    workspace(ctx);
    ctx.db
      .insert(suppressions)
      .values({
        id: 's1',
        workspaceId: null,
        kind: 'domain',
        value: 'acme.com',
        reason: 'opt-out',
        createdAt: T0,
      })
      .run();
    const p = fakeProvider();
    const res = await callProvider(ctx, p, { fullName: 'X', domain: 'mail.acme.com' }, opts);
    expect(res.status).toBe('suppressed');
    expect(p.calls).toHaveLength(0);
    expect(ctx.db.select().from(costLedger).all()).toHaveLength(0);

    ctx.db
      .insert(suppressions)
      .values({
        id: 's2',
        workspaceId: 'ws_1',
        kind: 'email',
        value: 'bob@globex.com',
        reason: 'asked',
        createdAt: T0,
      })
      .run();
    const byEmail = fakeProvider({ subjects: () => ({ emails: ['Bob@Globex.com'] }) });
    expect((await callProvider(ctx, byEmail, input, opts)).status).toBe('suppressed');
  });

  it('writes FieldSource rows for the target entity', async () => {
    const ctx = makeCtx({}, () => T0);
    workspace(ctx);
    const p = fakeProvider({
      respond: () => ({
        value: { email: 'jane@acme.com', status: 'verified' },
        provenance: [{ field: 'email', url: 'https://acme.com/team', confidence: 0.99 }],
      }),
    });
    await callProvider(ctx, p, input, {
      ...opts,
      target: { entity: 'contact', entityId: 'con_1' },
    });
    const rows = ctx.db.select().from(fieldSources).all();
    expect(rows).toEqual([
      expect.objectContaining({
        entity: 'contact',
        entityId: 'con_1',
        field: 'email',
        source: 'fake',
        confidence: 0.99,
      }),
    ]);
  });

  it('meters failed calls that still cost money', async () => {
    const ctx = makeCtx({}, () => T0);
    workspace(ctx);
    const p = fakeProvider({
      respond: () => {
        throw new ProviderCallError('boom', { usd: 0.01, units: 10 });
      },
    });
    await expect(callProvider(ctx, p, input, opts)).rejects.toThrow('boom');
    expect(ctx.db.select().from(costLedger).all()[0]).toMatchObject({ usd: 0.01 });
  });

  it('drops LinkedIn-derived fields before the result is cached or returned', async () => {
    const ctx = makeCtx({}, () => T0);
    workspace(ctx);
    const p = fakeProvider<typeof input, Record<string, unknown>>({
      respond: () => ({
        value: {
          email: 'jane@acme.com',
          linkedin_url: 'https://www.linkedin.com/in/jane',
          profile: {
            salesNavigatorId: 'abc',
            site: 'https://acme.com',
            other: 'https://linkedin.com/x',
          },
        },
      }),
    });
    const res = await callProvider(ctx, p, input, opts);
    expect(res.status === 'ok' && res.value).toEqual({
      email: 'jane@acme.com',
      profile: { site: 'https://acme.com' },
    });
    const cached = await callProvider(ctx, p, input, opts);
    expect(JSON.stringify(cached)).not.toMatch(/linkedin/i);
  });
});

describe('budget', () => {
  it('warns at 80% and stops at 100%', async () => {
    const ctx = makeCtx({}, () => T0);
    workspace(ctx, 10);
    spend(ctx, 7.9);
    expect(budgetStatus(ctx.db, 'ws_1', T0).state).toBe('ok');
    spend(ctx, 0.1);
    expect(budgetStatus(ctx.db, 'ws_1', T0).state).toBe('warning');
    spend(ctx, 2);
    expect(budgetStatus(ctx.db, 'ws_1', T0).state).toBe('reached');
    const p = fakeProvider();
    await expect(callProvider(ctx, p, input, opts)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(p.calls).toHaveLength(0);
  });

  it('refuses a call whose estimate would overshoot the budget', async () => {
    const ctx = makeCtx({}, () => T0);
    workspace(ctx, 1);
    spend(ctx, 0.95);
    const p = fakeProvider({ estimateUsd: 0.1 });
    await expect(callProvider(ctx, p, input, opts)).rejects.toThrow('budget reached');
  });

  it('only counts the current calendar month', () => {
    const ctx = makeCtx({}, () => T0);
    workspace(ctx, 10);
    spend(ctx, 50, monthStart(T0) - 1);
    expect(budgetStatus(ctx.db, 'ws_1', T0)).toMatchObject({ spentUsd: 0, state: 'ok' });
  });

  it('uses the free quota first, then paid calls; a $0 provider cap stops at the quota', async () => {
    const ctx = makeCtx({}, () => T0);
    workspace(ctx);
    const serper = fakeProvider({
      provider: 'serper',
      costUsd: 0.001,
      cacheTtlMs: 0,
      freeQuota: { limit: 2, period: 'lifetime' },
      maxPaidUsdPerMonth: 0,
    });
    await callProvider(ctx, serper, { ...input, fullName: 'a' }, opts);
    await callProvider(ctx, serper, { ...input, fullName: 'b' }, opts);
    const ledger = ctx.db.select().from(costLedger).all();
    expect(ledger.every((l) => l.free && l.usd === 0)).toBe(true);
    await expect(callProvider(ctx, serper, { ...input, fullName: 'c' }, opts)).rejects.toThrow(
      /free quota used up/,
    );
    expect(serper.calls).toHaveLength(2);
  });

  it('enforces optional sub-caps per stream and for the LLM', async () => {
    const ctx = makeCtx({}, () => T0);
    workspace(ctx, 10, { enforceSubCaps: true, subCaps: { conversations: 0.2 } });
    spend(ctx, 1.99, T0, 'serper', 'conversations');
    const p = fakeProvider({ estimateUsd: 0.02 });
    await expect(callProvider(ctx, p, input, { ...opts, stream: 'conversations' })).rejects.toThrow(
      'conversations sub-cap reached',
    );
    spend(ctx, 0.99, T0, 'anthropic-api', 'personas');
    const llm = fakeProvider({ provider: 'anthropic-api', estimateUsd: 0.02 });
    await expect(callProvider(ctx, llm, input, opts)).rejects.toThrow('LLM sub-cap reached');
  });

  it('does not enforce sub-caps by default', async () => {
    const ctx = makeCtx({}, () => T0);
    workspace(ctx, 10);
    spend(ctx, 5, T0, 'serper', 'conversations');
    const p = fakeProvider();
    expect((await callProvider(ctx, p, input, { ...opts, stream: 'conversations' })).status).toBe(
      'ok',
    );
  });
});

describe('waterfall', () => {
  it('stops at the first confident result, cheapest first', async () => {
    const ctx = makeCtx({}, () => T0);
    workspace(ctx);
    const pattern = fakeProvider({
      provider: 'pattern',
      costUsd: 0,
      respond: () => ({ value: { email: 'j@acme.com', status: 'catch_all' }, confident: false }),
    });
    const finder = fakeProvider({
      provider: 'finder',
      costUsd: 0.02,
      respond: () => ({ value: { email: 'jane@acme.com', status: 'verified' } }),
    });
    const expensive = fakeProvider({ provider: 'expensive', costUsd: 0.5 });
    const res = await runWaterfall(ctx, [pattern, finder, expensive], input, opts);
    expect(res).toMatchObject({
      status: 'ok',
      provider: 'finder',
      confident: true,
      tried: ['pattern', 'finder'],
    });
    expect(expensive.calls).toHaveLength(0);
  });

  it('falls back to the first non-confident result', async () => {
    const ctx = makeCtx({}, () => T0);
    workspace(ctx);
    type Out = { email: string | null; status: string };
    const a = fakeProvider<typeof input, Out>({
      provider: 'a',
      respond: () => ({ value: { email: 'x@acme.com', status: 'risky' }, confident: false }),
    });
    const b = fakeProvider<typeof input, Out>({
      provider: 'b',
      respond: () => ({ value: { email: null, status: 'not_found' }, confident: false }),
    });
    const res = await runWaterfall(ctx, [a, b], input, opts);
    expect(res).toMatchObject({ status: 'ok', provider: 'a', confident: false });
  });

  it('skips steps without a key and steps with permanent errors', async () => {
    const ctx = makeCtx({}, () => T0);
    workspace(ctx);
    const keyed = fakeProvider({ provider: 'icypeas', keyProvider: 'icypeas' });
    const broken = fakeProvider({
      provider: 'broken',
      respond: () => {
        throw new ProviderCallError('bad input', null, false);
      },
    });
    const ok = fakeProvider({ provider: 'ok' });
    const res = await runWaterfall(ctx, [keyed, broken, ok], input, opts);
    expect(res).toMatchObject({ status: 'ok', provider: 'ok', tried: ['broken', 'ok'] });
  });

  it('stops on suppression and propagates budget stops', async () => {
    const ctx = makeCtx({}, () => T0);
    workspace(ctx, 0.01);
    ctx.db
      .insert(suppressions)
      .values({
        id: 's',
        workspaceId: 'ws_1',
        kind: 'domain',
        value: 'acme.com',
        reason: 'x',
        createdAt: T0,
      })
      .run();
    const a = fakeProvider({ provider: 'a' });
    expect((await runWaterfall(ctx, [a], input, opts)).status).toBe('suppressed');
    await expect(
      runWaterfall(ctx, [a], { ...input, domain: 'globex.com' }, opts),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });
});

describe('stripLinkedIn', () => {
  it('removes LinkedIn keys and values at any depth and keeps the rest', () => {
    expect(
      stripLinkedIn({
        name: 'Jane',
        linkedinUrl: 'x',
        li_profile: 'y',
        links: ['https://acme.com', 'https://de.linkedin.com/in/jane', 'lnkd.in/abc'],
        nested: [{ sales_nav_id: 1, title: 'CEO' }],
        clientId: 'keep',
      }),
    ).toEqual({
      name: 'Jane',
      links: ['https://acme.com'],
      nested: [{ title: 'CEO' }],
      clientId: 'keep',
    });
  });
});

describe('budget API', () => {
  it('reports spend, state and waiting jobs', async () => {
    const { setupClient } = await import('./helpers.ts');
    const c = await setupClient(makeCtx({}, () => T0));
    const ws = c.ctx.db.select().from(workspaces).get()!;
    c.ctx.db.update(workspaces).set({ monthlyBudgetUsd: 10 }).where(eq(workspaces.id, ws.id)).run();
    c.ctx.db
      .insert(costLedger)
      .values({
        id: 'l',
        workspaceId: ws.id,
        provider: 'icypeas',
        operation: 'findEmail',
        units: 1,
        usd: 8.5,
        stream: 'personas',
        at: T0,
      })
      .run();
    const res = await c.get('/api/v1/budget');
    expect(res.body).toMatchObject({
      budgetUsd: 10,
      spentUsd: 8.5,
      state: 'warning',
      waitingJobs: [],
    });
  });
});
