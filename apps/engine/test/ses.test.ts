import { helpFor, KEYED_PROVIDERS, PROVIDER_HELP } from '@le/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { contacts, costLedger, fieldSources } from '../src/db/schema.ts';
import { ProviderKeyMissingError } from '../src/providers/errors.ts';
import { parseSesKey, SES_VALIDATION_USD, sesVerdict } from '../src/providers/ses.ts';
import { fakeHttp, fakeIcypeas, type Handler } from './fake-http.ts';
import { makeCtx, setupClient } from './helpers.ts';
import { approveOffer } from './offer-fixtures.ts';
import { JobRunner } from '../src/jobs/queue.ts';
import { jobHandlers } from '../src/jobs/handlers.ts';

const KEY = JSON.stringify({
  accessKeyId: 'AKIAEXAMPLEEXAMPLE12',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
});

const ins = (isValid: string, ev: Record<string, string> = {}) => ({
  MailboxValidation: {
    IsValid: { ConfidenceVerdict: isValid },
    Evaluations: Object.fromEntries(
      Object.entries(ev).map(([k, v]) => [k, { ConfidenceVerdict: v }]),
    ),
  },
});

describe('Amazon SES Email Validation', () => {
  it('maps SES confidence verdicts onto ours (no catch-all signal)', () => {
    expect(sesVerdict(ins('HIGH', { MailboxExists: 'HIGH' }) as any)).toBe('valid');
    expect(sesVerdict(ins('HIGH', { IsRoleAddress: 'HIGH' }) as any)).toBe('risky');
    expect(sesVerdict(ins('HIGH', { IsDisposable: 'HIGH' }) as any)).toBe('risky');
    expect(sesVerdict(ins('MEDIUM') as any)).toBe('unknown');
    expect(sesVerdict(ins('LOW') as any)).toBe('invalid');
    expect(sesVerdict(ins('HIGH', { MailboxExists: 'LOW' }) as any)).toBe('invalid');
    expect(sesVerdict(ins('HIGH', { HasValidDnsRecords: 'LOW' }) as any)).toBe('invalid');
    expect(sesVerdict({} as any)).toBe('unknown');
  });

  it('accepts only well-formed BYO credentials', async () => {
    expect(parseSesKey(KEY)).toMatchObject({ region: 'us-east-1' });
    expect(parseSesKey('AKIA...')).toBeNull();
    expect(
      parseSesKey(
        JSON.stringify({
          accessKeyId: 'AKIAEXAMPLEEXAMPLE12',
          secretAccessKey: 'x'.repeat(40),
          region: 'mars',
        }),
      ),
    ).toBeNull();
    const c = await setupClient();
    expect(
      (await c.send('PUT', '/api/v1/provider-keys/aws-ses', { key: 'not-json-at-all' })).body.error,
    ).toBe('invalid_key');
    expect((await c.send('PUT', '/api/v1/provider-keys/aws-ses', { key: KEY })).status).toBe(200);
  });

  it('runs Reacher → SES → Icypeas finder: SES verifies, unknowns go to the finder', async () => {
    const clock = { t: Date.UTC(2026, 10, 15, 12) };
    const ctx = makeCtx({}, () => clock.t);
    const c = await setupClient(ctx);
    approveOffer(ctx);
    const acc = await c.send('POST', '/api/v1/accounts', { domain: 'acme.com', name: 'Acme' });
    for (const fullName of ['Jane Doe', 'Bob Ray']) {
      await c.send('POST', `/api/v1/accounts/${acc.body.id}/contacts`, {
        fullName,
        title: 'VP Operations',
      });
    }
    await c.send('PUT', '/api/v1/provider-keys/aws-ses', { key: KEY });
    await c.send('PUT', '/api/v1/provider-keys/icypeas', { key: 'icy-test-key' });
    const sesCalls: { auth: string; date: string; body: string }[] = [];
    const SES: Handler = (url, init) => {
      if (url !== 'https://email.us-east-1.amazonaws.com/v2/email/email-address-insights')
        return undefined;
      sesCalls.push({
        auth: init.headers?.authorization ?? '',
        date: init.headers?.['x-amz-date'] ?? '',
        body: init.body ?? '',
      });
      const email = JSON.parse(init.body!).EmailAddress as string;
      if (email === 'jane.doe@acme.com') return { body: ins('HIGH', { MailboxExists: 'HIGH' }) };
      if (email.startsWith('bob.')) return { body: ins('MEDIUM') };
      return { body: ins('LOW') };
    };
    const icy = fakeIcypeas({
      verify: () => 'very_sure',
      find: (f, _l, d) => (f === 'Bob' ? { email: `bob@${d}`, certainty: 'ultra_sure' } : null),
    });
    const http = fakeHttp((u, i) => SES(u, i) ?? icy(u, i));
    const slept: number[] = [];
    Object.assign(ctx, { http: http.http, sleep: async (ms: number) => void slept.push(ms) });

    const est = await c.get(`/api/v1/accounts/${acc.body.id}/enrichment`);
    expect(est.body.email).toMatchObject({ contacts: 2, verifier: 'aws-ses', finder: 'icypeas' });
    expect(est.body.email.perContactUsd).toBeCloseTo(3 * 0.01 + 0.019, 6);

    await c.send('POST', `/api/v1/accounts/${acc.body.id}/emails`, {});
    const runner = new JobRunner(ctx, jobHandlers(ctx));
    for (let i = 0; i < 5; i++) {
      clock.t += 1;
      await runner.tick();
    }
    const by = Object.fromEntries(
      ctx.db
        .select()
        .from(contacts)
        .all()
        .map((x) => [x.fullName, x]),
    );
    expect(by['Jane Doe']).toMatchObject({
      email: 'jane.doe@acme.com',
      emailStatus: 'pattern_verified',
    });
    expect(by['Bob Ray']).toMatchObject({ email: 'bob@acme.com', emailStatus: 'verified' });
    // Icypeas verification was not used (SES verifies); only the finder for the unknown.
    expect(http.calls.some((x) => x.url.endsWith('/email-verification'))).toBe(false);
    expect(http.calls.filter((x) => x.url.endsWith('/email-search'))).toHaveLength(1);
    // Signed SigV4 requests for service `ses` in the key's region; body is just the address.
    expect(sesCalls[0]!.auth).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLEEXAMPLE12\/\d{8}\/us-east-1\/ses\/aws4_request/,
    );
    expect(sesCalls[0]!.date).toMatch(/^\d{8}T\d{6}Z$/);
    expect(sesCalls.map((x) => JSON.parse(x.body))).toContainEqual({
      EmailAddress: 'jane.doe@acme.com',
    });
    // Metered at $0.01 per validation, linked to the contact; sources name SES.
    const led = ctx.db.select().from(costLedger).where(eq(costLedger.provider, 'aws-ses')).all();
    expect(led.length).toBe(sesCalls.length);
    expect(led.every((l) => l.usd === SES_VALIDATION_USD && l.entityType === 'contact')).toBe(true);
    const janeSrc = ctx.db
      .select()
      .from(fieldSources)
      .where(eq(fieldSources.entityId, by['Jane Doe']!.id))
      .all();
    expect(janeSrc.find((s) => s.field === 'emailStatus')!.source).toBe('aws-ses');
  });
});

