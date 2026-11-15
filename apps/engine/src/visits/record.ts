/**
 * Everything stream 1 writes. Only the collector pipeline calls these, and only after a
 * request passed every step (SPEC §5.2): dropped traffic touches `visit_daily` and nothing else.
 */
import { DEFAULT_FIT_THRESHOLD, VISIT_WEIGHTS } from '@le/shared';
import { and, desc, eq, gt, gte, lte, sql } from 'drizzle-orm';
import type { AppContext } from '../api/context.ts';
import type { Tx } from '../db/client.ts';
import {
  accounts,
  companies,
  contacts,
  ipCompanies,
  jobs,
  sites,
  signals,
  visitDaily,
  visits,
  type IntentPage,
  type MatchSource,
  type VisitOutcome,
} from '../db/schema.ts';
import { createAccount, createAccountForCompany, CrmError, workspaceRow } from '../crm/accounts.ts';
import { normalizeDomain } from '../suppression.ts';
import { rescoreAccount } from '../crm/scoring.ts';
import { newId } from '../ids.ts';
import { enqueue } from '../jobs/queue.ts';
import { budgetStatus } from '../providers/budget.ts';
import { approvedOffer } from '../persona/run.ts';
import { ipHex, type Prefix } from '../collector/ip.ts';

export type SiteRow = typeof sites.$inferSelect;
export type IpCompanyRow = typeof ipCompanies.$inferSelect;

const DAY = 86_400_000;
/** Visit signals count toward intent for 90 days (half-life 14 days, SPEC §4.2). */
export const VISIT_SIGNAL_TTL_MS = 90 * DAY;
/** At most this many people + email jobs per workspace per day are queued from visits. */
export const VISIT_PEOPLE_JOBS_PER_DAY = 20;

/** Most specific live IpCompany row containing `ip` (wrong-marked rows included). */
export function findIpCompany(
  tx: Tx,
  workspaceId: string,
  ip: string,
  now: number,
): IpCompanyRow | null {
  const h = ipHex(ip);
  return (
    tx
      .select()
      .from(ipCompanies)
      .where(
        and(
          eq(ipCompanies.workspaceId, workspaceId),
          lte(ipCompanies.ipStart, h),
          gte(ipCompanies.ipEnd, h),
          gt(ipCompanies.expiresAt, now),
        ),
      )
      .orderBy(desc(ipCompanies.prefixLen), desc(ipCompanies.confidence))
      .limit(1)
      .get() ?? null
  );
}

/** True when "Wrong company" rejected `domain` for a prefix containing `ip`. */
export function isRejected(tx: Tx, workspaceId: string, ip: string, domain: string): boolean {
  const h = ipHex(ip);
  return !!tx
    .select({ id: ipCompanies.id })
    .from(ipCompanies)
    .where(
      and(
        eq(ipCompanies.workspaceId, workspaceId),
        eq(ipCompanies.companyDomain, domain),
        eq(ipCompanies.wrong, true),
        lte(ipCompanies.ipStart, h),
        gte(ipCompanies.ipEnd, h),
      ),
    )
    .get();
}

/**
 * Upserts prefix → domain. A wrong-marked row is never revived; a stronger source replaces
 * a weaker one's confidence, and every write extends the expiry.
 */
export function upsertIpCompany(
  tx: Tx,
  input: {
    workspaceId: string;
    prefix: Prefix;
    domain: string;
    source: MatchSource;
    confidence: number;
    ttlMs: number;
    now: number;
  },
): IpCompanyRow {
  const existing = tx
    .select()
    .from(ipCompanies)
    .where(
      and(
        eq(ipCompanies.workspaceId, input.workspaceId),
        eq(ipCompanies.prefix, input.prefix.cidr),
        eq(ipCompanies.companyDomain, input.domain),
      ),
    )
    .get();
  if (existing) {
    if (existing.wrong) return existing;
    const stronger = input.confidence >= existing.confidence;
    tx.update(ipCompanies)
      .set({
        seenAt: input.now,
        expiresAt: Math.max(existing.expiresAt, input.now + input.ttlMs),
        ...(stronger ? { source: input.source, confidence: input.confidence } : {}),
      })
      .where(eq(ipCompanies.id, existing.id))
      .run();
    return tx.select().from(ipCompanies).where(eq(ipCompanies.id, existing.id)).get()!;
  }
  const row = {
    id: newId('ipc'),
    workspaceId: input.workspaceId,
    prefix: input.prefix.cidr,
    ipStart: input.prefix.start,
    ipEnd: input.prefix.end,
    prefixLen: input.prefix.len128,
    companyDomain: input.domain,
    source: input.source,
    confidence: input.confidence,
    wrong: false,
    seenAt: input.now,
    expiresAt: input.now + input.ttlMs,
  };
  tx.insert(ipCompanies).values(row).run();
  return row;
}

