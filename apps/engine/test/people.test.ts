import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  accounts,
  companies,
  contacts,
  costLedger,
  fieldSources,
  jobs,
  signals,
} from '../src/db/schema.ts';
import { jobHandlers } from '../src/jobs/handlers.ts';
import { JobRunner } from '../src/jobs/queue.ts';
import { fakeLlm } from '../src/llm/fake.ts';
import type { LlmRequest } from '../src/llm/types.ts';
import { ownerName, parseOwners } from '../src/people/edgar.ts';
import { matchPersona, seniorityOf } from '../src/people/extract.ts';
import { detectBoards } from '../src/people/hiring.ts';
import {
  emailsOnPage,
  isRoleAddress,
  learnPattern,
  permutations,
  publishedFor,
  splitName,
} from '../src/people/names.ts';
import { icypeasVerdict } from '../src/providers/icypeas.ts';
import { reacherVerdict } from '../src/providers/reacher.ts';
import { writeCompanies } from '../src/universe/import.ts';
import { fakeHttp, fakeIcypeas, type Handler } from './fake-http.ts';
import { fakeWeb, type FakeResponse } from './fake-web.ts';
import { makeCtx, setupClient } from './helpers.ts';
import { approveOffer } from './offer-fixtures.ts';

const PERSONAS = [
  {
    title: 'VP Operations',
    seniority: 'VP',
    department: 'Operations',
    pains: ['slow shipping'],
    titleKeywords: ['operations', 'logistics'],
  },
  {
    title: 'Head of RevOps',
    seniority: 'Director',
    department: 'Revenue',
    pains: ['messy CRM'],
    titleKeywords: ['revops', 'revenue operations'],
  },
];

describe('names and patterns', () => {
  it('splits names, builds permutations and learns the pattern from published addresses', () => {
    expect(splitName('Dr. Jane Q. van Doe, PhD')).toEqual({
      first: 'jane',
      middle: ['q'],
      last: 'vandoe',
    });
    expect(splitName('José Núñez')).toEqual({ first: 'jose', middle: [], last: 'nunez' });
    expect(splitName('Madonna')).toBeNull();
    expect(permutations(splitName('Jane Doe')!, 'acme.com')).toEqual([
      'jane.doe@acme.com',
      'jane@acme.com',
      'jdoe@acme.com',
    ]);
    const published = ['info@acme.com', 'jane.doe@acme.com', 'bob.ray@acme.com'];
    expect(learnPattern(published, ['Jane Doe', 'Bob Ray', 'Al Smith'])).toEqual({
      pattern: 'first.last',
      examples: 2,
    });
    expect(learnPattern(['info@acme.com'], ['Jane Doe'])).toBeNull();
    expect(publishedFor(published, splitName('Jane Doe')!)).toBe('jane.doe@acme.com');
    expect(publishedFor(published, splitName('Al Smith')!)).toBeNull();
    expect(isRoleAddress('sales@acme.com')).toBe(true);
    expect(
      emailsOnPage(
        'Write to Jane.Doe@acme.com or x@gmail.com',
        [{ href: 'mailto:bob@eu.acme.com?subject=hi' }],
        'acme.com',
      ),
    ).toEqual(['jane.doe@acme.com', 'bob@eu.acme.com']);
  });

  it('matches titles to personas and seniority', () => {
    expect(matchPersona('Vice President of Operations', PERSONAS)).toBe('VP Operations');
    expect(matchPersona('Head of RevOps', PERSONAS)).toBe('Head of RevOps');
    expect(matchPersona('Software Engineer', PERSONAS)).toBeNull();
    expect(seniorityOf('Chief Financial Officer')).toBe('C-level');
    expect(seniorityOf('VP Sales')).toBe('VP');
    expect(seniorityOf('Director of Ops')).toBe('Director');
  });

  it('parses EDGAR owners (true/false and 1/0) and maps verifier answers', () => {
    const xml = `<ownershipDocument>
      <reportingOwner><reportingOwnerId><rptOwnerName>Newstead Jennifer</rptOwnerName></reportingOwnerId>
      <reportingOwnerRelationship><isDirector>false</isDirector><isOfficer>true</isOfficer><officerTitle>SVP, GC &amp; Gov't Affairs</officerTitle></reportingOwnerRelationship></reportingOwner>
      <reportingOwner><reportingOwnerId><rptOwnerName>Musk Elon R</rptOwnerName></reportingOwnerId>
      <reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>1</isOfficer><officerTitle>CEO</officerTitle></reportingOwnerRelationship></reportingOwner>
      <reportingOwner><reportingOwnerId><rptOwnerName>Board Only</rptOwnerName></reportingOwnerId>
      <reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>0</isOfficer></reportingOwnerRelationship></reportingOwner>
    </ownershipDocument>`;
    expect(parseOwners(xml, 'u')).toEqual([
      { name: 'Jennifer Newstead', title: "SVP, GC & Gov't Affairs", url: 'u', isDirector: false },
      { name: 'Elon R Musk', title: 'CEO', url: 'u', isDirector: true },
    ]);
    expect(ownerName('COOK TIMOTHY D')).toBe('Timothy D Cook');
    expect(reacherVerdict({ is_reachable: 'safe' })).toBe('valid');
    expect(reacherVerdict({ is_reachable: 'risky', smtp: { is_catch_all: true } })).toBe(
      'catch_all',
    );
    expect(reacherVerdict({ is_reachable: 'risky', smtp: { type: 'x', message: 'y' } })).toBe(
      'risky',
    );
    expect(reacherVerdict({ is_reachable: 'unknown' })).toBe('unknown');
    expect(icypeasVerdict({ status: 'FOUND', email: 'a', certainty: 'very_sure' })).toBe('valid');
    expect(icypeasVerdict({ status: 'FOUND', email: 'a', certainty: 'undeliverable' })).toBe(
      'invalid',
    );
    expect(icypeasVerdict({ status: 'NOT_FOUND', email: null, certainty: 'not_found' })).toBe(
      'unknown',
    );
    expect(
      detectBoards([
        { href: 'https://boards.greenhouse.io/acme/jobs/1' },
        { href: 'https://jobs.lever.co/acme' },
        { href: 'https://boards.greenhouse.io/embed/job_board?for=acme2' },
      ]),
    ).toEqual([
      { ats: 'greenhouse', token: 'acme' },
      { ats: 'lever', token: 'acme' },
    ]);
  });
});

