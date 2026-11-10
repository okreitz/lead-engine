import { describe, expect, it } from 'vitest';
import { activities, auditLog, fieldSources } from '../src/db/schema.ts';
import { parseCsv, parseCsvObjects, toCsv } from '../src/crm/csv.ts';
import { ftsQuery } from '../src/crm/accounts.ts';
import { setupClient, type Client } from './helpers.ts';

async function account(c: Client, domain = 'acme.com', name = 'Acme Rockets', extra: object = {}) {
  const res = await c.send('POST', '/api/v1/accounts', {
    domain,
    name,
    country: 'US',
    state: 'CA',
    ...extra,
  });
  expect([200, 201]).toContain(res.status);
  return res.body.id as string;
}

async function exportText(c: Client, entity: string): Promise<string> {
  const res = await c.get(`/api/v1/export/${entity}.csv`);
  expect(res.status).toBe(200);
  return typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
}

describe('accounts', () => {
  it('creates US accounts only and dedupes by domain', async () => {
    const c = await setupClient();
    const id = await account(c, 'https://www.Acme.com/about');
    expect(await account(c, 'acme.com')).toBe(id);
    const de = await c.send('POST', '/api/v1/accounts', {
      domain: 'acme.de',
      name: 'Acme DE',
      country: 'DE',
    });
    expect(de.status).toBe(400);
    expect(de.body.error).toBe('not_us');
    const list = await c.get('/api/v1/accounts');
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ domain: 'acme.com', stage: 'New', firstSource: 'manual' });
  });

  it('searches by name and domain with FTS', async () => {
    const c = await setupClient();
    await account(c, 'acme.com', 'Acme Rockets');
    await account(c, 'globex.com', 'Globex Corporation');
    expect((await c.get('/api/v1/accounts?q=rock')).body.map((a: any) => a.domain)).toEqual([
      'acme.com',
    ]);
    expect((await c.get('/api/v1/accounts?q=globex')).body.map((a: any) => a.domain)).toEqual([
      'globex.com',
    ]);
    expect((await c.get('/api/v1/accounts?q=%22)(*')).status).toBe(200); // hostile input is tokenised
  });

  it('logs every stage change as an activity', async () => {
    const c = await setupClient();
    const id = await account(c);
    expect(
      (await c.send('PATCH', `/api/v1/accounts/${id}/stage`, { stage: 'Contacted' })).status,
    ).toBe(200);
    expect((await c.send('PATCH', `/api/v1/accounts/${id}/stage`, { stage: 'Nope' })).status).toBe(
      400,
    );
    const detail = await c.get(`/api/v1/accounts/${id}`);
    expect(detail.body.account.stage).toBe('Contacted');
    const acts = c.ctx.db.select().from(activities).all();
    expect(acts).toEqual([
      expect.objectContaining({ kind: 'stage_change', meta: { from: 'New', to: 'Contacted' } }),
    ]);
    const board = await c.get('/api/v1/pipeline');
    expect(board.body.columns.find((col: any) => col.stage === 'Contacted').accounts).toHaveLength(
      1,
    );
  });

  it('isolates workspaces', async () => {
    const c = await setupClient();
    const id = await account(c);
    await c.send('POST', '/api/v1/workspaces', { name: 'Other' });
    expect((await c.get(`/api/v1/accounts/${id}`)).status).toBe(404);
    expect((await c.get('/api/v1/accounts')).body).toHaveLength(0);
  });
});