/** Deletes expired IP map rows (wrong-marked rows are kept for a year as corrections). */
export function purgeIpCompanies(ctx: AppContext): number {
  const now = ctx.now();
  return ctx.db
    .delete(ipCompanies)
    .where(
      sql`(${ipCompanies.wrong} = 0 AND ${ipCompanies.expiresAt} <= ${now}) OR (${ipCompanies.wrong} = 1 AND ${ipCompanies.seenAt} <= ${now - 365 * DAY})`,
    )
    .run().changes;
}

export function countOutcome(
  tx: Tx,
  siteId: string,
  day: string,
  outcome: VisitOutcome,
  newSession: boolean,
): void {
  tx.insert(visitDaily)
    .values({ siteId, day, outcome, sessions: newSession ? 1 : 0, pageviews: 1 })
    .onConflictDoUpdate({
      target: [visitDaily.siteId, visitDaily.day, visitDaily.outcome],
      set: {
        sessions: sql`${visitDaily.sessions} + ${newSession ? 1 : 0}`,
        pageviews: sql`${visitDaily.pageviews} + 1`,
      },
    })
    .run();
}

function normPath(p: string): string {
  const s = p.toLowerCase().replace(/\/+$/, '');
  return s || '/';
}

/** The intent page a path falls under (exact or a sub-path), if any. */
export function intentPageFor(path: string, pages: IntentPage[]): IntentPage | null {
  const p = normPath(path);
  for (const page of pages) {
    const base = normPath(page.path);
    if (p === base || (base !== '/' && p.startsWith(`${base}/`))) return page;
  }
  return null;
}

function intentKind(label: string): string {
  const l = label.toLowerCase();
  if (l === 'pricing') return 'pricing_view';
  if (l === 'demo') return 'demo_view';
  return 'intent_page';
}

export interface Match {
  domain: string;
  companyName: string | null;
  source: MatchSource;
  confidence: number;
  ipCompanyId: string | null;
}

export type RecordResult =
  { status: 'ok'; accountId: string; created: boolean } | { status: 'not_us' | 'invalid' };

/** Creates or finds the account for a matched domain (firstSource = visits). */
export function accountForMatch(
  tx: Tx,
  workspaceId: string,
  match: Match,
  now: number,
): RecordResult {
  try {
    // An existing company keeps its name and fields; a match never renames it.
    const existing = tx
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.domain, normalizeDomain(match.domain)))
      .get();
    // The visitor's IP is in the US (step 3); a company that already exists elsewhere is
    // checked by createAccount(ForCompany), which refuses non-US companies.
    const r = existing
      ? createAccountForCompany(tx, workspaceId, existing.id, 'visits', now)
      : createAccount(
          tx,
          workspaceId,
          { domain: match.domain, name: match.companyName ?? match.domain, country: 'US' },
          'visits',
          now,
        );
    return { status: 'ok', accountId: r.id, created: r.created };
  } catch (err) {
    if (err instanceof CrmError && err.code === 'not_us') return { status: 'not_us' };
    if (err instanceof CrmError) return { status: 'invalid' };
    throw err;
  }
}

/** Writes a matched page view: Visit, then `visit` / intent signals once per session. */
export function recordVisit(
  tx: Tx,
  input: {
    site: SiteRow;
    accountId: string;
    match: Match;
    sessionHash: string;
    path: string;
    referrer: string | null;
    utm: Record<string, string> | null;
    now: number;
  },
): void {
  const { site, accountId, match, sessionHash, now } = input;
  const earlier = tx
    .select({ path: visits.path })
    .from(visits)
    .where(and(eq(visits.sessionHash, sessionHash), eq(visits.accountId, accountId)))
    .all();
  tx.insert(visits)
    .values({
      id: newId('vis'),
      workspaceId: site.workspaceId,
      siteId: site.id,
      accountId,
      sessionHash,
      path: input.path,
      referrer: input.referrer,
      utm: input.utm,
      matchSource: match.source,
      confidence: match.confidence,
      ipCompanyId: match.ipCompanyId,
      at: now,
    })
    .run();
  const payload = {
    siteId: site.id,
    site: site.domain,
    path: input.path,
    matchSource: match.source,
    confidence: match.confidence,
    ipCompanyId: match.ipCompanyId,
  };
  const signal = (kind: string, weight: number, extra: Record<string, unknown> = {}) =>
    tx
      .insert(signals)
      .values({
        id: newId('sig'),
        workspaceId: site.workspaceId,
        accountId,
        stream: 'visits',
        kind,
        weight,
        occurredAt: now,
        payload: { ...payload, ...extra },
        evidenceUrl: `https://${site.domain}${input.path}`,
        expiresAt: now + VISIT_SIGNAL_TTL_MS,
      })
      .run();
  if (earlier.length === 0) signal('visit', VISIT_WEIGHTS.visit);
  const intent = intentPageFor(input.path, site.intentPages);
  if (intent && !earlier.some((e) => intentPageFor(e.path, [intent]))) {
    signal(intentKind(intent.label), VISIT_WEIGHTS.intentPage, { label: intent.label });
  }
  tx.update(accounts).set({ updatedAt: now }).where(eq(accounts.id, accountId)).run();
}

