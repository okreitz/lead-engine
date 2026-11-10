import { describe, expect, it } from 'vitest';
import { activities, auditLog } from '../src/db/schema.ts';
import { clientFor, setupClient, type Client } from './helpers.ts';

async function seed(c: Client) {
  const mk = async (domain: string, name: string, stage?: string) =>
    (
      await c.send('POST', '/api/v1/accounts', {
        domain,
        name,
        country: 'US',
        ...(stage ? { stage } : {}),
      })
    ).body.id as string;
  return {
    a: await mk('acme.com', 'Acme'),
    b: await mk('globex.com', 'Globex', 'Researching'),
    d: await mk('initech.com', 'Initech', 'Contacted'),
  };
}

describe('account filters', () => {
  it('ORs values within a filter and ANDs filters', async () => {
    const c = await setupClient();
    await seed(c);
    const names = async (qs: string) =>
      (await c.get(`/api/v1/accounts?${qs}`)).body.map((a: any) => a.name).sort();
    expect(await names('stage=New,Researching')).toEqual(['Acme', 'Globex']);
    expect(await names('stage=New,Researching&q=glob')).toEqual(['Globex']);
    expect(await names('stage=New,Researching&stream=personas')).toEqual([]);
    expect((await c.get('/api/v1/accounts?stream=bogus')).status).toBe(400);
  });

  it('returns next step, last activity, days-in-stage source and open deal value', async () => {
    const c = await setupClient();
    const { a } = await seed(c);
    await c.send('POST', `/api/v1/accounts/${a}/next-steps`, {
      text: 'Call',
      dueAt: Date.now() + 86_400_000,
    });
    await c.send('POST', `/api/v1/accounts/${a}/deals`, { name: 'Pilot', valueUsd: 4000 });
    await c.send('PATCH', `/api/v1/accounts/${a}/stage`, { stage: 'Contacted' });
    const row = (await c.get('/api/v1/accounts?q=acme')).body[0];
    expect(row).toMatchObject({ nextStep: 'Call', openDealsUsd: 4000 });
    expect(row.stageSince).toBeGreaterThanOrEqual(row.createdAt);
    const board = (await c.get('/api/v1/pipeline')).body;
    expect(board.columns.find((x: any) => x.stage === 'Contacted')).toMatchObject({
      count: 2,
      openDealsUsd: 4000,
    });
  });
});

describe('bulk actions', () => {
  it('sets stage with activities, archives, and suppresses domains (audited)', async () => {
    const c = await setupClient();
    const { a, b, d } = await seed(c);
    expect(
      (
        await c.send('POST', '/api/v1/accounts/bulk', {
          ids: [a, b],
          action: 'stage',
          stage: 'Meeting',
        })
      ).body.changed,
    ).toBe(2);
    expect(
      c.ctx.db
        .select()
        .from(activities)
        .all()
        .filter((x) => x.kind === 'stage_change'),
    ).toHaveLength(2);
    await c.send('POST', '/api/v1/accounts/bulk', { ids: [d], action: 'suppress' });
    expect((await c.get('/api/v1/accounts')).body.map((x: any) => x.name).sort()).toEqual([
      'Acme',
      'Globex',
    ]);
    await c.send('POST', '/api/v1/accounts/bulk', { ids: [a], action: 'archive' });
    expect((await c.get('/api/v1/accounts')).body.map((x: any) => x.name)).toEqual(['Globex']);
    const actions = c.ctx.db
      .select()
      .from(auditLog)
      .all()
      .map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['suppression.add', 'account.archive']));
    expect(
      (await c.send('POST', '/api/v1/accounts/bulk', { ids: ['acc_nope'], action: 'archive' }))
        .status,
    ).toBe(404);
  });

  it('exports only the selected accounts', async () => {
    const c = await setupClient();
    const { a } = await seed(c);
    const csv = (await c.get(`/api/v1/export/accounts.csv?ids=${a}`)).body as string;
    expect(csv).toContain('acme.com');
    expect(csv).not.toContain('globex.com');
  });
});

describe('saved views', () => {
  it('creates, pins, updates and deletes; private views stay private', async () => {
    const c = await setupClient();
    const v = await c.send('POST', '/api/v1/views', {
      name: 'TX logistics',
      state: { filters: { stage: ['New'] }, sort: 'priority' },
      pinned: true,
    });
    expect(v.status).toBe(201);
    await c.send('PATCH', `/api/v1/views/${v.body.id}`, { name: 'Texas logistics' });
    expect((await c.get('/api/v1/views')).body).toEqual([
      expect.objectContaining({ name: 'Texas logistics', pinned: true }),
    ]);

    await c.send('POST', '/api/v1/workspace/members', {
      email: 'm@example.com',
      password: 'member password 1',
    });
    const login = await c.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'm@example.com', password: 'member password 1' },
    });
    const m = clientFor(
      c.app,
      c.ctx,
      login.cookies.find((x) => x.name === 'le_session')!.value,
      login.json().csrfToken,
    );
    expect((await m.get('/api/v1/views')).body).toEqual([]);
    expect((await m.send('DELETE', `/api/v1/views/${v.body.id}`)).status).toBe(404);
    await c.send('POST', '/api/v1/views', { name: 'Team view', state: {}, shared: true });
    expect((await m.get('/api/v1/views')).body.map((x: any) => x.name)).toEqual(['Team view']);

    expect((await c.send('DELETE', `/api/v1/views/${v.body.id}`)).status).toBe(200);
  });
});