describe('contacts, deals, activities, next steps', () => {
  it('builds an account page', async () => {
    const c = await setupClient();
    const id = await account(c);
    const con = await c.send('POST', `/api/v1/accounts/${id}/contacts`, {
      fullName: 'Jane Doe',
      title: 'CTO',
      email: 'Jane@Acme.com',
    });
    expect(con.status).toBe(201);
    const deal = await c.send('POST', `/api/v1/accounts/${id}/deals`, {
      name: 'Pilot',
      valueUsd: 5000,
    });
    expect(
      (await c.send('PATCH', `/api/v1/deals/${deal.body.id}`, { stage: 'Proposal' })).status,
    ).toBe(200);
    await c.send('POST', `/api/v1/accounts/${id}/activities`, {
      kind: 'call',
      body: 'Intro call',
      contactId: con.body.id,
    });
    const ns = await c.send('POST', `/api/v1/accounts/${id}/next-steps`, {
      text: 'Send proposal',
      dueAt: Date.now() + 86400000,
    });
    await c.send('PATCH', `/api/v1/next-steps/${ns.body.id}`, { done: true });
    const d = (await c.get(`/api/v1/accounts/${id}`)).body;
    expect(d.contacts[0]).toMatchObject({ email: 'jane@acme.com', emailStatus: 'unknown' });
    expect(d.deals[0]).toMatchObject({ name: 'Pilot', stage: 'Proposal' });
    expect(d.activities.map((a: any) => a.kind).sort()).toEqual(['call', 'stage_change']);
    expect(d.nextSteps[0].doneAt).toBeTypeOf('number');
    expect(
      d.fieldSources
        .filter((f: any) => f.entity === 'contact')
        .map((f: any) => f.field)
        .sort(),
    ).toEqual(['email', 'fullName', 'title']);
  });

  it('rejects an activity linking another account’s contact', async () => {
    const c = await setupClient();
    const a = await account(c, 'acme.com');
    const b = await account(c, 'globex.com', 'Globex');
    const con = await c.send('POST', `/api/v1/accounts/${a}/contacts`, { fullName: 'Jane' });
    const res = await c.send('POST', `/api/v1/accounts/${b}/activities`, {
      kind: 'note',
      body: 'x',
      contactId: con.body.id,
    });
    expect(res.status).toBe(400);
  });
});

describe('suppression is honoured everywhere', () => {
  it('hides suppressed emails and domains from views and exports', async () => {
    const c = await setupClient();
    const acme = await account(c, 'acme.com');
    const globex = await account(c, 'globex.com', 'Globex');
    const jane = await c.send('POST', `/api/v1/accounts/${acme}/contacts`, {
      fullName: 'Jane',
      email: 'jane@acme.com',
    });
    expect(
      (await c.get(`/api/v1/contacts/${jane.body.id}`)).body.fieldSources.length,
    ).toBeGreaterThan(0);
    await c.send('POST', `/api/v1/accounts/${acme}/contacts`, {
      fullName: 'Bob',
      email: 'bob@acme.com',
    });
    await c.send('POST', `/api/v1/accounts/${globex}/contacts`, {
      fullName: 'Hank',
      email: 'hank@globex.com',
    });

    // One-click opt-out for a contact
    expect((await c.send('POST', `/api/v1/contacts/${jane.body.id}/suppress`)).status).toBe(200);
    let contacts = (await c.get('/api/v1/contacts')).body.map((x: any) => x.fullName);
    expect(contacts.sort()).toEqual(['Bob', 'Hank']);
    expect(
      (await c.get(`/api/v1/accounts/${acme}`)).body.contacts.map((x: any) => x.fullName),
    ).toEqual(['Bob']);
    expect(await exportText(c, 'contacts')).not.toContain('jane@acme.com');
    expect((await c.get(`/api/v1/contacts/${jane.body.id}`)).status).toBe(404);

    // Domain suppression hides the account, its contacts and its deals
    await c.send('POST', `/api/v1/accounts/${globex}/deals`, { name: 'Globex deal' });
    expect(
      (
        await c.send('POST', '/api/v1/suppressions', {
          kind: 'domain',
          value: 'globex.com',
          reason: 'asked',
        })
      ).status,
    ).toBe(201);
    expect((await c.get('/api/v1/accounts')).body.map((a: any) => a.domain)).toEqual(['acme.com']);
    expect((await c.get(`/api/v1/accounts/${globex}`)).status).toBe(404);
    contacts = (await c.get('/api/v1/contacts')).body.map((x: any) => x.fullName);
    expect(contacts).toEqual(['Bob']);
    const board = (await c.get('/api/v1/pipeline')).body;
    expect(board.columns.flatMap((col: any) => col.accounts).map((a: any) => a.domain)).toEqual([
      'acme.com',
    ]);
    for (const entity of ['accounts', 'contacts', 'deals'])
      expect(await exportText(c, entity)).not.toContain('globex');

    // New suppressed contacts are refused
    const blocked = await c.send('POST', `/api/v1/accounts/${acme}/contacts`, {
      fullName: 'Jane 2',
      email: 'JANE@acme.com',
    });
    expect(blocked.status).toBe(409);

    // Removing the suppression restores the records
    const list = (await c.get('/api/v1/suppressions')).body;
    const dom = list.find((s: any) => s.value === 'globex.com');
    await c.send('DELETE', `/api/v1/suppressions/${dom.id}`);
    expect((await c.get('/api/v1/accounts')).body).toHaveLength(2);

    const actions = c.ctx.db
      .select()
      .from(auditLog)
      .all()
      .map((a) => a.action);
    expect(actions.filter((a) => a === 'suppression.add')).toHaveLength(2);
    expect(actions).toContain('suppression.remove');
    expect(actions).toContain('export');
  });

  it('a suppressed parent domain covers subdomains and their emails', async () => {
    const c = await setupClient();
    const id = await account(c, 'eu.acme.com', 'Acme EU');
    await c.send('POST', `/api/v1/accounts/${id}/contacts`, {
      fullName: 'X',
      email: 'x@mail.acme.com',
    });
    await c.send('POST', '/api/v1/suppressions', { kind: 'domain', value: 'acme.com' });
    expect((await c.get('/api/v1/accounts')).body).toHaveLength(0);
    expect((await c.get('/api/v1/contacts')).body).toHaveLength(0);
  });
});

