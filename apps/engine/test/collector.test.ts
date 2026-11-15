import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../src/api/context.ts';
import { buildCollector } from '../src/collector/server.ts';
import {
  accounts,
  companies,
  dailySalts,
  ipCompanies,
  jobs,
  signals,
  suppressions,
  visitDaily,
  visits,
} from '../src/db/schema.ts';
import { makeCtx } from './helpers.ts';
import { approveOffer } from './offer-fixtures.ts';
import {
  dumpDb,
  IP,
  makePipeline,
  seedVisits,
  SITE_KEY,
  storedCounts,
  UA,
} from './visit-fixtures.ts';

let ctx: AppContext;
let now: number;
const T0 = Date.UTC(2026, 10, 16, 15, 0, 0);

beforeEach(() => {
  now = T0;
  ctx = makeCtx({}, () => now);
});

function counters() {
  return Object.fromEntries(
    ctx.db
      .select()
      .from(visitDaily)
      .all()
      .map((r) => [r.outcome, { sessions: r.sessions, pageviews: r.pageviews }]),
  );
}

const view = (
  site: ReturnType<typeof seedVisits>['site'],
  ip: string,
  path = '/',
  ua = UA.chrome,
) => ({
  site,
  ip,
  userAgent: ua,
  path,
  referrer: null,
  utm: null,
});

describe('collector pipeline: dropped traffic is never stored', () => {
  const EMPTY = {
    visits: 0,
    accounts: 0,
    companies: 0,
    signals: 0,
    ipCompanies: 0,
    fieldSources: 0,
    jobs: 0,
  };

  const cases: [string, string, string, string][] = [
    ['non-US IPv4', IP.nonUs, UA.chrome, 'non_us'],
    ['non-US IPv6', IP.nonUsV6, UA.chrome, 'non_us'],
    ['bot user agent', IP.business, UA.googlebot, 'bot'],
    ['curl', IP.business, UA.curl, 'bot'],
    ['empty user agent', IP.business, '', 'bot'],
    ['ISP by local ASN', IP.ispLocal, UA.chrome, 'isp'],
    ['mobile by local ASN', IP.mobileLocal, UA.chrome, 'mobile'],
    ['hosting by local ASN', IP.hostingLocal, UA.chrome, 'hosting'],
    ['unknown location', IP.unknownGeo, UA.chrome, 'unclassified'],
    ['private address', '10.1.2.3', UA.chrome, 'unclassified'],
  ];

  for (const [name, ip, ua, outcome] of cases) {
    it(`${name} → ${outcome}, without an ipapi.is call, and the IP is stored nowhere`, async () => {
      const { site } = seedVisits(ctx);
      const { pipeline, ipapiCalls, ptrCalls } = makePipeline(ctx);
      const before = JSON.stringify(dumpDb(ctx));
      expect(await pipeline.processVisit(view(site, ip, '/pricing', ua))).toBe(outcome);
      expect(ipapiCalls).toHaveLength(0);
      expect(ptrCalls).toHaveLength(0);
      expect(storedCounts(ctx)).toEqual(EMPTY);
      expect(counters()).toEqual({ [outcome]: { sessions: 1, pageviews: 1 } });
      const after = dumpDb(ctx);
      expect(JSON.stringify(after)).not.toContain(ip);
      // Only the counter (and the day's salt) changed.
      const { visit_daily, daily_salts, ...rest } = after;
      expect(visit_daily).toHaveLength(1);
      expect(daily_salts).toHaveLength(1);
      const restBefore = JSON.parse(before) as Record<string, unknown>;
      delete restBefore.visit_daily;
      delete restBefore.daily_salts;
      expect(JSON.stringify(rest)).toBe(JSON.stringify(restBefore));
    });
  }

  const providerCases: [string, string, string][] = [
    ['ISP by ipapi.is company type', IP.ispProvider, 'isp'],
    ['mobile by ipapi.is', IP.mobileProvider, 'mobile'],
    ['hosting by ipapi.is', IP.hostingProvider, 'hosting'],
    ['VPN by ipapi.is', IP.vpn, 'vpn'],
    ['iCloud Private Relay', IP.relay, 'vpn'],
    ['crawler by ipapi.is', IP.crawler, 'bot'],
  ];
  for (const [name, ip, outcome] of providerCases) {
    it(`${name} → ${outcome}; the raw IP is only in the 30-day ipapi.is cache`, async () => {
      const { site } = seedVisits(ctx);
      const { pipeline, ipapiCalls } = makePipeline(ctx);
      expect(await pipeline.processVisit(view(site, ip, '/demo'))).toBe(outcome);
      expect(ipapiCalls).toHaveLength(1);
      expect(storedCounts(ctx)).toEqual(EMPTY);
      const dump = dumpDb(ctx);
      const tablesWithIp = Object.entries(dump)
        .filter(([, rows]) => JSON.stringify(rows).includes(ip))
        .map(([t]) => t);
      expect(tablesWithIp).toEqual(['ip_lookup_cache']);
      const cached = dump.ip_lookup_cache![0] as { result: string; expires_at: number };
      expect(cached.expires_at - T0).toBe(30 * 86_400_000);
      // Trimmed: no abuse contact or coordinates are kept.
      expect(cached.result).not.toContain('abuse@');
      // The free lookup is metered at $0.
      expect(dump.cost_ledger).toEqual([
        expect.objectContaining({ provider: 'ipapi', usd: 0, free: 1, stream: 'visits' }),
      ]);
    });
  }

  it('a business IP with no company domain and an ISP-generated PTR is unmatched and not stored', async () => {
    const { site } = seedVisits(ctx);
    const { pipeline, ptrCalls } = makePipeline(ctx);
    expect(await pipeline.processVisit(view(site, IP.businessGeneratedPtr))).toBe('unmatched');
    expect(ptrCalls).toEqual([IP.businessGeneratedPtr]);
    expect(storedCounts(ctx)).toEqual(EMPTY);
  });

  it('without an ipapi.is key, business-candidate traffic is unclassified and not stored', async () => {
    const { site } = seedVisits(ctx, { ipapiKey: false });
    const { pipeline, ipapiCalls } = makePipeline(ctx);
    expect(await pipeline.processVisit(view(site, IP.business))).toBe('unclassified');
    expect(ipapiCalls).toHaveLength(0);
    expect(storedCounts(ctx)).toEqual(EMPTY);
  });

  it('a suppressed company domain is dropped', async () => {
    const { site, workspaceId } = seedVisits(ctx);
    ctx.db
      .insert(suppressions)
      .values({
        id: 'sup_1',
        workspaceId,
        kind: 'domain',
        value: 'donotcall.com',
        reason: 'opt-out',
        createdAt: now,
      })
      .run();
    const { pipeline } = makePipeline(ctx);
    expect(await pipeline.processVisit(view(site, IP.businessSuppressed))).toBe('suppressed');
    const c = storedCounts(ctx);
    expect([c.visits, c.accounts, c.signals]).toEqual([0, 0, 0]);
  });

  it('the free tier is the cap: after 1,000 lookups a day, visits are unclassified', async () => {
    const { site, workspaceId } = seedVisits(ctx);
    const { pipeline, ipapiCalls } = makePipeline(ctx);
    ctx.db.$client
      .prepare(
        `INSERT INTO quota_usage (workspace_id, provider, period, used) VALUES (?, 'ipapi', ?, 1000)`,
      )
      .run(workspaceId, new Date(T0).toISOString().slice(0, 10));
    expect(await pipeline.processVisit(view(site, IP.business))).toBe('unclassified');
    expect(ipapiCalls).toHaveLength(0);
    expect(storedCounts(ctx).accounts).toBe(0);
  });
});

