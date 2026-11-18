import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { compileOffers, matchText, unionPhrases } from '../src/conversations/prefilter.ts';
import { ingestThreads } from '../src/conversations/store.ts';
import { accounts, sites, threads } from '../src/db/schema.ts';
import { jobHandlers } from '../src/jobs/handlers.ts';
import { JobRunner } from '../src/jobs/queue.ts';
import { fakeLlm } from '../src/llm/fake.ts';
import { approvedOffer, approvedOffers } from '../src/offer/approved.ts';
import { icpDropReason } from '../src/universe/normalize.ts';
import { makeCtx, setupClient, type Client } from './helpers.ts';
import { approveOffer } from './offer-fixtures.ts';

const NOW = Date.UTC(2026, 10, 18, 10, 0, 0);

const CONSULTING = [
  { phrase: 'fractional CTO', kind: 'seeking' as const, negative: ['job'] },
  { phrase: 'CRM alternative', kind: 'alternative' as const, negative: [] },
];
const PRODUCT = [
  { phrase: 'team offsite planning', kind: 'seeking' as const, negative: [] },
  { phrase: 'crm ALTERNATIVE', kind: 'alternative' as const, negative: [] },
];

/** Two approved offers: consulting (logistics ICP) first, then the product (software ICP). */
async function twoOffers(over: Parameters<typeof makeCtx>[0] = {}): Promise<Client> {
  const c = await setupClient(makeCtx(over, () => NOW));
  approveOffer(
    c.ctx,
    { industries: ['Logistics'], naics: [], states: [], exclude: [] },
    { name: 'Consulting', intentPhrases: CONSULTING },
    {
      key: 'consult',
      name: 'Consulting',
      websiteUrl: 'https://okreitz.com/',
      approvedAt: NOW - 1000,
    },
  );
  approveOffer(
    c.ctx,
    { industries: ['Software'], naics: [], states: [], exclude: [] },
    { name: 'Product', intentPhrases: PRODUCT },
    { key: 'product', name: 'Product', websiteUrl: 'https://andhuman.com/', approvedAt: NOW },
  );
  return c;
}

const wsId = (c: Client) => c.ctx.db.select().from(accounts).get()?.workspaceId;

describe('approved offers', () => {
  it('lists every approved offer, newest first, and finds one by id', async () => {
    const c = await twoOffers();
    const ws = (await c.get('/api/v1/auth/me')).body.workspace.id as string;
    const all = approvedOffers(c.ctx.db, ws);
    expect(all.map((o) => o.offerId)).toEqual(['off_product', 'off_consult']);
    expect(approvedOffer(c.ctx.db, ws)?.offerId).toBe('off_product');
    expect(approvedOffer(c.ctx.db, ws, 'off_consult')?.name).toBe('Consulting');
    expect(approvedOffer(c.ctx.db, ws, 'off_missing')).toBeNull();
  });
});