describe('provider key help', () => {
  it('covers every keyed provider with an https link, and missing-key errors name the key', () => {
    for (const p of KEYED_PROVIDERS) expect(helpFor(p), p).toBeTruthy();
    for (const h of PROVIDER_HELP) {
      expect(h.createUrl, h.id).toMatch(/^https:\/\//);
      expect(h.usedFor.length).toBeGreaterThan(5);
      expect(h.cost.length).toBeGreaterThan(3);
    }
    expect(helpFor('aws-ses')!.scope).toContain('ses:GetEmailAddressInsights');
    expect(new ProviderKeyMissingError('icypeas').message).toBe(
      'no Icypeas key: add it in Settings → Provider keys',
    );
  });
});

describe.skipIf(!process.env.LE_E2E || !process.env.LE_E2E_SES_KEY)('SES live (LE_E2E=1)', () => {
  it('validates one address with real credentials ($0.01)', async () => {
    const { sesVerify } = await import('../src/providers/ses.ts');
    const { defaultHttp } = await import('../src/people/http.ts');
    const adapter = sesVerify({ http: defaultHttp, sleep: async () => {}, now: Date.now });
    const r = await adapter.call(
      {
        email: process.env.LE_E2E_SES_EMAIL ?? 'success@simulator.amazonses.com',
        domain: 'amazonses.com',
      },
      { apiKey: process.env.LE_E2E_SES_KEY! },
    );
    expect(['valid', 'invalid', 'risky', 'unknown']).toContain(r.value.verdict);
  });
});
