/**
 * Amazon SES Email Validation (docs/providers.md, checked 2026-11-15): SES API v2
 * `GetEmailAddressInsights`, `POST https://email.<region>.amazonaws.com/v2/email/email-address-insights`
 * with `{"EmailAddress": …}`, SigV4 (service `ses`), signed with aws4fetch (MIT, 65 KB) instead
 * of the 19 MB SDK. $0.01 per address. Workspace BYO credentials need only
 * `ses:GetEmailAddressInsights` on `*`. Validation only: SES sending is out of scope.
 *
 * SES reports LOW/MEDIUM/HIGH confidence per check and has no catch-all signal, so it can
 * answer valid, invalid, risky or unknown, never catch_all.
 */
import { AwsClient } from 'aws4fetch';
import type { HttpFetch } from '../people/http.ts';
import { readJson } from '../people/http.ts';
import { ProviderAuthError, ProviderCallError } from './errors.ts';
import type { VerifyInput, VerifyOutput } from './icypeas.ts';
import type { ProviderAdapter } from './types.ts';

/** Per address validated through the API (aws.amazon.com/ses/pricing, checked 2026-11-15). */
export const SES_VALIDATION_USD = 0.01;
/** SES throttles non-sending API actions to 1 request/second per account (quotas page). */
export const SES_MIN_GAP_MS = 1_000;

export interface SesCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;

/** Parses the stored key (JSON with access key ID, secret and region); null when malformed. */
export function parseSesKey(raw: string | null): SesCredentials | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<SesCredentials>;
    if (
      typeof v.accessKeyId === 'string' &&
      /^[A-Z0-9]{16,128}$/.test(v.accessKeyId) &&
      typeof v.secretAccessKey === 'string' &&
      v.secretAccessKey.length >= 16 &&
      typeof v.region === 'string' &&
      REGION.test(v.region)
    ) {
      return { accessKeyId: v.accessKeyId, secretAccessKey: v.secretAccessKey, region: v.region };
    }
  } catch {
    // fall through
  }
  return null;
}

type Level = 'LOW' | 'MEDIUM' | 'HIGH' | undefined;
interface Insights {
  MailboxValidation?: {
    IsValid?: { ConfidenceVerdict?: Level };
    Evaluations?: Record<
      | 'HasValidSyntax'
      | 'HasValidDnsRecords'
      | 'MailboxExists'
      | 'IsRoleAddress'
      | 'IsDisposable'
      | 'IsRandomInput',
      { ConfidenceVerdict?: Level } | undefined
    >;
  };
}

/**
 * SES verdicts → ours (docs/decisions.md). For the trait checks HIGH means the trait applies
 * (bad for role, disposable, random input).
 * - syntax, DNS or mailbox LOW, or IsValid LOW → invalid
 * - disposable, random input or role address HIGH → risky
 * - IsValid HIGH (mailbox not LOW) → valid
 * - anything else (MEDIUM, missing) → unknown, which lets the Icypeas finder try
 */
export function sesVerdict(out: Insights): VerifyOutput['verdict'] {
  const mv = out.MailboxValidation;
  const ev = mv?.Evaluations;
  const lvl = (k: keyof NonNullable<typeof ev>) => ev?.[k]?.ConfidenceVerdict;
  if (
    lvl('HasValidSyntax') === 'LOW' ||
    lvl('HasValidDnsRecords') === 'LOW' ||
    lvl('MailboxExists') === 'LOW' ||
    mv?.IsValid?.ConfidenceVerdict === 'LOW'
  )
    return 'invalid';
  if (
    lvl('IsDisposable') === 'HIGH' ||
    lvl('IsRandomInput') === 'HIGH' ||
    lvl('IsRoleAddress') === 'HIGH'
  )
    return 'risky';
  if (mv?.IsValid?.ConfidenceVerdict === 'HIGH') return 'valid';
  return 'unknown';
}

export function sesVerify(deps: {
  http: HttpFetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}): ProviderAdapter<VerifyInput, VerifyOutput> {
  let last = 0;
  return {
    provider: 'aws-ses',
    operation: 'verifyEmail',
    keyProvider: 'aws-ses',
    cacheTtlMs: 30 * 86_400_000,
    estimateUsd: () => SES_VALIDATION_USD,
    subjects: (i) => ({ emails: [i.email], domains: [i.domain] }),
    cacheKey: (i) => i.email.toLowerCase(),
    async call(input, env) {
      const creds = parseSesKey(env.apiKey);
      if (!creds) throw new ProviderAuthError('the Amazon SES key is malformed; save it again');
      const wait = last + SES_MIN_GAP_MS - deps.now();
      if (wait > 0) await deps.sleep(wait);
      last = deps.now();
      const url = `https://email.${creds.region}.amazonaws.com/v2/email/email-address-insights`;
      const body = JSON.stringify({ EmailAddress: input.email });
      const signed = await new AwsClient({ ...creds, service: 'ses', region: creds.region }).sign(
        url,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        },
      );
      const headers: Record<string, string> = {};
      signed.headers.forEach((v, k) => (headers[k] = v));
      const res = await deps.http(url, { method: 'POST', headers, body });
      if (res.status === 403 || res.status === 401) {
        throw new ProviderAuthError(
          'Amazon SES refused the key (it needs ses:GetEmailAddressInsights)',
        );
      }
      if (res.status === 429) throw new ProviderCallError('Amazon SES rate limit, retrying later');
      if (res.status === 400) {
        // Bad input is billed? Not documented; treat as unknown without charge.
        return {
          value: { verdict: 'unknown', detail: 'bad request' },
          usd: 0,
          units: 0,
          confident: false,
        };
      }
      if (res.status < 200 || res.status >= 300)
        throw new ProviderCallError(`Amazon SES HTTP ${res.status}`);
      const out = (await readJson(res)) as Insights | null;
      const verdict = sesVerdict(out ?? {});
      return {
        value: { verdict, detail: out?.MailboxValidation?.IsValid?.ConfidenceVerdict ?? 'none' },
        usd: SES_VALIDATION_USD,
        units: 1,
        confident: verdict === 'valid' || verdict === 'invalid',
        meta: { isValid: out?.MailboxValidation?.IsValid?.ConfidenceVerdict ?? null },
      };
    },
  };
}