describe('conversations with several offers', () => {
  it('searches each phrase once and files a thread under the offer whose phrase matched', async () => {
    const c = await twoOffers();
    const ws = (await c.get('/api/v1/auth/me')).body.workspace.id as string;
    const offers = approvedOffers(c.ctx.db, ws);
    // "CRM alternative" is in both offers: searched once.
    expect(unionPhrases(offers).map((p) => p.phrase)).toEqual([
      'team offsite planning',
      'crm ALTERNATIVE',
      'fractional CTO',
    ]);
    const compiled = compileOffers(offers);
    expect(matchText(compiled, 'Looking for a fractional CTO for our startup')?.offerId).toBe(
      'off_consult',
    );
    const res = ingestThreads(
      c.ctx.db,
      ws,
      compiled,
      [
        {
          source: 'hn',
          externalId: '1',
          url: 'https://news.ycombinator.com/item?id=1',
          title: 'Ask HN: fractional CTO for a seed startup?',
          text: 'We need a fractional CTO for six months.',
          author: 'a',
          postedAt: NOW - 3600_000,
        },
        {
          source: 'hn',
          externalId: '2',
          url: 'https://news.ycombinator.com/item?id=2',
          title: 'Team offsite planning tools?',
          text: 'Any good tools for team offsite planning?',
          author: 'b',
          postedAt: NOW - 3600_000,
        },
      ],
      NOW,
    );
    expect(res.inserted).toBe(2);
    const stored = c.ctx.db.select().from(threads).all();
    expect(Object.fromEntries(stored.map((t) => [t.externalId, t.offerId]))).toEqual({
      '1': 'off_consult',
      '2': 'off_product',
    });

    // The inbox can be filtered by offer and shows each thread's offer.
    await c.ctx.db.update(threads).set({ scoreStatus: 'scored', intent: 3 }).run();
    const inbox = await c.get('/api/v1/inbox?tab=all&offer=off_consult');
    expect(inbox.status).toBe(200);
    expect(inbox.body.threads.map((t: { offerId: string }) => t.offerId)).toEqual(['off_consult']);
  });

  it('scores each thread against its own offer', async () => {
    const llm = fakeLlm(() => ({
      intent: 3,
      label: 'alternative',
      pain: 'needs help',
      stage: 'evaluating',
      persona: 'founder',
      companyMentioned: null,
      replyAngle: 'Happy to help.',
      selfPromo: false,
      reason: 'asks for help',
    }));
    const ctx = makeCtx({}, () => NOW);
    ctx.llm = llm;
    ctx.sleep = async () => {};
    const c = await setupClient(ctx);
    approveOffer(
      c.ctx,
      {},
      { name: 'Consulting', summary: 'CONSULTING-SUMMARY', intentPhrases: CONSULTING },
      { key: 'consult', name: 'Consulting', approvedAt: NOW - 1000 },
    );
    approveOffer(
      c.ctx,
      {},
      { name: 'Product', summary: 'PRODUCT-SUMMARY', intentPhrases: PRODUCT },
      { key: 'product', name: 'Product', approvedAt: NOW },
    );
    const ws = (await c.get('/api/v1/auth/me')).body.workspace.id as string;
    ingestThreads(
      c.ctx.db,
      ws,
      compileOffers(approvedOffers(c.ctx.db, ws)),
      [
        {
          source: 'hn',
          externalId: '1',
          url: 'https://news.ycombinator.com/item?id=1',
          title: 'Need a fractional CTO',
          text: 'fractional CTO wanted',
          author: 'a',
          postedAt: NOW - 1000,
        },
      ],
      NOW,
    );
    const { enqueue } = await import('../src/jobs/queue.ts');
    enqueue(c.ctx.db, { workspaceId: ws, type: 'conversations.score', payload: {} }, NOW);
    const runner = new JobRunner(c.ctx, jobHandlers(c.ctx));
    for (let i = 0; i < 10 && (await runner.tick()) > 0; i++);
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.prompt).toContain('CONSULTING-SUMMARY');
    expect(llm.requests[0]!.prompt).not.toContain('PRODUCT-SUMMARY');
    expect(c.ctx.db.select().from(threads).get()?.scoreStatus).toBe('scored');
  });
});

