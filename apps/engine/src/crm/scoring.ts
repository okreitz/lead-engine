/**
 * Scoring (SPEC §4.2). Pure functions plus a store step; every score keeps its top 3
 * reasons so the UI can say why.
 *
 * - Fit 0–100: firmographic rules from the approved ICP, averaged with the LLM homepage fit
 *   (a `fit` signal) when one exists.
 * - Intent 0–100: signal weights with exponential decay (visits 14 d, threads 7 d,
 *   hiring 30 d half-lives), saturating so it is capped and normalised.
 * - Priority = w_fit·fit + w_intent·intent (workspace weights, default 0.6 / 0.4).
 */
import { DEFAULT_SCORE_WEIGHTS, type OfferProfile } from '@le/shared';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';
import { accounts, companies, signals, workspaces } from '../db/schema.ts';
import { approvedOffers, type ApprovedOffer } from '../offer/approved.ts';

export type Icp = OfferProfile['icp'];

export interface Scored {
  score: number;
  reasons: string[];
}

interface Part {
  weight: number;
  /** 0..1 share of the weight earned; null = not applicable (excluded from the total). */
  earned: number | null;
  reason: string;
  /** Contribution used to rank reasons. */
  impact: number;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export function overlaps(haystack: string, needles: string[]): string | null {
  const h = ` ${norm(haystack)} `;
  for (const n of needles) {
    const k = norm(n);
    if (k && h.includes(` ${k} `)) return n;
  }
  for (const n of needles) {
    // Partial word overlap ("software" vs "computer software").
    const words = norm(n)
      .split(' ')
      .filter((w) => w.length > 3);
    if (words.some((w) => h.includes(` ${w} `))) return n;
  }
  return null;
}

/** Parses "11-50", "51 to 200", "1000+", "5,001-10,000" into [min, max]. */
export function parseRange(range: string | null | undefined): [number, number] | null {
  if (!range) return null;
  const nums = [...range.replace(/,/g, '').matchAll(/\d+(?:\.\d+)?\s*[kK]?/g)].map((m) => {
    const t = m[0].trim();
    return /k$/i.test(t) ? parseFloat(t) * 1000 : parseFloat(t);
  });
  if (nums.length === 0) return null;
  if (nums.length === 1)
    return /\+|more|over|above/i.test(range) ? [nums[0]!, Infinity] : [nums[0]!, nums[0]!];
  return [Math.min(nums[0]!, nums[1]!), Math.max(nums[0]!, nums[1]!)];
}

export interface CompanyFacts {
  name: string;
  industry: string | null;
  naics: string | null;
  sizeRange: string | null;
  state: string | null;
  tech: string[];
}

export function fitScore(
  company: CompanyFacts,
  icp: Icp,
  llm?: { score: number; reasons: string[] } | null,
): Scored {
  const text = [company.name, company.industry ?? ''].join(' ');
  const excluded = overlaps(text, icp.exclude);
  if (excluded) return { score: 0, reasons: [`Excluded by ICP rule "${excluded}"`] };

  const parts: Part[] = [];

  // Industry or NAICS (35)
  if (icp.industries.length || icp.naics.length) {
    const ind = company.industry ? overlaps(company.industry, icp.industries) : null;
    const naics = company.naics
      ? icp.naics.find((n) => company.naics!.startsWith(n) || n.startsWith(company.naics!))
      : undefined;
    if (ind || naics) {
      parts.push({
        weight: 35,
        earned: 1,
        reason: ind ? `Industry matches "${ind}"` : `NAICS ${company.naics} matches ${naics}`,
        impact: 35,
      });
    } else if (!company.industry && !company.naics) {
      parts.push({ weight: 35, earned: 0.5, reason: 'Industry unknown', impact: 0 });
    } else {
      parts.push({
        weight: 35,
        earned: 0,
        reason: `Industry "${company.industry ?? company.naics}" is outside the ICP`,
        impact: -35,
      });
    }
  }

  // Company size (25)
  const want = parseRange(icp.employeeRange);
  if (want) {
    const have = parseRange(company.sizeRange);
    if (!have) parts.push({ weight: 25, earned: 0.5, reason: 'Company size unknown', impact: 0 });
    else if (have[0] <= want[1] && have[1] >= want[0]) {
      parts.push({
        weight: 25,
        earned: 1,
        reason: `Size ${company.sizeRange} fits ${icp.employeeRange}`,
        impact: 25,
      });
    } else {
      parts.push({
        weight: 25,
        earned: 0,
        reason: `Size ${company.sizeRange} is outside ${icp.employeeRange}`,
        impact: -25,
      });
    }
  }

  // State (15)
  if (icp.states.length) {
    const st = company.state?.toUpperCase() ?? null;
    if (!st) parts.push({ weight: 15, earned: 0.5, reason: 'State unknown', impact: 0 });
    else if (icp.states.includes(st))
      parts.push({ weight: 15, earned: 1, reason: `Located in ${st}`, impact: 15 });
    else parts.push({ weight: 15, earned: 0, reason: `${st} is not a target state`, impact: -15 });
  }

  // Technology (15, minus avoided tech)
  if (icp.techUses.length) {
    const hit = company.tech.find((t) => overlaps(t, icp.techUses));
    if (hit) parts.push({ weight: 15, earned: 1, reason: `Uses ${hit}`, impact: 15 });
    else
      parts.push({
        weight: 15,
        earned: company.tech.length ? 0 : 0.5,
        reason: company.tech.length ? 'No target technology found' : 'Technology unknown',
        impact: company.tech.length ? -10 : 0,
      });
  }
  const avoided = icp.techAvoids.length
    ? company.tech.find((t) => overlaps(t, icp.techAvoids))
    : undefined;

  const total = parts.reduce((s, p) => s + p.weight, 0);
  let rules = total
    ? (parts.reduce((s, p) => s + p.weight * (p.earned ?? 0), 0) / total) * 100
    : 50;
  if (avoided) {
    rules = Math.max(0, rules - 25);
    parts.push({
      weight: 0,
      earned: null,
      reason: `Uses ${avoided}, which the ICP avoids`,
      impact: -25,
    });
  }

  let score = rules;
  const ranked = [...parts]
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
    .map((p) => p.reason);
  let reasons = ranked;
  if (llm) {
    score = (rules + llm.score) / 2;
    reasons = [
      `Website fit ${Math.round(llm.score)}: ${llm.reasons[0] ?? 'LLM assessment'}`,
      ...ranked,
    ];
  }
  return { score: Math.round(Math.max(0, Math.min(100, score))), reasons: reasons.slice(0, 3) };
}

export const HALF_LIFE_DAYS = { visits: 14, conversations: 7, hiring: 30, default: 14 } as const;
/** Raw decayed weight at which intent reaches ~63. */
export const INTENT_SCALE = 10;

export interface SignalFacts {
  stream: string;
  kind: string;
  weight: number;
  occurredAt: number;
  expiresAt: number | null;
}

export function halfLifeDays(s: Pick<SignalFacts, 'stream' | 'kind'>): number {
  if (s.kind === 'hiring') return HALF_LIFE_DAYS.hiring;
  if (s.stream === 'visits') return HALF_LIFE_DAYS.visits;
  if (s.stream === 'conversations') return HALF_LIFE_DAYS.conversations;
  return HALF_LIFE_DAYS.default;
}

/** Fit signals describe fit, not intent, and are left out. */
export function intentScore(list: SignalFacts[], now: number): Scored {
  const DAY = 86_400_000;
  const contribs = list
    .filter(
      (s) => s.kind !== 'fit' && (s.expiresAt === null || s.expiresAt > now) && s.occurredAt <= now,
    )
    .map((s) => {
      const ageDays = (now - s.occurredAt) / DAY;
      return { s, value: s.weight * 0.5 ** (ageDays / halfLifeDays(s)), ageDays };
    });
  const raw = contribs.reduce((sum, c) => sum + c.value, 0);
  const score = Math.round(100 * (1 - Math.exp(-raw / INTENT_SCALE)));
  const reasons = contribs
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .map(
      (c) =>
        `${c.s.kind.replace(/_/g, ' ')} (${c.s.stream}) ${c.ageDays < 1 ? 'today' : `${Math.floor(c.ageDays)}d ago`}, +${c.value.toFixed(1)}`,
    );
  return { score, reasons };
}

export function priorityScore(
  fit: number | null,
  intent: number,
  weights: { fit: number; intent: number } = DEFAULT_SCORE_WEIGHTS,
): number {
  const sum = weights.fit + weights.intent || 1;
  return Math.round(((weights.fit * (fit ?? 0) + weights.intent * intent) / sum) * 10) / 10;
}

type FitSignal = { score: number; reasons: string[] } | null;

/** The newest LLM fit for this offer (stream 3 writes `{ score, reasons, offerId }`). */
function llmFitFor(sigs: (typeof signals.$inferSelect)[], offerId: string): FitSignal {
  const s = sigs
    .filter(
      (x) =>
        x.kind === 'fit' &&
        typeof x.payload.score === 'number' &&
        (x.payload.offerId === undefined || x.payload.offerId === offerId),
    )
    .sort((a, b) => b.occurredAt - a.occurredAt)[0];
  return s
    ? {
        score: s.payload.score as number,
        reasons: (s.payload.reasons as string[] | undefined) ?? [],
      }
    : null;
}

/**
 * Recomputes and stores an account's scores and reasons. Fit uses the account's offer; an
 * account without one is scored against every approved offer and the best fit counts.
 * `offers` may be passed when rescoring many accounts.
 */
export function rescoreAccount(
  tx: Tx,
  workspaceId: string,
  accountId: string,
  now: number,
  offers: ApprovedOffer[] = approvedOffers(tx, workspaceId),
): void {
  const row = tx
    .select({ account: accounts, company: companies, settings: workspaces.settings })
    .from(accounts)
    .innerJoin(companies, eq(companies.id, accounts.companyId))
    .innerJoin(workspaces, eq(workspaces.id, accounts.workspaceId))
    .where(and(eq(accounts.id, accountId), eq(accounts.workspaceId, workspaceId)))
    .get();
  if (!row) return;
  const sigs = tx.select().from(signals).where(eq(signals.accountId, accountId)).all();
  const own = row.account.offerId ? offers.find((o) => o.offerId === row.account.offerId) : null;
  let fit: { score: number; reasons: string[] } | null = null;
  if (own) {
    fit = fitScore(row.company, own.profile.icp, llmFitFor(sigs, own.offerId));
  } else {
    for (const o of offers) {
      const f = fitScore(row.company, o.profile.icp, llmFitFor(sigs, o.offerId));
      if (!fit || f.score > fit.score)
        fit =
          offers.length > 1
            ? { score: f.score, reasons: [`Best fit: "${o.name}"`, ...f.reasons] }
            : f;
    }
  }
  const intent = intentScore(sigs, now);
  const priority = priorityScore(fit?.score ?? null, intent.score, row.settings.scoreWeights);
  tx.update(accounts)
    .set({
      fitScore: fit?.score ?? null,
      intentScore: intent.score,
      priority,
      scoreReasons: {
        fit: fit?.reasons ?? ['No approved offer profile yet'],
        intent: intent.reasons,
      },
      scoredAt: now,
    })
    .where(eq(accounts.id, accountId))
    .run();
}

export function rescoreWorkspace(tx: Tx, workspaceId: string, now: number): number {
  const offers = approvedOffers(tx, workspaceId);
  const ids = tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.workspaceId, workspaceId))
    .all();
  for (const { id } of ids) rescoreAccount(tx, workspaceId, id, now, offers);
  return ids.length;
}
