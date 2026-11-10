import { describe, expect, it } from 'vitest';
import { activities, costLedger, deals } from '../src/db/schema.ts';
import { weekStart } from '../src/api/routes/summary.ts';
import { makeCtx, setupClient } from './helpers.ts';

const NOW = Date.UTC(2026, 10, 11, 15); // Wednesday

describe('GET /api/v1/summary', () => {
  it('works with a read-only token and reports week, top accounts, spend and ROI', async () => {
    const c = await setupClient(makeCtx({}, () => NOW));
    const acme = await c.send('POST', '/api/v1/accounts', {
      domain: 'acme.com',
      name: 'Acme',
      country: 'US',
    });
    await c.send('POST', '/api/v1/accounts', {
      domain: 'globex.com',
      name: 'Globex',
      country: 'US',
    });
    await c.send('POST', '/api/v1/suppressions', { kind: 'domain', value: 'globex.com' });
    await c.send('PATCH', `/api/v1/accounts/${acme.body.id}/stage`, { stage: 'Meeting' });
    const ws = (await c.get('/api/v1/workspace')).body.id;
    c.ctx.db
      .insert(costLedger)
      .values({
        id: 'l1',
        workspaceId: ws,
        provider: 'icypeas',
        operation: 'findEmail',
        units: 1,
        usd: 1.5,
        stream: 'manual',
        at: NOW,
      })
      .run();
    c.ctx.db
      .insert(activities)
      .values({
        id: 'a1',
        workspaceId: ws,
        accountId: acme.body.id,
        kind: 'meeting',
        body: 'Demo',
        at: NOW,
      })
      .run();
    c.ctx.db
      .insert(deals)
      .values({
        id: 'd1',
        workspaceId: ws,
        accountId: acme.body.id,
        name: 'Pilot',
        stage: 'Won',
        valueUsd: 9000,
        outcome: 'won',
        closedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();

    const token = (
      await c.send('POST', '/api/v1/tokens', { name: 'Ground Control', scope: 'read' })
    ).body.token;
    const res = await c.app.inject({
      method: 'GET',
      url: '/api/v1/summary',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.newAccountsThisWeek).toBe(1); // globex is suppressed
    expect(s.newThreadsThisWeek).toBe(0);
    expect(s.top.map((a: any) => a.domain)).toEqual(['acme.com']);
    expect(s.spend).toMatchObject({ budgetUsd: 50, spentUsd: 1.5, state: 'ok' });
    const manual = s.roi.find((r: any) => r.stream === 'manual');
    expect(manual).toMatchObject({
      spendUsd: 1.5,
      accounts: 1,
      meetings: 1,
      dealsWon: 1,
      wonValueUsd: 9000,
      costPerMeetingUsd: 1.5,
    });
    expect(s.roi.map((r: any) => r.stream)).toEqual([
      'personas',
      'visits',
      'conversations',
      'manual',
    ]);
  });

  it('rejects unauthenticated calls', async () => {
    const c = await setupClient();
    expect((await c.app.inject({ method: 'GET', url: '/api/v1/summary' })).statusCode).toBe(401);
  });

  it('weeks start on Monday (UTC)', () => {
    expect(new Date(weekStart(NOW)).toISOString()).toBe('2026-11-09T00:00:00.000Z');
  });
});
