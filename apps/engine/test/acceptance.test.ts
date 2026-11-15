/**
 * Phase 2 acceptance (SPEC §11) with fixtures, no network: 500 candidates → fit-scored
 * accounts with reasons → people from team pages → emails with statuses, spend inside a $20
 * test budget, and a source on every contact field.
 */
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  accounts,
  companies,
  contacts,
  costLedger,
  fieldSources,
  jobs,
  personaRuns,
  workspaces,
} from '../src/db/schema.ts';
import { jobHandlers } from '../src/jobs/handlers.ts';
import { JobRunner } from '../src/jobs/queue.ts';
import { fakeLlm } from '../src/llm/fake.ts';
import type { LlmRequest } from '../src/llm/types.ts';
import { writeCompanies } from '../src/universe/import.ts';
import type { UniverseRow } from '../src/universe/normalize.ts';
import { fakeHttp, fakeIcypeas } from './fake-http.ts';
import { fakeWeb, type FakeResponse } from './fake-web.ts';
import { makeCtx, setupClient } from './helpers.ts';
import { approveOffer } from './offer-fixtures.ts';

const N = 600;
const FIRST = ['Jane', 'Bob', 'Maria', 'Wei', 'Omar', 'Lena', 'Raj', 'Sara'];
const LAST = ['Doe', 'Ray', 'Garcia', 'Chen', 'Haddad', 'Novak', 'Patel', 'Kim'];

const isBakery = (i: number) => i % 4 === 0;
function people(i: number) {
  const f = (k: number) => FIRST[(i + k) % FIRST.length]!;
  const l = (k: number) => LAST[(i * 3 + k) % LAST.length]!;
  return [
    { name: `${f(0)} ${l(0)}`, title: 'VP Operations' },
    { name: `${f(1)} ${l(1)}`, title: 'Head of RevOps' },
    { name: `${f(2)} ${l(2)}`, title: 'Software Engineer' },
  ];
}

function fixtureWeb(): Record<string, FakeResponse> {
  const pages: Record<string, FakeResponse> = {};
  for (let i = 1; i <= N; i++) {
    const d = `https://co${i}.com`;
    pages[`${d}/robots.txt`] = { body: 'User-agent: *\nAllow: /\n', type: 'text/plain' };
    pages[`${d}/`] = {
      body: isBakery(i)
        ? `<title>Co ${i}</title><p>Fresh bread daily.</p>`
        : `<title>Co ${i}</title><p>We move freight for retailers across the US.</p><a href="/team">Team</a>`,
    };
    if (!isBakery(i)) {
      const ps = people(i);
      const p0 = ps[0]!.name.toLowerCase().split(' ');
      // Every other company publishes one personal address (pattern first.last).
      const mail = i % 2 ? `<a href="mailto:${p0[0]}.${p0[1]}@co${i}.com">Email</a>` : '';
      pages[`${d}/team`] = {
        body: `<title>Our team</title>${ps.map((p) => `<p>${p.name}, ${p.title}</p>`).join('')}${mail}<p>Contact: info@co${i}.com</p>`,
      };
    }
  }
  return pages;
}

