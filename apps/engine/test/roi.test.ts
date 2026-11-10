import { describe, expect, it } from 'vitest';
import { needsCostConfirm } from '@le/shared';
import { costLedger, workspaces } from '../src/db/schema.ts';
import { newId } from '../src/ids.ts';
import { fakeLlm } from '../src/llm/fake.ts';
import { forecast } from '../src/api/routes/roi.ts';
import { makeCtx, setupClient } from './helpers.ts';

const NOW = Date.UTC(2026, 10, 11, 0); // 10 of 30 days into November
const DAY = 86_400_000;

async function seeded() {
  const c = await setupClient(makeCtx({}, () => NOW));
  const ws = (await c.get('/api/v1/workspace')).body.id as string;
  const acc = (
    await c.send('POST', '/api/v1/accounts', {
      domain: 'fastfreight.com',
      name: 'Fast Freight',
      country: 'US',
      state: 'TX',
      industry: 'Logistics',
      sizeRange: '51-200',
    })
  ).body.id as string;
  await c.send('POST', '/api/v1/accounts', {
    domain: 'bakery.com',
    name: 'Corner Bakery',
    country: 'US',
    state: 'CA',
    industry: 'Food',
    sizeRange: '1-10',
  });
  await c.send('POST', '/api/v1/accounts', {
    domain: 'haulers.com',
    name: 'Haulers',
    country: 'US',
    state: 'TX',
    industry: 'Logistics and trucking',
    sizeRange: '201-500',
  });
  const row = (over: Partial<typeof costLedger.$inferInsert>) =>
    c.ctx.db
      .insert(costLedger)
      .values({
        id: newId('cl'),
        workspaceId: ws,
        provider: 'icypeas',
        operation: 'email',
        units: 1,
        usd: 0.5,
        stream: 'personas',
        at: NOW - DAY,
        ...over,
      })
      .run();
  row({ entityType: 'account', entityId: acc });
  row({ usd: 0, entityType: 'account', entityId: acc }); // a miss
  row({ provider: 'ipapi', usd: 0, free: true, stream: 'visits' });
  row({ provider: 'claude-cli', usd: 2, stream: 'personas', estimated: true });
  row({ at: NOW - 40 * DAY }); // last month
  return { c, ws, acc };
}

describe('ROI and ledger', () => {
  it('forecasts linearly with at least one elapsed day', () => {
    expect(forecast(10, NOW)).toBeCloseTo(30);
    expect(forecast(1, Date.UTC(2026, 10, 1, 1))).toBeCloseTo(30);
  });

  it('GET /roi returns the budget forecast and stream sub-caps', async () => {
    const { c } = await seeded();
    const res = (await c.get('/api/v1/roi')).body;
    expect(res.budget.spentUsd).toBeCloseTo(2.5);
    expect(res.budget.forecastUsd).toBeCloseTo(7.5);
    const personas = res.streams.find((s: any) => s.key === 'personas');
    expect(personas).toMatchObject({ capShare: 0.6, capUsd: 30, enforced: false });
    expect(personas.spentUsd).toBeCloseTo(2.5);
    expect(res.streams.find((s: any) => s.key === 'llm').spentUsd).toBeCloseTo(2);
    expect(res.llmUsd).toBeCloseTo(2);
    expect(res.roi.map((r: any) => r.stream)).toContain('personas');
  });

  it('GET /ledger links rows to records and labels misses and free calls', async () => {
    const { c, acc } = await seeded();
    const res = (await c.get('/api/v1/ledger')).body;
    expect(res.rows).toHaveLength(5);
    expect(res.providers).toEqual(['claude-cli', 'icypeas', 'ipapi']);
    const linked = res.rows.filter((r: any) => r.entity?.id === acc);
    expect(linked.map((r: any) => r.charge).sort()).toEqual(['not_charged', 'paid']);
    expect(linked[0].entity).toMatchObject({ label: 'Fast Freight', href: `/accounts/${acc}` });
    expect(res.rows.find((r: any) => r.provider === 'ipapi').charge).toBe('free_quota');

    const filtered = (await c.get('/api/v1/ledger?provider=icypeas&since=' + (NOW - 5 * DAY))).body;
    expect(filtered.rows).toHaveLength(2);
    expect(filtered.totals.usd).toBeCloseTo(0.5);
  });

  it('ledger rows never resolve records of another workspace', async () => {
    const { c } = await seeded();
    c.ctx.db
      .insert(costLedger)
      .values({
        id: newId('cl'),
        workspaceId: (await c.get('/api/v1/workspace')).body.id,
        provider: 'icypeas',
        operation: 'email',
        units: 1,
        usd: 0.1,
        stream: 'personas',
        entityType: 'account',
        entityId: 'acc_elsewhere',
        at: NOW,
      })
      .run();
    const row = (await c.get('/api/v1/ledger')).body.rows[0];
    expect(row.entity).toEqual({
      type: 'account',
      id: 'acc_elsewhere',
      label: 'account (not found)',
      href: null,
    });
  });
});

describe('offer preview and draft estimate', () => {
  it('counts matching companies with a state breakdown and sample', async () => {
    const { c } = await seeded();
    const res = await c.send('POST', '/api/v1/offers/preview', {
      icp: { industries: ['Logistics'], employeeRange: '51-500', states: ['tx'] },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scanned: 3, matches: 2, threshold: 60 });
    expect(res.body.byState).toEqual([{ state: 'TX', count: 2 }]);
    expect(res.body.sample.sort()).toEqual(['Fast Freight', 'Haulers']);

    // Suppressed domains drop out of the preview.
    await c.send('POST', '/api/v1/suppressions', { kind: 'domain', value: 'haulers.com' });
    const after = await c.send('POST', '/api/v1/offers/preview', {
      icp: { industries: ['Logistics'], employeeRange: '51-500', states: ['TX'] },
    });
    expect(after.body.matches).toBe(1);
  });

  it('estimates a draft and asks for confirmation only when it is costly', async () => {
    const ctx = makeCtx({}, () => NOW);
    Object.assign(ctx, { llm: fakeLlm(() => ({})) });
    const c = await setupClient(ctx);
    const est = (await c.get('/api/v1/offers/draft-estimate')).body;
    expect(est.usd).toBeGreaterThan(0);
    expect(est.usd).toBeLessThan(0.1); // haiku
    expect(est.confirm).toBe(false);
    ctx.db.update(workspaces).set({ monthlyBudgetUsd: 0.05 }).run();
    expect((await c.get('/api/v1/offers/draft-estimate')).body.confirm).toBe(true);

    expect(needsCostConfirm(1.5, 100)).toBe(true);
    expect(needsCostConfirm(0.5, 4)).toBe(true);
    expect(needsCostConfirm(0.5, 10)).toBe(false);
  });
});
