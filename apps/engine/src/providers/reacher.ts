/**
 * Reacher sidecar (check-if-email-exists, MIT since v0.11.9). Off by default until outbound
 * port 25 is confirmed (`LE_REACHER=on`). Self-hosted, so calls are free: they count against
 * an unlimited free quota instead of the budget. One check per recipient domain per
 * `domainIntervalMs` (default 1 min) keeps the VPS IP off blocklists; a throttled check throws
 * `ReacherThrottled` so the job can come back later instead of sleeping.
 */
import { readJson, type HttpFetch } from '../people/http.ts';
import { ProviderCallError } from './errors.ts';
import type { VerifyInput, VerifyOutput } from './icypeas.ts';
import type { ProviderAdapter } from './types.ts';

export class ReacherThrottled extends Error {
  override name = 'ReacherThrottled';
  constructor(public readonly waitMs: number) {
    super(`Reacher: next check for this domain in ${Math.ceil(waitMs / 1000)} s`);
  }
}

type CoreError = { type: string; message: string };
const isErr = (v: unknown): v is CoreError =>
  !!v && typeof v === 'object' && 'type' in v && 'message' in v;

/** Mapping from docs/decisions.md (2026-11-08): risky + catch-all → catch_all. */
export function reacherVerdict(out: {
  is_reachable?: unknown;
  smtp?: unknown;
}): VerifyOutput['verdict'] {
  const smtp = isErr(out.smtp) ? null : (out.smtp as { is_catch_all?: boolean } | undefined);
  switch (out.is_reachable) {
    case 'safe':
      return 'valid';
    case 'invalid':
      return 'invalid';
    case 'risky':
      return smtp?.is_catch_all ? 'catch_all' : 'risky';
    default:
      return 'unknown';
  }
}

export function reacherVerify(opts: {
  url: string;
  secret: string | null;
  http: HttpFetch;
  now: () => number;
  domainIntervalMs: number;
}): ProviderAdapter<VerifyInput, VerifyOutput> {
  const lastByDomain = new Map<string, number>();
  return {
    provider: 'reacher',
    operation: 'verifyEmail',
    keyProvider: null,
    cacheTtlMs: 30 * 86_400_000,
    freeQuota: { limit: Number.MAX_SAFE_INTEGER, period: 'lifetime' },
    estimateUsd: () => 0,
    subjects: (i) => ({ emails: [i.email], domains: [i.domain] }),
    cacheKey: (i) => i.email.toLowerCase(),
    async call(input) {
      const now = opts.now();
      const last = lastByDomain.get(input.domain);
      if (last !== undefined && now - last < opts.domainIntervalMs)
        throw new ReacherThrottled(opts.domainIntervalMs - (now - last));
      lastByDomain.set(input.domain, now);
      const res = await opts.http(`${opts.url.replace(/\/$/, '')}/v1/check_email`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(opts.secret ? { 'x-reacher-secret': opts.secret } : {}),
        },
        body: JSON.stringify({ to_email: input.email }),
        timeoutMs: 90_000,
      });
      if (res.status < 200 || res.status >= 300)
        throw new ProviderCallError(`Reacher HTTP ${res.status}`, null, res.status >= 500);
      const out = (await readJson(res)) as { is_reachable?: unknown; smtp?: unknown } | null;
      if (!out) throw new ProviderCallError('Reacher returned no JSON');
      const verdict = reacherVerdict(out);
      return {
        value: { verdict, detail: String(out.is_reachable ?? 'unknown') },
        usd: 0,
        units: 1,
        confident: verdict === 'valid' || verdict === 'invalid',
      };
    },
  };
}
