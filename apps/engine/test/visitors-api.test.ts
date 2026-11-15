import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLog, ipCompanies, providerKeys, signals, sites, visits } from '../src/db/schema.ts';
import { encryptSecret } from '../src/crypto/secrets.ts';
import { makeCtx, setupClient, type Client } from './helpers.ts';
import { IP, makePipeline, UA } from './visit-fixtures.ts';
import type { VisitPipeline } from '../src/collector/pipeline.ts';

let c: Client;
let now: number;
let pipeline: VisitPipeline;

beforeEach(async () => {
  now = Date.UTC(2026, 10, 16, 15, 0, 0);
  c = await setupClient(makeCtx({}, () => now));
  pipeline = makePipeline(c.ctx).pipeline;
});

function addIpapiKey() {
  const ws = c.ctx.db.select().from(sites).get()!.workspaceId;
  c.ctx.db
    .insert(providerKeys)
    .values({
      workspaceId: ws,
      provider: 'ipapi',
      encryptedKey: encryptSecret(c.ctx.config.masterKey, ws, 'ipapi', 'ipapi-test-key'),
      createdAt: now,
    })
    .run();
}

async function addSite(domain = 'www.Example-SaaS.com') {
  const res = await c.send('POST', '/api/v1/sites', { domain });
  expect(res.status).toBe(201);
  return res.body;
}

const view = (ip: string, path: string) => ({
  site: c.ctx.db.select().from(sites).get()!,
  ip,
  userAgent: UA.chrome,
  path,
  referrer: null,
  utm: null,
});