describe('Phase 2 acceptance', () => {
  it('500 candidates → accounts with reasons → people → emails, inside $20, every field sourced', async () => {
    const clock = { t: Date.UTC(2026, 10, 15, 12) };
    const ctx = makeCtx({}, () => clock.t);
    const c = await setupClient(ctx);
    const ws = ctx.db.select().from(workspaces).get()!;
    // The $20 test budget.
    ctx.db.update(workspaces).set({ monthlyBudgetUsd: 20 }).where(eq(workspaces.id, ws.id)).run();
    approveOffer(
      ctx,
      {
        industries: ['Logistics'],
        naics: [],
        employeeRange: '11-500',
        states: [],
        techUses: [],
        techAvoids: [],
        exclude: [],
      },
      {
        personas: [
          {
            title: 'VP Operations',
            seniority: 'VP',
            department: 'Operations',
            pains: ['slow shipping'],
            titleKeywords: ['operations'],
          },
          {
            title: 'Head of RevOps',
            seniority: 'Director',
            department: 'Revenue',
            pains: ['messy CRM'],
            titleKeywords: ['revops'],
          },
        ],
      },
    );
    const rows: UniverseRow[] = Array.from({ length: N }, (_, k) => ({
      domain: `co${k + 1}.com`,
      name: `Co ${k + 1}`,
      state: ['TX', 'CA', 'NY', 'IL'][k % 4]!,
      city: null,
      industry: 'logistics and supply chain',
      naics: null,
      sizeRange: '51-200',
      foundedYear: 2000 + (k % 20),
    }));
    ctx.db.transaction((tx) =>
      writeCompanies(tx, 'pdl', rows, clock.t, { inserted: 0, updated: 0, dropped: {} }),
    );
    expect(
      (await c.send('PUT', '/api/v1/provider-keys/icypeas', { key: 'icy-test-key' })).status,
    ).toBe(200);

    // Fakes: the LLM reads the page it is given; Icypeas answers by address.
    const llm = fakeLlm(
      (r: LlmRequest) => {
        if (r.system.startsWith('You qualify')) {
          const fits = r.prompt.includes('move freight');
          return {
            fit: fits ? 85 : 10,
            reasons: [fits ? 'Moves freight for retailers' : 'A bakery'],
            evidence: fits ? 'We move freight for retailers across the US.' : '',
          };
        }
        const src = /source="([^"]+)"/.exec(r.prompt)?.[1] ?? '';
        const names = [...r.prompt.matchAll(/([A-Z][a-z]+ [A-Z][a-z]+), ([A-Za-z ]+?)$/gm)];
        return {
          people: names.map((m) => ({
            name: m[1]!,
            title: m[2]!.trim(),
            sourceUrl: src,
            persona: m[2]!.includes('VP Operations') ? 'VP Operations' : null,
          })),
        };
      },
      { usd: 0.001 },
    );
    const hash = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
    const icy = fakeIcypeas({
      verify: (e) =>
        ['very_sure', 'very_sure', 'not_found', 'undeliverable', 'probable'][hash(e) % 5]!,
      find: (f, l, d) =>
        hash(f + l + d) % 2
          ? { email: `${f[0]!.toLowerCase()}${l.toLowerCase()}@${d}`, certainty: 'ultra_sure' }
          : null,
    });
    const http = fakeHttp((u, i) => icy(u, i));
    const web = fakeWeb(fixtureWeb(), { now: () => clock.t });
    Object.assign(ctx, {
      llm,
      crawler: web.crawler,
      http: http.http,
      sleep: async () => {},
      tech: { unavailable: async () => 'not installed', detect: async () => new Map() },
    });
    const runner = new JobRunner(ctx, jobHandlers(ctx));

    const est = await c.send('POST', '/api/v1/persona/estimate', { limit: 500, people: true });
    expect(est.body).toMatchObject({ candidates: 500 });
    const run = await c.send('POST', '/api/v1/persona/runs', { limit: 500, people: true });
    expect(run.status).toBe(201);
    for (let i = 0; i < 2000; i++) {
      clock.t += 1;
      if ((await runner.tick(50)) === 0) break;
    }

    // Every job finished.
    const states = ctx.db
      .select({ type: jobs.type, state: jobs.state, n: sql<number>`count(*)` })
      .from(jobs)
      .groupBy(jobs.type, jobs.state)
      .all();
    expect(states.filter((s) => s.state !== 'done')).toEqual([]);

    // 500 candidates → fit-scored accounts with reasons.
    const r = ctx.db.select().from(personaRuns).get()!;
    expect(r.counts).toMatchObject({ candidates: 500, scored: 500 });
    const accs = ctx.db.select().from(accounts).all();
    expect(accs.length).toBe(375); // the bakeries (every 4th) stay below the threshold
    for (const a of accs) {
      expect(a.fitScore!).toBeGreaterThanOrEqual(60);
      expect(a.scoreReasons!.fit[0]).toMatch(/^Website fit 85: Moves freight/);
    }

    // People from team pages, with personas.
    const cts = ctx.db.select().from(contacts).all();
    expect(cts.length).toBe(375 * 3);
    expect(cts.filter((x) => x.personaMatch).length).toBe(375 * 2);

    // Emails with statuses.
    const statuses = new Map<string, number>();
    for (const x of cts)
      if (x.emailStatus) statuses.set(x.emailStatus, (statuses.get(x.emailStatus) ?? 0) + 1);
    expect([...statuses.keys()].sort()).toEqual(
      expect.arrayContaining(['pattern_verified', 'risky', 'verified']),
    );
    const withEmail = cts.filter((x) => x.email).length;
    expect(withEmail).toBeGreaterThan(cts.length / 3);

    // Spend inside the $20 test budget, every charge linked to a record.
    const spent = ctx.db
      .select({ usd: sql<number>`sum(${costLedger.usd})` })
      .from(costLedger)
      .get()!.usd;
    expect(spent).toBeLessThanOrEqual(20);
    expect(
      ctx.db
        .select()
        .from(costLedger)
        .all()
        .every((l) => l.entityType && l.entityId),
    ).toBe(true);

    // Every contact field carries a source.
    const srcs = ctx.db.select().from(fieldSources).where(eq(fieldSources.entity, 'contact')).all();
    const by = new Map<string, Set<string>>();
    for (const s of srcs) by.set(s.entityId, (by.get(s.entityId) ?? new Set()).add(s.field));
    const FIELDS = [
      'fullName',
      'title',
      'email',
      'emailStatus',
      'personaMatch',
      'seniority',
      'department',
    ] as const;
    for (const x of cts)
      for (const f of FIELDS)
        if (x[f]) expect(by.get(x.id)?.has(f), `${x.fullName}.${f}`).toBe(true);

    // No LinkedIn-derived data anywhere.
    const dump = JSON.stringify([cts, ctx.db.select().from(companies).all()]);
    expect(dump).not.toMatch(/linkedin/i);

    // Summary for the PR.
    console.log(
      JSON.stringify({
        accounts: accs.length,
        contacts: cts.length,
        withEmail,
        statuses: Object.fromEntries(statuses),
        spentUsd: Number(spent.toFixed(4)),
        llmCalls: llm.requests.length,
      }),
    );
  }, 120_000);
});