describe('accounts with several offers', () => {
  it('scores fit against the account offer, or the best offer when it has none', async () => {
    const c = await twoOffers();
    const created = await c.send('POST', '/api/v1/accounts', {
      domain: 'acme-logistics.com',
      name: 'Acme Logistics',
      industry: 'Logistics',
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const best = c.ctx.db.select().from(accounts).where(eq(accounts.id, id)).get()!;
    expect(best.offerId).toBeNull();
    expect(best.scoreReasons?.fit[0]).toBe('Best fit: "Consulting"');

    // Filed under the product offer, the same company fits worse (software ICP).
    expect(
      (await c.send('PATCH', `/api/v1/accounts/${id}`, { offerId: 'off_product' })).status,
    ).toBe(200);
    const product = c.ctx.db.select().from(accounts).where(eq(accounts.id, id)).get()!;
    expect(product.offerId).toBe('off_product');
    expect(product.fitScore!).toBeLessThan(best.fitScore!);

    // Filter by offer, and `none`.
    const list = await c.get('/api/v1/accounts?offer=off_product');
    expect(list.body.map((a: { id: string }) => a.id)).toEqual([id]);
    expect((await c.get('/api/v1/accounts?offer=none')).body).toHaveLength(0);
    expect((await c.get('/api/v1/accounts?offer=off_consult')).body).toHaveLength(0);

    // Another workspace's (or a made-up) offer is refused.
    expect(
      (await c.send('PATCH', `/api/v1/accounts/${id}`, { offerId: 'off_elsewhere' })).status,
    ).toBe(404);
    expect(wsId(c)).toBeDefined();
  });

  it('asks which offer to find companies for when several are approved', async () => {
    const c = await twoOffers();
    const none = await c.send('POST', '/api/v1/persona/estimate', {});
    expect(none.status).toBe(400);
    expect(none.body.error).toBe('choose_offer');
    const one = await c.send('POST', '/api/v1/persona/estimate', { offerId: 'off_consult' });
    expect(one.status).toBe(200);
    expect(one.body.filters.industries).toEqual(['Logistics']);
    const bad = await c.send('POST', '/api/v1/persona/estimate', { offerId: 'off_missing' });
    expect(bad.body.error).toBe('offer_not_approved');
  });

  it('keeps a company when it fits any offer during the import', () => {
    const row = {
      name: 'Acme',
      domain: 'acme.com',
      country: 'US',
      state: 'TX',
      city: null,
      industry: 'Software',
      naics: null,
      sizeRange: '11-50',
      foundedYear: null,
    };
    const logistics = { industries: ['Logistics'], employeeRange: null, states: [], exclude: [] };
    const software = { industries: ['Software'], employeeRange: null, states: [], exclude: [] };
    expect(icpDropReason(row, logistics)).toBe('icp');
    const both = { industries: [], employeeRange: null, states: [], exclude: [] };
    expect(icpDropReason(row, { ...both, anyOf: [logistics, software] })).toBeNull();
    expect(icpDropReason(row, { ...both, anyOf: [logistics] })).toBe('icp');
  });
});

describe('sites and offers', () => {
  it('files a new site under the offer drafted from its domain, and can move it', async () => {
    const c = await twoOffers();
    const site = await c.send('POST', '/api/v1/sites', { domain: 'www.andhuman.com' });
    expect(site.status).toBe(201);
    expect(site.body.offerId).toBe('off_product');
    const other = await c.send('POST', '/api/v1/sites', { domain: 'futurespeople.com' });
    expect(other.body.offerId).toBeNull();
    const moved = await c.send('PATCH', `/api/v1/sites/${other.body.id}`, {
      offerId: 'off_consult',
    });
    expect(moved.status).toBe(200);
    expect(moved.body.offerId).toBe('off_consult');
    expect(
      c.ctx.db.select().from(sites).where(eq(sites.id, other.body.id)).get()?.intentPages.length,
    ).toBeGreaterThan(0);
    expect(
      (await c.send('PATCH', `/api/v1/sites/${other.body.id}`, { offerId: 'off_nope' })).status,
    ).toBe(404);
  });
});

describe('offer limit and delete', () => {
  it('refuses new offers past LE_MAX_OFFERS and reports the limit', async () => {
    const c = await setupClient(makeCtx({ maxOffers: 1 }, () => NOW));
    const me = await c.get('/api/v1/auth/me');
    expect(me.body.workspace).toMatchObject({ offerLimit: 1, offerCount: 0 });
    const first = await c.send('POST', '/api/v1/offers', { websiteUrl: 'https://okreitz.com' });
    expect(first.status).toBe(201);
    const second = await c.send('POST', '/api/v1/offers', { websiteUrl: 'https://andhuman.com' });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('offer_limit');
    expect((await c.get('/api/v1/auth/me')).body.workspace.offerCount).toBe(1);
  });

  it('deletes an offer only with its exact name; its accounts keep going without it', async () => {
    const c = await twoOffers();
    const acc = await c.send('POST', '/api/v1/accounts', {
      domain: 'acme-soft.com',
      name: 'Acme Soft',
      industry: 'Software',
      offerId: 'off_product',
    });
    expect(
      (await c.send('DELETE', '/api/v1/offers/off_product', { confirmName: 'product' })).status,
    ).toBe(400);
    expect(
      (await c.send('DELETE', '/api/v1/offers/off_product', { confirmName: 'Product' })).status,
    ).toBe(200);
    const row = c.ctx.db.select().from(accounts).where(eq(accounts.id, acc.body.id)).get()!;
    expect(row.offerId).toBeNull();
    // Rescored against the remaining (consulting) offer.
    expect(row.scoreReasons?.fit[0]).not.toBe('No approved offer profile yet');
    expect((await c.get('/api/v1/offers')).body.map((o: { id: string }) => o.id)).toEqual([
      'off_consult',
    ]);
  });
});

describe('migration 0010 backfill', () => {
  it('files existing threads, persona accounts and sites under the right offer', async () => {
    const { readFileSync } = await import('node:fs');
    const c = await twoOffers();
    const ws = (await c.get('/api/v1/auth/me')).body.workspace.id as string;
    const sql = c.ctx.db.$client;
    // State before the migration: rows without an offer.
    sql
      .prepare(
        `INSERT INTO threads (id, workspace_id, source, external_id, url, title, excerpt, posted_at,
          matched_phrase, phrase_kind, meta, created_at, updated_at, expires_at)
         VALUES ('thr_1', ?, 'hn', '1', 'https://x/1', 't', 'e', 0, 'p', 'seeking', '{}', 0, 0, 0)`,
      )
      .run(ws);
    sql
      .prepare(
        `INSERT INTO sites (id, workspace_id, domain, site_key, intent_pages, created_at)
         VALUES ('site_1', ?, 'okreitz.com', 'site_k1', '[]', 0)`,
      )
      .run(ws);
    const backfill = readFileSync(
      new URL('../src/db/migrations/0010_multi_offer.sql', import.meta.url),
      'utf8',
    )
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) =>
        s
          .replace(/^--.*$/gm, '')
          .trim()
          .startsWith('UPDATE'),
      );
    expect(backfill).toHaveLength(4);
    for (const stmt of backfill) sql.exec(stmt);
    // Threads: the most recently approved offer (it was the one searching).
    expect(c.ctx.db.select().from(threads).get()?.offerId).toBe('off_product');
    // Sites: the offer drafted from the same domain.
    expect(c.ctx.db.select().from(sites).get()?.offerId).toBe('off_consult');
  });
});