describe('collector pipeline: matched visits', () => {
  it('ipapi.is company.domain → account, visit, signals; later page views reuse the session', async () => {
    const { site } = seedVisits(ctx);
    const { pipeline, ipapiCalls } = makePipeline(ctx);
    expect(await pipeline.processVisit(view(site, IP.business, '/'))).toBe('matched');
    now += 30_000;
    expect(await pipeline.processVisit(view(site, IP.business, '/product'))).toBe('matched');
    now += 30_000;
    expect(await pipeline.processVisit(view(site, IP.business, '/pricing/'))).toBe('matched');
    now += 30_000;
    expect(await pipeline.processVisit(view(site, IP.business, '/pricing/enterprise'))).toBe(
      'matched',
    );
    expect(ipapiCalls).toHaveLength(1);

    const acc = ctx.db.select().from(accounts).get()!;
    const co = ctx.db.select().from(companies).where(eq(companies.id, acc.companyId)).get()!;
    expect(co).toMatchObject({
      domain: 'acme-robotics.com',
      name: 'Acme Robotics Inc',
      country: 'US',
    });
    expect(acc.firstSource).toBe('visits');

    const v = ctx.db.select().from(visits).all();
    expect(v.map((x) => x.path)).toEqual(['/', '/product', '/pricing/', '/pricing/enterprise']);
    expect(new Set(v.map((x) => x.sessionHash)).size).toBe(1);
    expect(v[0]).toMatchObject({ matchSource: 'provider', confidence: 0.8 });
    expect(JSON.stringify(v)).not.toContain(IP.business);

    // One visit signal per session, one per intent page (sub-paths count once).
    const sig = ctx.db.select().from(signals).all();
    expect(sig.map((s) => [s.kind, s.weight])).toEqual([
      ['visit', 1],
      ['pricing_view', 3],
    ]);
    expect(sig[1]!.evidenceUrl).toBe('https://example-saas.com/pricing/');
    expect(ctx.db.select().from(accounts).get()!.intentScore).toBeGreaterThan(0);

    // The company's /24 is in the IP map.
    expect(ctx.db.select().from(ipCompanies).all()).toEqual([
      expect.objectContaining({
        prefix: '12.1.1.0/24',
        companyDomain: 'acme-robotics.com',
        source: 'provider',
        wrong: false,
      }),
    ]);
    expect(counters()).toEqual({ matched: { sessions: 1, pageviews: 4 } });
  });

  it('a colleague in the same prefix matches from the IP map without a new lookup', async () => {
    const { site } = seedVisits(ctx);
    const { pipeline, ipapiCalls } = makePipeline(ctx);
    await pipeline.processVisit(view(site, IP.business));
    await pipeline.processVisit(view(site, IP.businessColleague));
    expect(ipapiCalls).toHaveLength(1);
    expect(ctx.db.select().from(accounts).all()).toHaveLength(1);
    expect(counters()).toEqual({ matched: { sessions: 2, pageviews: 2 } });
  });

  it('PTR fallback names the company when ipapi.is has no domain', async () => {
    const { site } = seedVisits(ctx);
    const { pipeline } = makePipeline(ctx);
    expect(await pipeline.processVisit(view(site, IP.businessPtr))).toBe('matched');
    const co = ctx.db.select().from(companies).get()!;
    expect(co.domain).toBe('northwind-traders.com');
    expect(ctx.db.select().from(visits).get()).toMatchObject({
      matchSource: 'ptr',
      confidence: 0.5,
    });
    expect(ctx.db.select().from(ipCompanies).get()!.prefix).toBe(`${IP.businessPtr}/32`);
  });

  it('IPv6 offices are mapped by /48 inside the company network', async () => {
    const { site } = seedVisits(ctx);
    const { pipeline } = makePipeline(ctx);
    expect(await pipeline.processVisit(view(site, IP.businessV6))).toBe('matched');
    expect(ctx.db.select().from(ipCompanies).get()!.prefix).toBe('2600:1f00:1::/48');
  });

  it('session hashes rotate daily and the old salt is deleted', async () => {
    const { site } = seedVisits(ctx);
    const { pipeline } = makePipeline(ctx);
    await pipeline.processVisit(view(site, IP.business));
    const day1 = ctx.db.select().from(dailySalts).all();
    now += 86_400_000;
    await pipeline.processVisit(view(site, IP.business));
    const day2 = ctx.db.select().from(dailySalts).all();
    expect(day1).toHaveLength(1);
    expect(day2).toHaveLength(1);
    expect(day2[0]!.day).not.toBe(day1[0]!.day);
    const hashes = ctx.db
      .select()
      .from(visits)
      .all()
      .map((v) => v.sessionHash);
    expect(hashes[0]).not.toBe(hashes[1]);
    // Two sessions → two visit signals.
    expect(
      ctx.db
        .select()
        .from(signals)
        .all()
        .filter((s) => s.kind === 'visit'),
    ).toHaveLength(2);
  });

  it('a new high-fit account queues the people + email job; a low-fit one does not', async () => {
    const { site, workspaceId } = seedVisits(ctx);
    approveOffer(ctx);
    ctx.db.$client
      .prepare(`UPDATE workspaces SET settings = json_set(settings, '$.fitThreshold', 40)`)
      .run();
    const { pipeline } = makePipeline(ctx);
    await pipeline.processVisit(view(site, IP.business));
    const acc = ctx.db.select().from(accounts).get()!;
    expect(acc.fitScore).toBeGreaterThanOrEqual(40);
    expect(ctx.db.select().from(jobs).all()).toEqual([
      expect.objectContaining({
        workspaceId,
        type: 'people.find',
        payload: { accountId: acc.id, emails: true, source: 'visits' },
      }),
    ]);
    // A second session of the same account doesn't queue again.
    now += 86_400_000;
    await pipeline.processVisit(view(site, IP.business));
    expect(ctx.db.select().from(jobs).all()).toHaveLength(1);

    ctx.db.$client
      .prepare(`UPDATE workspaces SET settings = json_set(settings, '$.fitThreshold', 101)`)
      .run();
    await pipeline.processVisit(view(site, IP.businessV6));
    expect(ctx.db.select().from(accounts).all()).toHaveLength(2);
    expect(ctx.db.select().from(jobs).all()).toHaveLength(1);
  });

  it('no people job without an approved offer or with the budget used up', async () => {
    const { site, workspaceId } = seedVisits(ctx);
    const { pipeline } = makePipeline(ctx);
    await pipeline.processVisit(view(site, IP.business));
    expect(ctx.db.select().from(jobs).all()).toHaveLength(0);

    approveOffer(ctx);
    ctx.db.$client
      .prepare(
        `UPDATE workspaces SET settings = json_set(settings, '$.fitThreshold', 0), monthly_budget_usd = 0`,
      )
      .run();
    await pipeline.processVisit(view(site, IP.businessV6));
    expect(
      ctx.db.select().from(accounts).where(eq(accounts.workspaceId, workspaceId)).all(),
    ).toHaveLength(2);
    expect(ctx.db.select().from(jobs).all()).toHaveLength(0);
  });
});

