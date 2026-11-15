/**
 * Icypeas email finder and verifier (docs/providers.md, Phase 2 verification). Only
 * `email-search` and `email-verification` are used; Find People is never called. Both are
 * asynchronous: submit, then poll `bulk-single-searchs/read` (≥3 s apart, 30 reads/min).
 * Only email, certainty and status are kept from a response.
 */
import { readJson, type HttpFetch } from '../people/http.ts';
import { ProviderAuthError, ProviderCallError } from './errors.ts';
import type { ProviderAdapter } from './types.ts';

export const ICYPEAS_BASE = 'https://app.icypeas.com/api';
/** Basic plan: $19 for 1,000 credits (docs/providers.md, checked 2026-11-08). */
export const ICYPEAS_CREDIT_USD = 0.019;
export const VERIFY_CREDITS = 0.1;
export const SEARCH_CREDITS = 1;

const RUNNING = new Set(['NONE', 'SCHEDULED', 'IN_PROGRESS']);

export interface IcypeasDeps {
  http: HttpFetch;
  sleep: (ms: number) => Promise<void>;
  pollMs?: number;
  maxPolls?: number;
}

interface IcyOutcome {
  status: string;
  email: string | null;
  certainty: string | null;
}

async function post(deps: IcypeasDeps, key: string, path: string, body: unknown) {
  const res = await deps.http(`${ICYPEAS_BASE}${path}`, {
    method: 'POST',
    headers: { authorization: key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new ProviderAuthError('Icypeas rejected the API key');
  if (res.status === 429) throw new ProviderCallError('Icypeas rate limit, retrying later');
  if (res.status < 200 || res.status >= 300)
    throw new ProviderCallError(`Icypeas HTTP ${res.status}`);
  const json = (await readJson(res)) as {
    success?: boolean;
    validationErrors?: { type?: string; message?: string }[];
    item?: { _id?: string };
    items?: {
      status?: string;
      results?: { emails?: { email?: string; certainty?: string }[] };
    }[];
  } | null;
  if (!json) throw new ProviderCallError('Icypeas returned no JSON');
  if (json.success === false) {
    const types = (json.validationErrors ?? []).map((e) => `${e.type ?? ''} ${e.message ?? ''}`);
    if (types.some((t) => /insufficient|unpaid/i.test(t)))
      throw new ProviderAuthError('Icypeas: no credits left on this key');
    throw new ProviderCallError(
      `Icypeas refused the request: ${types.join('; ').slice(0, 200)}`,
      null,
      false,
    );
  }
  return json;
}

/** Submits a search and polls until it finishes. `chargeOnTimeout` is metered if it times out. */
async function run(
  deps: IcypeasDeps,
  key: string,
  path: string,
  body: unknown,
  chargeOnTimeout: { usd: number; units: number } | null,
): Promise<IcyOutcome> {
  const submitted = await post(deps, key, path, body);
  const id = submitted.item?._id;
  if (!id) throw new ProviderCallError('Icypeas returned no search id');
  const maxPolls = deps.maxPolls ?? 20;
  for (let i = 0; i < maxPolls; i++) {
    await deps.sleep(deps.pollMs ?? 3_500);
    const read = await post(deps, key, '/bulk-single-searchs/read', { id });
    const item = read.items?.[0];
    const status = item?.status ?? 'NONE';
    if (RUNNING.has(status)) continue;
    const first = item?.results?.emails?.[0];
    return {
      status,
      email: typeof first?.email === 'string' ? first.email.toLowerCase() : null,
      certainty: typeof first?.certainty === 'string' ? first.certainty : null,
    };
  }
  throw new ProviderCallError(
    'Icypeas did not finish in time',
    chargeOnTimeout && { ...chargeOnTimeout, estimated: true },
  );
}

export interface VerifyInput {
  email: string;
  domain: string;
}
/** `valid` | `invalid` | `risky` | `unknown` | `catch_all` (Reacher only) */
export interface VerifyOutput {
  verdict: 'valid' | 'invalid' | 'risky' | 'unknown' | 'catch_all';
  detail: string;
}

/** Certainty → verdict. `not_found` on verification means "can't tell" (catch-all or unknown). */
export function icypeasVerdict(o: IcyOutcome): VerifyOutput['verdict'] {
  switch (o.certainty) {
    case 'ultra_sure':
    case 'very_sure':
      return 'valid';
    case 'probable':
      return 'risky';
    case 'undeliverable':
      return 'invalid';
    default:
      return 'unknown';
  }
}

export function icypeasVerify(deps: IcypeasDeps): ProviderAdapter<VerifyInput, VerifyOutput> {
  const usd = VERIFY_CREDITS * ICYPEAS_CREDIT_USD;
  return {
    provider: 'icypeas',
    operation: 'verifyEmail',
    keyProvider: 'icypeas',
    cacheTtlMs: 30 * 86_400_000,
    estimateUsd: () => usd,
    subjects: (i) => ({ emails: [i.email], domains: [i.domain] }),
    cacheKey: (i) => i.email.toLowerCase(),
    async call(input, env) {
      const o = await run(
        deps,
        env.apiKey!,
        '/email-verification',
        { email: input.email },
        { usd, units: VERIFY_CREDITS },
      );
      return {
        value: { verdict: icypeasVerdict(o), detail: o.certainty ?? o.status },
        usd,
        units: VERIFY_CREDITS,
        confident: true,
        meta: { status: o.status, certainty: o.certainty },
      };
    },
  };
}

export interface FindInput {
  firstname: string;
  lastname: string;
  domain: string;
}
export interface FindOutput {
  email: string | null;
  certainty: string | null;
}

export function icypeasFind(deps: IcypeasDeps): ProviderAdapter<FindInput, FindOutput> {
  const usd = SEARCH_CREDITS * ICYPEAS_CREDIT_USD;
  return {
    provider: 'icypeas',
    operation: 'findEmail',
    keyProvider: 'icypeas',
    cacheTtlMs: 90 * 86_400_000,
    estimateUsd: () => usd,
    subjects: (i) => ({ domains: [i.domain] }),
    cacheKey: (i) => `${i.firstname}|${i.lastname}|${i.domain}`.toLowerCase(),
    async call(input, env) {
      const o = await run(
        deps,
        env.apiKey!,
        '/email-search',
        { firstname: input.firstname, lastname: input.lastname, domainOrCompany: input.domain },
        null,
      );
      // Charged only when found (1 credit).
      const found = (o.status === 'FOUND' || o.status === 'DEBITED') && !!o.email;
      const domainOk = found && o.email!.endsWith(`@${input.domain}`);
      return {
        value: { email: domainOk ? o.email : null, certainty: found ? o.certainty : null },
        usd: found ? usd : 0,
        units: found ? SEARCH_CREDITS : 0,
        confident: found,
        meta: { status: o.status, certainty: o.certainty },
      };
    },
  };
}