// ---------------------------------------------------------------- jobs

const TEAM_PAGE = `<title>Our team</title>
<h2>Leadership</h2>
<p>Jane Doe — VP Operations. Reach her at <a href="mailto:jane.doe@acme.com">jane.doe@acme.com</a></p>
<p>Bob Ray, Head of RevOps</p>
<p>Ann Lee, Software Engineer</p>
<p>"Great product" — Carl Customer, BigCo</p>`;

function site(): Record<string, FakeResponse> {
  return {
    'https://acme.com/robots.txt': { body: 'User-agent: *\nAllow: /\n', type: 'text/plain' },
    'https://acme.com/': {
      body: '<title>Acme</title><p>Freight</p><a href="/team">Team</a><a href="/careers">Careers</a>',
    },
    'https://acme.com/sitemap.xml': {
      type: 'application/xml',
      body: '<urlset><url><loc>https://acme.com/about</loc></url><url><loc>https://acme.com/blog/x</loc></url></urlset>',
    },
    'https://acme.com/team': { body: TEAM_PAGE },
    'https://acme.com/about': {
      body: '<title>About</title><p>Founded 2001. Contact info@acme.com</p>',
    },
    'https://acme.com/careers': {
      body: '<a href="https://boards.greenhouse.io/acme">Open roles</a>',
    },
  };
}

const GREENHOUSE: Handler = (url) =>
  url === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs'
    ? {
        body: {
          jobs: [
            {
              title: 'Logistics Operations Manager',
              absolute_url: 'https://boards.greenhouse.io/acme/jobs/1',
              location: { name: 'Austin, TX' },
              first_published: '2026-11-01T00:00:00Z',
            },
            {
              title: 'Barista',
              absolute_url: 'https://boards.greenhouse.io/acme/jobs/2',
              location: { name: 'Austin' },
            },
          ],
        },
      }
    : undefined;