describe('collector pipeline: form identification', () => {
  it('maps the business prefix to the email domain for 90 days; visits then match with high confidence', async () => {
    const { site } = seedVisits(ctx);
    const { pipeline } = makePipeline(ctx);
    expect(
      await pipeline.processIdentify({
        site,
        ip: IP.businessPtr,
        userAgent: UA.chrome,
        emailDomain: 'Initech.com',
      }),
    ).toBe('mapped');
    const row = ctx.db.select().from(ipCompanies).get()!;
    expect(row).toMatchObject({
      prefix: '12.2.2.0/24',
      companyDomain: 'initech.com',
      source: 'form',
      confidence: 0.95,
      expiresAt: T0 + 90 * 86_400_000,
    });
    expect(ctx.db.select().from(signals).get()).toMatchObject({ kind: 'form_identify', weight: 5 });

    // Another visitor from the same office (ISP-generated PTR, unmatched before) now matches.
    expect(await pipeline.processVisit(view(site, IP.businessGeneratedPtr))).toBe('matched');
    expect(ctx.db.select().from(visits).get()).toMatchObject({
      matchSource: 'form',
      confidence: 0.95,
    });
  });

  it('ignores free-mail domains, non-US, bots and residential/mobile IPs, storing nothing', async () => {
    const { site } = seedVisits(ctx);
    const { pipeline } = makePipeline(ctx);
    const id = (ip: string, emailDomain: string, ua = UA.chrome) =>
      pipeline.processIdentify({ site, ip, userAgent: ua, emailDomain });
    expect(await id(IP.business, 'gmail.com')).toBe('free_mail');
    expect(await id(IP.business, 'yahoo.fr')).toBe('free_mail');
    expect(await id(IP.nonUs, 'initech.com')).toBe('non_us');
    expect(await id(IP.business, 'initech.com', UA.googlebot)).toBe('bot');
    expect(await id(IP.homeIsp, 'initech.com')).toBe('not_business');
    expect(await id(IP.mobileLocal, 'initech.com')).toBe('not_business');
    expect(await id(IP.vpn, 'initech.com')).toBe('not_business');
    expect(await id(IP.business, 'not a domain')).toBe('invalid');
    const c = storedCounts(ctx);
    expect([c.ipCompanies, c.accounts, c.signals, c.visits]).toEqual([0, 0, 0, 0]);
  });
});