describe('sites API', () => {
  it('creates a site with a snippet and default intent pages, and audits it', async () => {
    const site = await addSite();
    expect(site.domain).toBe('example-saas.com');
    expect(site.siteKey).toMatch(/^site_[A-Za-z0-9_-]{16}$/);
    expect(site.snippet).toContain(`data-site="${site.siteKey}"`);
    expect(site.snippet).toContain('http://127.0.0.1:4511/p.js');
    expect(site.snippet).toContain('<noscript>');
    expect(site.intentPages.map((p: { path: string }) => p.path)).toEqual([
      '/pricing',
      '/demo',
      '/contact',
    ]);
    expect((await c.send('POST', '/api/v1/sites', { domain: 'example-saas.com' })).status).toBe(
      409,
    );
    expect((await c.send('POST', '/api/v1/sites', { domain: 'not a domain' })).status).toBe(400);
    const list = await c.get('/api/v1/sites');
    expect(list.body.sites).toHaveLength(1);
    expect(list.body.status).toMatchObject({
      ipapiKey: false,
      collectorUrl: 'http://127.0.0.1:4511',
    });
    expect(
      c.ctx.db
        .select()
        .from(auditLog)
        .all()
        .map((a) => a.action),
    ).toContain('site.create');
  });

  it('updates intent pages with validation', async () => {
    const site = await addSite();
    const ok = await c.send('PATCH', `/api/v1/sites/${site.id}`, {
      intentPages: [
        { path: '/pricing', label: 'pricing' },
        { path: '/Pricing', label: 'dup' },
        { path: '/book-a-call', label: 'demo' },
      ],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.intentPages).toEqual([
      { path: '/pricing', label: 'pricing' },
      { path: '/book-a-call', label: 'demo' },
    ]);
    const bad = await c.send('PATCH', `/api/v1/sites/${site.id}`, {
      intentPages: [{ path: 'pricing?x=1', label: 'x' }],
    });
    expect(bad.status).toBe(400);
  });

  it('install check finds the snippet in the homepage HTML', async () => {
    const site = await addSite();
    c.ctx.crawler = {
      fetchHtml: async () => ({
        url: 'https://example-saas.com/',
        status: 200,
        body: `<html><body><script async src="https://collect.x.com/p.js" data-site="${site.siteKey}"></script></body></html>`,
      }),
    } as never;
    const res = await c.send('POST', `/api/v1/sites/${site.id}/check`);
    expect(res.body.check).toMatchObject({ ok: true, note: 'Snippet found on the homepage.' });
    c.ctx.crawler = {
      fetchHtml: async () => ({ url: '', status: 200, body: '<html></html>' }),
    } as never;
    const missing = await c.send('POST', `/api/v1/sites/${site.id}/check`);
    expect(missing.body.check.ok).toBe(false);
  });

  it('deletes a site with its visits', async () => {
    const site = await addSite();
    addIpapiKey();
    await pipeline.processVisit(view(IP.business, '/'));
    expect(c.ctx.db.select().from(visits).all()).toHaveLength(1);
    expect((await c.send('DELETE', `/api/v1/sites/${site.id}`)).status).toBe(200);
    expect(c.ctx.db.select().from(visits).all()).toHaveLength(0);
  });
});

describe('visitors API', () => {
  it('reports match rate, dropped traffic and companies with intent pages and path', async () => {
    const site = await addSite();
    addIpapiKey();
    for (const p of ['/', '/product', '/pricing']) {
      await pipeline.processVisit(view(IP.business, p));
      now += 10_000;
    }
    await pipeline.processVisit(view(IP.businessPtr, '/blog'));
    await pipeline.processVisit(view(IP.nonUs, '/'));
    await pipeline.processVisit(view(IP.ispLocal, '/'));
    await pipeline.processVisit(view(IP.vpn, '/'));

    const res = await c.get(`/api/v1/visitors?siteId=${site.id}`);
    expect(res.status).toBe(200);
    expect(res.body.kpi).toMatchObject({ sessions: 5, identified: 2, matchRate: 0.4, accounts: 2 });
    expect(res.body.outcomes).toMatchObject({
      matched: { sessions: 2, pageviews: 4 },
      non_us: { sessions: 1 },
      isp: { sessions: 1 },
      vpn: { sessions: 1 },
    });
    // Default filter: more than 2 pages or an intent page.
    expect(res.body.companies).toHaveLength(1);
    expect(res.body.hidden).toBe(1);
    expect(res.body.companies[0]).toMatchObject({
      domain: 'acme-robotics.com',
      visits: 1,
      pages: 3,
      intentPages: [{ path: '/pricing', count: 1 }],
      matchSource: 'provider',
      confidence: 0.8,
      path: ['/', '/product', '/pricing'],
    });
    const all = await c.get(`/api/v1/visitors?siteId=${site.id}&show=all`);
    expect(all.body.companies).toHaveLength(2);
  });

  it('"Wrong company" marks the IP map wrong, removes the visits, logs it, and blocks rematching', async () => {
    const site = await addSite();
    addIpapiKey();
    await pipeline.processVisit(view(IP.business, '/pricing'));
    const report = await c.get(`/api/v1/visitors?siteId=${site.id}`);
    const accountId = report.body.companies[0].accountId;

    const res = await c.send('POST', '/api/v1/visitors/wrong', { accountId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      domain: 'acme-robotics.com',
      prefixes: ['12.1.1.0/24'],
      removedVisits: 1,
      removedSignals: 2,
    });
    expect(c.ctx.db.select().from(ipCompanies).get()!.wrong).toBe(true);
    expect(c.ctx.db.select().from(visits).all()).toHaveLength(0);
    expect(
      c.ctx.db.select().from(signals).where(eq(signals.accountId, accountId)).all(),
    ).toHaveLength(0);
    const entry = c.ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'visitors.wrong_company'))
      .get();
    expect(entry).toMatchObject({ target: 'acme-robotics.com' });

    // Same session and a colleague in the same prefix no longer match that company.
    expect(await pipeline.processVisit(view(IP.business, '/demo'))).toBe('unmatched');
    expect(await pipeline.processVisit(view(IP.businessColleague, '/'))).toBe('unmatched');
    expect(c.ctx.db.select().from(visits).all()).toHaveLength(0);
  });

  it('needs a session and checks the workspace', async () => {
    const site = await addSite();
    const anon = await c.app.inject({ method: 'GET', url: `/api/v1/visitors?siteId=${site.id}` });
    expect(anon.statusCode).toBe(401);
    expect((await c.get('/api/v1/visitors?siteId=site_other')).status).toBe(404);
    expect((await c.send('POST', '/api/v1/visitors/wrong', { accountId: 'acc_x' })).status).toBe(
      404,
    );
  });
});
