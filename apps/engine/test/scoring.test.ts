import { describe, expect, it } from 'vitest';
import { fitScore, intentScore, parseRange, priorityScore, type Icp } from '../src/crm/scoring.ts';
import { signals } from '../src/db/schema.ts';
import { newId } from '../src/ids.ts';
import { ACCEPT_ALL, draft, llmDraft } from './offer.test.ts';
import { makeCtx, setupClient } from './helpers.ts';

const icp = draft().icp as Icp;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 9);

const company = (o: object = {}) => ({
  name: 'Acme',
  industry: 'Logistics',
  naics: null,
  sizeRange: '51-200',
  state: 'CA',
  tech: ['Salesforce'],
  ...o,
});

describe('fit', () => {
  it('scores a perfect match 100 with reasons', () => {
    const r = fitScore(company(), icp);
    expect(r.score).toBe(100);
    expect(r.reasons).toHaveLength(3);
    expect(r.reasons[0]).toMatch(/Industry matches/);
  });

  it('penalises mismatches and gives half credit for unknowns', () => {
    expect(fitScore(company({ state: 'NY' }), icp).score).toBe(83); // 75 of 90 rule points
    expect(fitScore(company({ sizeRange: '5000+' }), icp).reasons).toContain(
      'Size 5000+ is outside 51-500',
    );
    const unknown = fitScore(
      company({ industry: null, sizeRange: null, state: null, tech: [] }),
      icp,
    );
    expect(unknown.score).toBe(50);
    expect(
      fitScore(company({ industry: 'Retail', sizeRange: '1-10', state: 'NY', tech: [] }), icp)
        .score,
    ).toBeLessThan(20);
  });

  it('matches NAICS prefixes', () => {
    expect(fitScore(company({ industry: null, naics: '484110' }), icp).reasons[0]).toMatch(
      /NAICS 484110/,
    );
  });

  it('applies excludes and avoided technology', () => {
    expect(fitScore(company({ name: 'State Government Logistics' }), icp)).toEqual({
      score: 0,
      reasons: ['Excluded by ICP rule "government"'],
    });
    const sap = fitScore(company({ tech: ['Salesforce', 'SAP'] }), icp);
    expect(sap.score).toBe(75);
    expect(sap.reasons.join()).toMatch(/avoids/);
  });

  it('averages with the LLM homepage fit', () => {
    const r = fitScore(company(), icp, { score: 40, reasons: ['Sells to consumers'] });
    expect(r.score).toBe(70);
    expect(r.reasons[0]).toBe('Website fit 40: Sells to consumers');
  });

  it('parses size ranges', () => {
    expect(parseRange('11-50')).toEqual([11, 50]);
    expect(parseRange('5,001 to 10,000')).toEqual([5001, 10000]);
    expect(parseRange('1000+')).toEqual([1000, Infinity]);
    expect(parseRange('1k-5k')).toEqual([1000, 5000]);
    expect(parseRange(null)).toBeNull();
  });
});

describe('intent', () => {
  const sig = (o: object) => ({
    stream: 'visits',
    kind: 'visit',
    weight: 5,
    occurredAt: NOW,
    expiresAt: null,
    ...o,
  });

  it('decays with stream half-lives', () => {
    const fresh = intentScore([sig({})], NOW).score;
    const visit14 = intentScore([sig({ occurredAt: NOW - 14 * DAY })], NOW).score;
    const thread7 = intentScore(
      [sig({ stream: 'conversations', kind: 'thread', occurredAt: NOW - 7 * DAY })],
      NOW,
    ).score;
    const hiring30 = intentScore(
      [sig({ stream: 'personas', kind: 'hiring', occurredAt: NOW - 30 * DAY })],
      NOW,
    ).score;
    expect(fresh).toBe(39); // 100·(1−e^(−5/10))
    expect(visit14).toBe(22); // half the weight
    expect(thread7).toBe(visit14);
    expect(hiring30).toBe(visit14);
  });

  it('is capped at 100, ignores fit and expired signals, and explains itself', () => {
    const many = Array.from({ length: 50 }, () => sig({ kind: 'pricing_view' }));
    expect(intentScore(many, NOW).score).toBe(100);
    expect(
      intentScore([sig({ kind: 'fit', weight: 100 }), sig({ expiresAt: NOW - 1 })], NOW).score,
    ).toBe(0);
    const r = intentScore(
      [sig({ kind: 'pricing_view', weight: 8 }), sig({ weight: 1, occurredAt: NOW - 3 * DAY })],
      NOW,
    );
    expect(r.reasons[0]).toBe('pricing view (visits) today, +8.0');
    expect(r.reasons[1]).toMatch(/visit \(visits\) 3d ago/);
  });
});

describe('priority', () => {
  it('weights fit and intent', () => {
    expect(priorityScore(80, 50)).toBe(68);
    expect(priorityScore(null, 50)).toBe(20);
    expect(priorityScore(80, 50, { fit: 0.5, intent: 0.5 })).toBe(65);
  });
});

describe('stored scores', () => {
  it('rescores accounts when an offer version is approved, and stores reasons', async () => {
    const { JobRunner } = await import('../src/jobs/queue.ts');
    const { jobHandlers } = await import('../src/jobs/handlers.ts');
    const { fakeLlm } = await import('../src/llm/fake.ts');
    const { fakeWeb } = await import('./fake-web.ts');
    const ctx = makeCtx({}, () => NOW);
    Object.assign(ctx, {
      llm: fakeLlm(() => llmDraft()),
      crawler: fakeWeb({ 'https://acme.com/': { body: '<title>Acme</title>' } }).crawler,
    });
    const c = await setupClient(ctx);
    const acc = await c.send('POST', '/api/v1/accounts', {
      domain: 'fastfreight.com',
      name: 'Fast Freight',
      country: 'US',
      state: 'TX',
      industry: 'Logistics',
      sizeRange: '51-200',
    });
    let detail = (await c.get(`/api/v1/accounts/${acc.body.id}`)).body;
    expect(detail.account.fitScore).toBeNull();
    expect(detail.account.scoreReasons.fit).toEqual(['No approved offer profile yet']);

    ctx.db
      .insert(signals)
      .values({
        id: newId('sig'),
        workspaceId: detail.account.workspaceId,
        accountId: acc.body.id,
        stream: 'visits',
        kind: 'pricing_view',
        weight: 8,
        occurredAt: NOW - DAY,
        payload: { path: '/pricing' },
      })
      .run();
    const offer = await c.send('POST', '/api/v1/offers', { websiteUrl: 'acme.com' });
    await new JobRunner(ctx, jobHandlers(ctx)).tick();
    await c.send('PUT', `/api/v1/offers/${offer.body.id}/versions/1`, {
      data: draft(),
      review: ACCEPT_ALL,
    });
    expect(
      (await c.send('POST', `/api/v1/offers/${offer.body.id}/versions/1/approve`)).body.rescored,
    ).toBe(1);

    detail = (await c.get(`/api/v1/accounts/${acc.body.id}`)).body;
    expect(detail.account.fitScore).toBe(92); // tech unknown: 82.5 of 90 rule points
    expect(detail.account.intentScore).toBeGreaterThan(40);
    expect(detail.account.priority).toBeCloseTo(0.6 * 92 + 0.4 * detail.account.intentScore, 0);
    expect(detail.account.scoreReasons.fit[0]).toMatch(/Industry matches/);
    expect(detail.account.scoreReasons.intent[0]).toMatch(/pricing view/);
  });
});
