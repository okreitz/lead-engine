/**
 * Email waterfall (SPEC §4.3, §5.1 step 6), cheapest first:
 *   1. an address the company publishes for this person, else the domain's learned pattern,
 *      else the 3 most common permutations;
 *   2. verify with Reacher when it is on (free, throttled per domain), then Amazon SES Email
 *      Validation ($0.01) when the workspace has an SES key; Icypeas email-verification
 *      (0.1 credit) only when neither is available; an invalid candidate moves to the next one, while a
 *      catch-all/unknown/risky answer stops (other permutations would answer the same);
 *   3. only catch-all and unknown go to the Icypeas email finder (1 credit, only when found);
 *   4. the result is stored with an `emailStatus` and a source.
 * Status mapping is in docs/providers.md and docs/decisions.md.
 */
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../api/context.ts';
import { providerKeys } from '../db/schema.ts';
import { callProvider, ProviderKeyMissingError } from '../providers/index.ts';
import {
  icypeasFind,
  icypeasVerify,
  type FindInput,
  type FindOutput,
  type VerifyInput,
  type VerifyOutput,
} from '../providers/icypeas.ts';
import { reacherVerify } from '../providers/reacher.ts';
import { sesVerify } from '../providers/ses.ts';
import type { ProviderAdapter } from '../providers/types.ts';
import { defaultHttp } from './http.ts';
import { emailFor, permutations, splitName, type PatternId } from './names.ts';

export type EmailStatus =
  'verified' | 'pattern_verified' | 'risky' | 'catch_all' | 'unknown' | 'invalid';

export type VerifierName = 'reacher' | 'aws-ses' | 'icypeas';

export interface EmailProviders {
  /** Tried in order per candidate until one gives a definite answer. */
  verifiers: ProviderAdapter<VerifyInput, VerifyOutput>[];
  finder: ProviderAdapter<FindInput, FindOutput> | null;
  /** Shown in the UI and estimates. */
  verifierNames: VerifierName[];
}

const hasKey = (ctx: AppContext, workspaceId: string, provider: string) =>
  !!ctx.db
    .select({ p: providerKeys.provider })
    .from(providerKeys)
    .where(and(eq(providerKeys.workspaceId, workspaceId), eq(providerKeys.provider, provider)))
    .get();

let reacherSingleton: ProviderAdapter<VerifyInput, VerifyOutput> | null = null;

/**
 * Verifiers in waterfall order (SPEC §5.1 step 6): Reacher when its flag is on, then Amazon SES
 * Email Validation when the workspace has an SES key; Icypeas verification only when neither is
 * available. The Icypeas finder is used for catch-all or still-unknown results.
 */
export function emailProviders(ctx: AppContext, workspaceId: string): EmailProviders {
  const http = ctx.http ?? defaultHttp;
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const icy = hasKey(ctx, workspaceId, 'icypeas');
  const verifiers: EmailProviders['verifiers'] = [];
  const verifierNames: VerifierName[] = [];
  if (ctx.config.reacher.enabled) {
    if (ctx.http) {
      verifiers.push(reacherVerify({ ...ctx.config.reacher, http, now: ctx.now }));
    } else {
      reacherSingleton ??= reacherVerify({ ...ctx.config.reacher, http, now: ctx.now });
      verifiers.push(reacherSingleton);
    }
    verifierNames.push('reacher');
  }
  if (hasKey(ctx, workspaceId, 'aws-ses')) {
    verifiers.push(sesVerify({ http, sleep, now: ctx.now }));
    verifierNames.push('aws-ses');
  }
  if (!verifiers.length && icy) {
    verifiers.push(icypeasVerify({ http, sleep }));
    verifierNames.push('icypeas');
  }
  return { verifiers, finder: icy ? icypeasFind({ http, sleep }) : null, verifierNames };
}

export interface EmailResult {
  email: string | null;
  status: EmailStatus | null;
  source: string;
  confidence: number;
  note: string;
}