describe('CSV', () => {
  it('parses quotes, commas, newlines and BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi""\nok"\n\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"\nok'],
    ]);
    expect(parseCsvObjects('Full Name,E-mail\nJane,j@x.com')).toEqual([
      { full_name: 'Jane', e_mail: 'j@x.com' },
    ]);
  });

  it('round-trips and neutralises formulas', () => {
    const csv = toCsv(
      ['a', 'b'],
      [
        { a: '=HYPERLINK("x")', b: 'p,q' },
        { a: '-1', b: null },
      ],
    );
    expect(csv).toBe(`a,b\r\n"'=HYPERLINK(""x"")","p,q"\r\n'-1,\r\n`);
    expect(parseCsv(csv)[1]).toEqual(['\'=HYPERLINK("x")', 'p,q']);
  });

  it('imports accounts (US only), contacts and deals, reporting skipped rows', async () => {
    const c = await setupClient();
    await c.send('POST', '/api/v1/suppressions', { kind: 'email', value: 'no@acme.com' });
    const imp = (entity: string, text: string) =>
      c.app.inject({
        method: 'POST',
        url: `/api/v1/import/${entity}`,
        cookies: { le_session: c.cookie },
        headers: { 'x-csrf-token': c.csrf, 'content-type': 'text/csv' },
        payload: text,
      });
    const a = await imp(
      'accounts',
      'domain,name,country,state\nacme.com,Acme,US,CA\nglobex.de,Globex,DE,\nbad domain,X,US,\ninitech.com,Initech,,TX\n',
    );
    expect(a.json()).toMatchObject({ created: 1, existing: 0 });
    expect(a.json().skipped.map((s: any) => s.row)).toEqual([3, 4, 5]);
    const ct = await imp(
      'contacts',
      'account_domain,full_name,email,title\nacme.com,Jane,jane@acme.com,CTO\nacme.com,No,no@acme.com,\nnowhere.com,Z,,\n',
    );
    expect(ct.json()).toMatchObject({ created: 1 });
    expect(ct.json().skipped).toHaveLength(2);
    const dl = await imp(
      'deals',
      'account_domain,name,value_usd,stage\nacme.com,Pilot,"$5,000",Proposal\n',
    );
    expect(dl.json()).toMatchObject({ created: 1 });
    expect(await exportText(c, 'deals')).toContain('Pilot,Proposal,5000');
    const sources = c.ctx.db.select().from(fieldSources).all();
    expect(sources.every((s) => s.source === 'csv_import')).toBe(true);
  });
});

describe('ftsQuery', () => {
  it('turns words into quoted prefix terms', () => {
    expect(ftsQuery('Acme rock*')).toBe('"acme"* "rock"*');
    expect(ftsQuery('"); DROP')).toBe('"drop"*');
    expect(ftsQuery('  ')).toBeNull();
  });
});