/** A form fill identified the company: one signal (SPEC §3 `form_identify`). */
export function recordIdentify(
  tx: Tx,
  input: { site: SiteRow; accountId: string; domain: string; ipCompanyId: string; now: number },
): void {
  tx.insert(signals)
    .values({
      id: newId('sig'),
      workspaceId: input.site.workspaceId,
      accountId: input.accountId,
      stream: 'visits',
      kind: 'form_identify',
      weight: VISIT_WEIGHTS.formIdentify,
      occurredAt: input.now,
      payload: {
        siteId: input.site.id,
        site: input.site.domain,
        matchSource: 'form',
        ipCompanyId: input.ipCompanyId,
      },
      evidenceUrl: `https://${input.site.domain}/`,
      expiresAt: input.now + VISIT_SIGNAL_TTL_MS,
    })
    .run();
}

/**
 * SPEC §5.2 step 8: a new account at or above the fit threshold gets the stream 3 people +
 * email job, if an offer is approved, the budget isn't used up, it has no contacts or pending
 * job yet, and the workspace's daily cap for visit-triggered jobs isn't reached.
 */
export function maybeQueuePeople(ctx: AppContext, workspaceId: string, accountId: string): boolean {
  const { db } = ctx;
  const now = ctx.now();
  const ws = workspaceRow(db, workspaceId);
  const acc = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  const threshold = ws.settings.fitThreshold ?? DEFAULT_FIT_THRESHOLD;
  if (!acc || acc.fitScore === null || acc.fitScore < threshold) return false;
  if (!approvedOffer(db, workspaceId)) return false;
  if (budgetStatus(db, workspaceId, now).state === 'reached') return false;
  if (db.select({ id: contacts.id }).from(contacts).where(eq(contacts.accountId, accountId)).get())
    return false;
  const pending = db.get<{ n: number }>(
    sql`SELECT count(*) AS n FROM ${jobs} WHERE ${jobs.workspaceId} = ${workspaceId}
        AND ${jobs.type} = 'people.find' AND json_extract(${jobs.payload}, '$.accountId') = ${accountId}
        AND ${jobs.state} IN ('queued', 'running', 'waiting')`,
  );
  if ((pending?.n ?? 0) > 0) return false;
  const today = db.get<{ n: number }>(
    sql`SELECT count(*) AS n FROM ${jobs} WHERE ${jobs.workspaceId} = ${workspaceId}
        AND ${jobs.type} = 'people.find' AND json_extract(${jobs.payload}, '$.source') = 'visits'
        AND ${jobs.createdAt} >= ${now - DAY}`,
  );
  if ((today?.n ?? 0) >= VISIT_PEOPLE_JOBS_PER_DAY) return false;
  enqueue(
    db,
    { workspaceId, type: 'people.find', payload: { accountId, emails: true, source: 'visits' } },
    now,
  );
  return true;
}

/** Rescores after new signals; a newly created account may get the people job. */
export function afterMatch(
  ctx: AppContext,
  workspaceId: string,
  accountId: string,
  created: boolean,
): void {
  ctx.db.transaction((tx) => rescoreAccount(tx, workspaceId, accountId, ctx.now()));
  if (created) maybeQueuePeople(ctx, workspaceId, accountId);
}

/** Bumped when the IP map is corrected, so the collector forgets today's cached session matches. */
let ipMapVersion = 0;
export function bumpIpMapVersion(): void {
  ipMapVersion++;
}
export function currentIpMapVersion(): number {
  return ipMapVersion;
}