const CONFIDENCE: Record<EmailStatus, number> = {
  verified: 0.95,
  pattern_verified: 0.9,
  risky: 0.5,
  catch_all: 0.5,
  unknown: 0.3,
  invalid: 0.1,
};

export function statusOf(verdict: VerifyOutput['verdict'], generated: boolean): EmailStatus {
  switch (verdict) {
    case 'valid':
      return generated ? 'pattern_verified' : 'verified';
    case 'catch_all':
      return 'catch_all';
    case 'risky':
      return 'risky';
    case 'invalid':
      return 'invalid';
    default:
      return 'unknown';
  }
}

export async function findEmail(
  ctx: AppContext,
  p: EmailProviders,
  input: {
    workspaceId: string;
    jobId: string;
    contactId: string;
    fullName: string;
    domain: string;
    /** An address already known for this person (published on the site). */
    existing: string | null;
    pattern: PatternId | null;
  },
): Promise<EmailResult> {
  const name = splitName(input.fullName);
  if (!name)
    return {
      email: null,
      status: null,
      source: 'none',
      confidence: 0,
      note: 'name has no first and last part',
    };
  const opts = {
    workspaceId: input.workspaceId,
    stream: 'personas' as const,
    jobId: input.jobId,
    ledgerEntity: { type: 'contact', id: input.contactId },
  };
  const generated = !input.existing;
  const candidates = input.existing
    ? [input.existing]
    : input.pattern
      ? [emailFor(input.pattern, name, input.domain)]
      : permutations(name, input.domain, 3);

  let best: { email: string; status: EmailStatus; source: string } | null = null;
  if (p.verifiers.length) {
    candidates: for (const email of candidates) {
      let answer: { status: EmailStatus; source: string } | null = null;
      for (const v of p.verifiers) {
        const r = await callProvider(ctx, v, { email, domain: input.domain }, opts);
        if (r.status === 'suppressed')
          return { email: null, status: null, source: 'none', confidence: 0, note: r.reason };
        answer = { status: statusOf(r.value.verdict, generated), source: v.provider };
        // A definite answer ends the chain; risky/unknown asks the next verifier.
        if (['verified', 'pattern_verified', 'invalid', 'catch_all'].includes(answer.status)) break;
      }
      if (!answer) break;
      if (answer.status === 'verified' || answer.status === 'pattern_verified')
        return { email, ...answer, confidence: CONFIDENCE[answer.status], note: '' };
      if (answer.status === 'invalid') continue candidates;
      best = { email, ...answer };
      break;
    }
  } else if (input.existing) {
    best = { email: input.existing, status: 'unknown', source: 'website' };
  } else if (input.pattern) {
    best = { email: candidates[0]!, status: 'unknown', source: 'pattern' };
  }

  const finderApplies = best
    ? best.status === 'catch_all' || best.status === 'unknown'
    : !p.verifiers.length;
  if (p.finder && finderApplies) {
    const words = input.fullName.replace(/[,()]/g, ' ').trim().split(/\s+/);
    try {
      const r = await callProvider(
        ctx,
        p.finder,
        { firstname: words[0]!, lastname: words[words.length - 1]!, domain: input.domain },
        opts,
      );
      if (r.status === 'suppressed')
        return { email: null, status: null, source: 'none', confidence: 0, note: r.reason };
      if (r.value.email) {
        const status: EmailStatus =
          r.value.certainty === 'ultra_sure' || r.value.certainty === 'very_sure'
            ? 'verified'
            : 'risky';
        return {
          email: r.value.email,
          status,
          source: 'icypeas',
          confidence: CONFIDENCE[status],
          note: '',
        };
      }
    } catch (err) {
      if (!(err instanceof ProviderKeyMissingError)) throw err;
    }
  }
  if (best) return { ...best, confidence: CONFIDENCE[best.status], note: '' };
  return {
    email: null,
    status: null,
    source: 'none',
    confidence: 0,
    note: p.verifiers.length
      ? 'every candidate address was invalid'
      : 'no verifier: add an Amazon SES or Icypeas key, or enable Reacher',
  };
}
