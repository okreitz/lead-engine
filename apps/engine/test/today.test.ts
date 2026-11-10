import { describe, expect, it } from 'vitest';
import { costLedger, nextSteps, providerKeys, signals, workspaces } from '../src/db/schema.ts';
import { newId } from '../src/ids.ts';
import { fakeProvider } from '../src/providers/fake.ts';
import { callProvider } from '../src/providers/index.ts';
import { makeCtx, setupClient } from './helpers.ts';

const NOW = Date.UTC(2026, 10, 10, 12);
const DAY = 86_400_000;

describe('GET /api/v1/today', () => {
  it('lists top accounts with recent signals, next steps due and the budget', async () => {
    const c = await setupClient(makeCtx({}, () => NOW));
    const ws = (await c.get('/api/v1/workspace')).body.id;
    const acme = (
      await c.send('POST', '/api/v1/accounts', { domain: 'acme.com', name: 'Acme', country: 'US' })
    ).body.id;
    const quiet = (
      await c.send('POST', '/api/v1/accounts', {
        domain: 'quiet.com',
        name: 'Quiet',
        country: 'US',
      })
    ).body.id;
    const sup = (
      await c.send('POST', '/api/v1/accounts', { domain: 'gone.com', name: 'Gone', country: 'US' })
    ).body.id;
    const sig = (accountId: string, kind: string, at: number) =>
      c.ctx.db
        .insert(signals)
        .values({
          id: newId('sig'),
          workspaceId: ws,
          accountId,
          stream: 'visits',
          kind,
          weight: 3,
          occurredAt: at,
          payload: {},
        })
        .run();
    sig(acme, 'pricing_view', NOW - DAY);
    sig(acme, 'pricing_view', NOW - 2 * DAY);
    sig(quiet, 'visit', NOW - 30 * DAY); // outside the 7-day window
    sig(sup, 'visit', NOW - DAY);
    await c.send('POST', '/api/v1/suppressions', { kind: 'domain', value: 'gone.com' });
    c.ctx.db
      .insert(nextSteps)
      .values([
        {
          id: 'n1',
          workspaceId: ws,
          accountId: acme,
          text: 'Send case study',
          dueAt: NOW,
          createdAt: NOW,
        },
        {
          id: 'n2',
          workspaceId: ws,
          accountId: acme,
          text: 'Late',
          dueAt: NOW - 2 * DAY,
          createdAt: NOW,
        },
        {
          id: 'n3',
          workspaceId: ws,
          accountId: acme,
          text: 'Next week',
          dueAt: NOW + 7 * DAY,
          createdAt: NOW,
        },
      ])
      .run();

    const t = (await c.get('/api/v1/today')).body;
    expect(t.topSignals.map((a: any) => a.name)).toEqual(['Acme']);
    expect(t.topSignals[0].signals).toEqual([{ kind: 'pricing_view', stream: 'visits', count: 2 }]);
    expect(t.nextStepsDue.map((n: any) => [n.text, n.overdue])).toEqual([
      ['Late', true],
      ['Send case study', false],
    ]);
    expect(t.budget).toMatchObject({ budgetUsd: 50, state: 'ok' });
    expect(t.offer).toBeNull();
  });
});

describe('GET /api/v1/search', () => {
  it('finds accounts and contacts but never suppressed ones', async () => {
    const c = await setupClient();
    const acme = (
      await c.send('POST', '/api/v1/accounts', {
        domain: 'acme.com',
        name: 'Acme Rockets',
        country: 'US',
      })
    ).body.id;
    await c.send('POST', `/api/v1/accounts/${acme}/contacts`, {
      fullName: 'Rocky Doe',
      email: 'rocky@acme.com',
    });
    await c.send('POST', '/api/v1/accounts', {
      domain: 'rocket.io',
      name: 'Rocket IO',
      country: 'US',
    });
    await c.send('POST', '/api/v1/suppressions', { kind: 'domain', value: 'rocket.io' });
    const r = (await c.get('/api/v1/search?q=rock')).body;
    expect(r.accounts.map((a: any) => a.name)).toEqual(['Acme Rockets']);
    expect(r.contacts.map((x: any) => x.fullName)).toEqual(['Rocky Doe']);
  });
});

describe('ledger links and key usage', () => {
  it('records the target record on the ledger and the key last-use time', async () => {
    const c = await setupClient(makeCtx({}, () => NOW));
    const ws = c.ctx.db.select().from(workspaces).get()!.id;
    await c.send('PUT', '/api/v1/provider-keys/icypeas', { key: 'icy-key-123456' });
    const p = fakeProvider({ keyProvider: 'icypeas' });
    await callProvider(
      c.ctx,
      p,
      { fullName: 'J', domain: 'acme.com' },
      { workspaceId: ws, stream: 'personas', target: { entity: 'contact', entityId: 'con_1' } },
    );
    await callProvider(
      c.ctx,
      p,
      { fullName: 'K', domain: 'acme.com' },
      { workspaceId: ws, stream: 'personas', ledgerEntity: { type: 'offer_version', id: 'ofv_1' } },
    );
    const rows = c.ctx.db
      .select()
      .from(costLedger)
      .all()
      .map((r) => [r.entityType, r.entityId]);
    expect(rows).toEqual([
      ['contact', 'con_1'],
      ['offer_version', 'ofv_1'],
    ]);
    expect(c.ctx.db.select().from(providerKeys).get()!.lastUsedAt).toBe(NOW);
    const list = (await c.get('/api/v1/provider-keys')).body.providers.find(
      (x: any) => x.provider === 'icypeas',
    );
    expect(list.lastUsedAt).toBe(NOW);
  });
});