// ------------------------------------------------------------------ HTTP layer

describe('collector HTTP', () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  function setup(opts: { perIp?: number } = {}) {
    const { site } = seedVisits(ctx);
    const { pipeline, ipapiCalls } = makePipeline(ctx);
    const c = buildCollector(ctx, pipeline, {
      logLevel: 'silent',
      rateLimits: { perIpPerMinute: opts.perIp ?? 60, perSitePerMinute: 1000 },
    });
    apps.push(c.app);
    return { ...c, site, ipapiCalls };
  }

  const headers = (ip: string, extra: Record<string, string> = {}) => ({
    'x-real-ip': ip,
    'user-agent': UA.chrome,
    origin: 'https://www.example-saas.com',
    ...extra,
  });

  it('serves p.js without cookies and with no storage APIs', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/p.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body).not.toMatch(/document\.cookie|localStorage|sessionStorage|indexedDB|canvas/);
    expect(res.body).toContain("credentials: 'omit'");
    expect(res.body).toContain('globalPrivacyControl');
  });

  it('accepts a text/plain beacon from the site and processes it in the background', async () => {
    const { app, queue } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/collect/v',
      headers: { ...headers(IP.business), 'content-type': 'text/plain' },
      payload: JSON.stringify({
        siteKey: SITE_KEY,
        path: '/pricing?email=x@y.com',
        referrer: 'https://news.ycombinator.com/item?id=1',
      }),
    });
    expect(res.statusCode).toBe(202);
    expect(res.headers['set-cookie']).toBeUndefined();
    await queue.drain();
    expect(ctx.db.select().from(visits).get()).toMatchObject({
      path: '/pricing',
      referrer: 'https://news.ycombinator.com/item',
    });
  });

  it('reads the client IP from X-Real-Ip only when the peer is the proxy', async () => {
    const { app, queue } = setup();
    // A public peer can't spoof the header: its own (non-US fixture) address is used.
    await app.inject({
      method: 'POST',
      url: '/collect/v',
      remoteAddress: IP.nonUs,
      headers: headers(IP.business),
      payload: { siteKey: SITE_KEY, path: '/' },
    });
    await queue.drain();
    expect(counters()).toEqual({ non_us: { sessions: 1, pageviews: 1 } });
  });

  it('checks Origin/Referer against the site domain', async () => {
    const { app, queue } = setup();
    const send = (h: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/collect/v',
        headers: h,
        payload: { siteKey: SITE_KEY, path: '/' },
      });
    expect((await send(headers(IP.business, { origin: 'https://evil.com' }))).statusCode).toBe(403);
    expect(
      (await send(headers(IP.business, { origin: 'https://notexample-saas.com' }))).statusCode,
    ).toBe(403);
    const noOrigin = { 'x-real-ip': IP.business, 'user-agent': UA.chrome };
    expect((await send(noOrigin)).statusCode).toBe(403);
    expect((await send({ ...noOrigin, referer: 'https://example-saas.com/x' })).statusCode).toBe(
      202,
    );
    await queue.drain();
  });

  it('rejects unknown site keys, bad bodies and bodies over 2 KB', async () => {
    const { app } = setup();
    const post = (payload: unknown) =>
      app.inject({
        method: 'POST',
        url: '/collect/v',
        headers: headers(IP.business),
        payload: payload as object,
      });
    expect((await post({ siteKey: 'site_unknown_00', path: '/' })).statusCode).toBe(404);
    expect((await post({ siteKey: SITE_KEY })).statusCode).toBe(400);
    expect((await post({ siteKey: SITE_KEY, path: '/', extra: 1 })).statusCode).toBe(400);
    expect(
      (await post({ siteKey: SITE_KEY, path: '/', referrer: 'x'.repeat(2100) })).statusCode,
    ).toBe(413);
  });

  it('rate-limits per IP and counts refused requests only in the aggregate', async () => {
    const { app, queue } = setup({ perIp: 2 });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/collect/v',
        headers: headers(IP.business),
        payload: { siteKey: SITE_KEY, path: `/${i}` },
      });
      codes.push(r.statusCode);
    }
    await queue.drain();
    expect(codes).toEqual([202, 202, 429, 429]);
    expect(counters().rate_limited).toEqual({ sessions: 0, pageviews: 2 });
    expect(ctx.db.select().from(visits).all()).toHaveLength(2);
  });

  it('serves the noscript pixel and records the page from the Referer', async () => {
    const { app, queue } = setup();
    const res = await app.inject({
      method: 'GET',
      url: `/collect/v.gif?s=${SITE_KEY}`,
      headers: {
        'x-real-ip': IP.business,
        'user-agent': UA.chrome,
        referer: 'https://example-saas.com/demo',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/gif');
    await queue.drain();
    expect(ctx.db.select().from(visits).get()!.path).toBe('/demo');
  });

  it('accepts /collect/identify with only an email domain', async () => {
    const { app, queue } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/collect/identify',
      headers: headers(IP.business),
      payload: { siteKey: SITE_KEY, emailDomain: 'acme-robotics.com' },
    });
    expect(res.statusCode).toBe(202);
    await queue.drain();
    expect(ctx.db.select().from(ipCompanies).get()).toMatchObject({ source: 'form' });
    const bad = await app.inject({
      method: 'POST',
      url: '/collect/identify',
      headers: headers(IP.business),
      payload: { siteKey: SITE_KEY, email: 'jane@acme-robotics.com' },
    });
    expect(bad.statusCode).toBe(400);
  });
});