const EDGAR: Handler = (url, init) => {
  if (!/^https:\/\/(data|www)\.sec\.gov\//.test(url)) return undefined;
  if (init.headers?.['user-agent'] !== 'LeadEngine test admin@example.com') return { status: 403 };
  if (url === 'https://data.sec.gov/submissions/CIK0000000042.json')
    return {
      body: {
        filings: {
          recent: {
            form: ['10-K', '4'],
            accessionNumber: ['0000000042-26-000001', '0000000042-26-000002'],
            primaryDocument: ['x.htm', 'xslF345X06/form4.xml'],
          },
        },
      },
    };
  if (url === 'https://www.sec.gov/Archives/edgar/data/42/000000004226000002/form4.xml')
    return {
      body: '<ownershipDocument><reportingOwner><reportingOwnerId><rptOwnerName>Smith Al</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isOfficer>1</isOfficer><officerTitle>Chief Operations Officer</officerTitle></reportingOwnerRelationship></reportingOwner></ownershipDocument>',
    };
  return undefined;
};

async function setup(
  opts: { reacher?: boolean; icypeas?: boolean; extra?: Handler; sec?: boolean } = {},
) {
  const clock = { t: Date.UTC(2026, 10, 15, 12) };
  const ctx = makeCtx(
    {
      secUserAgent: opts.sec === false ? null : 'LeadEngine test admin@example.com',
      reacher: {
        enabled: !!opts.reacher,
        url: 'http://reacher:8080',
        secret: 's3cret',
        domainIntervalMs: 60_000,
      },
    },
    () => clock.t,
  );
  const c = await setupClient(ctx);
  approveOffer(ctx, {}, { personas: PERSONAS });
  ctx.db.transaction((tx) =>
    writeCompanies(
      tx,
      'pdl',
      [
        {
          domain: 'acme.com',
          name: 'Acme',
          state: 'TX',
          city: null,
          industry: 'logistics',
          naics: null,
          sizeRange: '51-200',
          foundedYear: 2001,
        },
      ],
      clock.t,
      { inserted: 0, updated: 0, dropped: {} },
    ),
  );
  ctx.db.update(companies).set({ cik: '0000000042' }).where(eq(companies.domain, 'acme.com')).run();
  const acc = await c.send('POST', '/api/v1/accounts', { domain: 'acme.com', name: 'Acme' });
  if (opts.icypeas) {
    expect(
      (await c.send('PUT', '/api/v1/provider-keys/icypeas', { key: 'icy-test-key' })).status,
    ).toBe(200);
  }
  const web = fakeWeb(site(), { now: () => clock.t });
  const llm = fakeLlm((r: LlmRequest) => ({
    people: [
      {
        name: 'Jane Doe',
        title: 'VP Operations',
        sourceUrl: 'https://acme.com/team',
        persona: 'VP Operations',
      },
      {
        name: 'Bob Ray',
        title: 'Head of RevOps',
        sourceUrl: 'https://acme.com/team',
        persona: 'Made Up Persona',
      },
      {
        name: 'Ann Lee',
        title: 'Software Engineer',
        sourceUrl: 'https://acme.com/team',
        persona: null,
      },
      // Not on the page: dropped.
      { name: 'Ghost Person', title: 'CEO', sourceUrl: 'https://acme.com/team', persona: null },
      {
        name: 'Jane Doe',
        title: 'VP Operations',
        sourceUrl: 'https://acme.com/team',
        persona: null,
      },
    ].filter(() => r.prompt.includes('Our team')),
  }));
  const reacherCalls: string[] = [];
  const REACHER: Handler = (url, init) => {
    if (url !== 'http://reacher:8080/v1/check_email') return undefined;
    if (init.headers?.['x-reacher-secret'] !== 's3cret') return { status: 401 };
    const email = JSON.parse(init.body!).to_email as string;
    reacherCalls.push(email);
    if (email === 'jane.doe@acme.com')
      return { body: { is_reachable: 'safe', smtp: { is_catch_all: false } } };
    if (email.startsWith('bob'))
      return { body: { is_reachable: 'risky', smtp: { is_catch_all: true } } };
    return { body: { is_reachable: 'invalid', smtp: { is_catch_all: false } } };
  };
  const icy = fakeIcypeas({
    verify: (e) =>
      e === 'jane.doe@acme.com'
        ? 'ultra_sure'
        : e.startsWith('bob')
          ? 'not_found'
          : 'undeliverable',
    find: (f, l, d) => (f === 'Bob' ? { email: `bob@${d}`, certainty: 'very_sure' } : null),
  });
  const http = fakeHttp(
    (u, i) => opts.extra?.(u, i) ?? GREENHOUSE(u, i) ?? EDGAR(u, i) ?? REACHER(u, i) ?? icy(u, i),
  );
  Object.assign(ctx, { llm, crawler: web.crawler, http: http.http, sleep: async () => {} });
  const runner = new JobRunner(ctx, jobHandlers(ctx));
  const drain = async () => {
    for (let i = 0; i < 100; i++) {
      clock.t += 1;
      if ((await runner.tick()) === 0) return;
    }
    throw new Error('jobs did not finish');
  };
  return { ctx, c, clock, accountId: acc.body.id as string, http, drain, reacherCalls, runner };
}

describe('find people', () => {
  it('extracts people from team pages, adds EDGAR officers, learns the pattern and the hiring signal', async () => {
    const { ctx, c, accountId, drain, http } = await setup();
    const est = await c.get(`/api/v1/accounts/${accountId}/enrichment`);
    expect(est.status).toBe(200);
    expect(est.body.people.usd).toBeGreaterThan(0);
    expect(est.body.email).toMatchObject({
      contacts: 0,
      verifier: null,
      finder: null,
      provider: 'none',
    });

    expect((await c.send('POST', `/api/v1/accounts/${accountId}/people`, {})).status).toBe(202);
    expect((await c.send('POST', `/api/v1/accounts/${accountId}/people`, {})).body.error).toBe(
      'already_running',
    );
    await drain();

    const job = ctx.db.select().from(jobs).where(eq(jobs.type, 'people.find')).get()!;
    expect(job.state).toBe('done');
    expect(job.result).toMatchObject({
      people: 3,
      officers: 1,
      contactsCreated: 4,
      pattern: 'first.last',
      hiring: 1,
    });

    const list = ctx.db.select().from(contacts).where(eq(contacts.accountId, accountId)).all();
    const byName = Object.fromEntries(list.map((x) => [x.fullName, x]));
    expect(Object.keys(byName).sort()).toEqual(['Al Smith', 'Ann Lee', 'Bob Ray', 'Jane Doe']);
    expect(byName['Jane Doe']).toMatchObject({
      title: 'VP Operations',
      personaMatch: 'VP Operations',
      seniority: 'VP',
      department: 'Operations',
      email: 'jane.doe@acme.com',
      emailStatus: 'unknown',
    });
    // An invalid LLM persona falls back to the keyword match.
    expect(byName['Bob Ray']!.personaMatch).toBe('Head of RevOps');
    expect(byName['Ann Lee']!.personaMatch).toBeNull();
    expect(byName['Al Smith']).toMatchObject({
      title: 'Chief Operations Officer',
      personaMatch: 'VP Operations',
    });

    // Every filled contact field has a source.
    const fields = [
      'fullName',
      'title',
      'email',
      'personaMatch',
      'seniority',
      'department',
    ] as const;
    for (const ct of list) {
      const src = ctx.db.select().from(fieldSources).where(eq(fieldSources.entityId, ct.id)).all();
      for (const f of fields)
        if (ct[f])
          expect(
            src.map((s) => s.field),
            `${ct.fullName}.${f}`,
          ).toContain(f);
    }
    const janeName = ctx.db
      .select()
      .from(fieldSources)
      .where(eq(fieldSources.entityId, byName['Jane Doe']!.id))
      .all()
      .find((s) => s.field === 'fullName')!;
    expect(janeName).toMatchObject({ source: 'website', url: 'https://acme.com/team' });
    const alName = ctx.db
      .select()
      .from(fieldSources)
      .where(eq(fieldSources.entityId, byName['Al Smith']!.id))
      .all()
      .find((s) => s.field === 'fullName')!;
    expect(alName.source).toBe('sec-edgar');

    expect(
      ctx.db.select().from(companies).where(eq(companies.domain, 'acme.com')).get()!.emailPattern,
    ).toBe('first.last');
    const hiring = ctx.db.select().from(signals).where(eq(signals.kind, 'hiring')).all();
    expect(hiring).toHaveLength(1);
    expect(hiring[0]).toMatchObject({
      evidenceUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      stream: 'personas',
    });
    expect(
      ctx.db.select().from(accounts).where(eq(accounts.id, accountId)).get()!.intentScore,
    ).toBeGreaterThan(0);
    // EDGAR was called with the declared User-Agent; the LLM call is metered on the account.
    expect(http.calls.some((x) => x.url.startsWith('https://data.sec.gov/'))).toBe(true);
    const led = ctx.db.select().from(costLedger).all();
    expect(led).toHaveLength(1);
    expect(led[0]).toMatchObject({ operation: 'llm', entityType: 'account', entityId: accountId });
  });
});

describe('find email', () => {
  it('Icypeas (Reacher off): verifies published and pattern addresses, finds only for unknowns', async () => {
    const { ctx, c, accountId, drain, http } = await setup({ icypeas: true });
    await c.send('POST', `/api/v1/accounts/${accountId}/people`, { emails: true });
    await drain();
    const list = ctx.db.select().from(contacts).where(eq(contacts.accountId, accountId)).all();
    const by = Object.fromEntries(list.map((x) => [x.fullName, x]));
    // Published + very sure → verified.
    expect(by['Jane Doe']).toMatchObject({ email: 'jane.doe@acme.com', emailStatus: 'verified' });
    // Pattern bob.ray@ → not_found (catch-all or unknown) → finder found bob@ very sure.
    expect(by['Bob Ray']).toMatchObject({ email: 'bob@acme.com', emailStatus: 'verified' });
    // Pattern address undeliverable → invalid, no finder call (spec: only catch-all/unknown).
    expect(by['Ann Lee']!.email).toBeNull();
    const searches = http.calls.filter((x) => x.url.endsWith('/email-search'));
    expect(searches.map((s) => JSON.parse(s.body!).firstname)).toEqual(['Bob']);
    expect(searches.every((s) => !('linkedin' in JSON.parse(s.body!)))).toBe(true);
    // Raw key, no Bearer.
    expect(searches[0]!.headers.authorization).toBe('icy-test-key');
    // Ledger: verifications 0.1 credit each, the found search 1 credit, linked to contacts.
    const led = ctx.db.select().from(costLedger).where(eq(costLedger.provider, 'icypeas')).all();
    expect(
      led
        .filter((l) => l.operation === 'verifyEmail')
        .every((l) => Math.abs(l.usd - 0.0019) < 1e-9),
    ).toBe(true);
    expect(led.filter((l) => l.operation === 'findEmail').map((l) => l.usd)).toEqual([0.019]);
    expect(led.every((l) => l.entityType === 'contact')).toBe(true);
    const bobSrc = ctx.db
      .select()
      .from(fieldSources)
      .where(eq(fieldSources.entityId, by['Bob Ray']!.id))
      .all();
    expect(bobSrc.find((s) => s.field === 'email')!.source).toBe('icypeas');
    expect(bobSrc.find((s) => s.field === 'emailStatus')!.source).toBe('icypeas');
  });

  it('Reacher (flag on): maps safe/catch-all, throttles per domain, sends the secret', async () => {
    const { ctx, c, accountId, drain, clock, reacherCalls, runner } = await setup({
      reacher: true,
    });
    await c.send('POST', `/api/v1/accounts/${accountId}/people`, {});
    await drain();
    expect((await c.send('POST', `/api/v1/accounts/${accountId}/emails`, {})).status).toBe(202);
    await drain();
    // First check ran, the next one waits a minute for the same domain.
    expect(reacherCalls).toHaveLength(1);
    const job = ctx.db.select().from(jobs).where(eq(jobs.type, 'email.find')).get()!;
    expect(job.state).toBe('queued');
    expect(job.runAt).toBeGreaterThan(clock.t + 50_000);
    for (let i = 0; i < 10; i++) {
      clock.t += 61_000;
      await runner.tick();
    }
    const by = Object.fromEntries(
      ctx.db
        .select()
        .from(contacts)
        .where(eq(contacts.accountId, accountId))
        .all()
        .map((x) => [x.fullName, x]),
    );
    expect(by['Jane Doe']).toMatchObject({ emailStatus: 'verified' });
    expect(by['Bob Ray']).toMatchObject({ email: 'bob.ray@acme.com', emailStatus: 'catch_all' });
    expect(by['Al Smith']!.email).toBeNull(); // pattern address invalid
    // Reacher calls are free and never touch the budget.
    const led = ctx.db.select().from(costLedger).where(eq(costLedger.provider, 'reacher')).all();
    expect(led.length).toBeGreaterThan(0);
    expect(led.every((l) => l.usd === 0 && l.free)).toBe(true);
    expect(ctx.db.select().from(jobs).where(eq(jobs.type, 'email.find')).get()!.state).toBe('done');
  });

  it('never verifies suppressed addresses and treats a rejected Icypeas key as a permanent failure', async () => {
    const { ctx, c, accountId, drain } = await setup({
      icypeas: true,
      extra: (url) =>
        url.includes('icypeas')
          ? { status: 401, body: { code: 'user_not_found_error' } }
          : undefined,
    });
    await c.send('POST', '/api/v1/suppressions', { kind: 'email', value: 'jane.doe@acme.com' });
    await c.send('POST', `/api/v1/accounts/${accountId}/people`, { emails: true });
    await drain();
    const jane = ctx.db.select().from(contacts).where(eq(contacts.fullName, 'Jane Doe')).get()!;
    expect(jane.email).toBeNull();
    const job = ctx.db.select().from(jobs).where(eq(jobs.type, 'email.find')).get()!;
    expect(job).toMatchObject({
      state: 'failed',
      lastError: 'Icypeas rejected the API key',
      attempts: 1,
    });
    // The suppressed published address never reached a verifier.
    expect(
      ctx.db.select().from(costLedger).where(eq(costLedger.provider, 'icypeas')).all(),
    ).toEqual([]);
  });
});
