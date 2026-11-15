/**
 * Read side of stream 1 for the Visitors page and Settings → Sites & snippet (docs/ui.md
 * §3.6, §3.9), plus the "Wrong company" correction.
 */
import { randomBytes } from 'node:crypto';
import { DEFAULT_INTENT_PAGES } from '@le/shared';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../api/context.ts';
import type { Tx } from '../db/client.ts';
import {
  accounts,
  companies,
  ipCompanies,
  providerKeys,
  signals,
  sites,
  visitDaily,
  visits,
  type IntentPage,
} from '../db/schema.ts';
import { domainNotSuppressed } from '../crm/filters.ts';
import { CrmError, isValidDomain, requireAccount } from '../crm/accounts.ts';
import { rescoreAccount } from '../crm/scoring.ts';
import { newId } from '../ids.ts';
import { normalizeDomain } from '../suppression.ts';
import { snippetHtml } from '../collector/snippet.ts';
import { bumpIpMapVersion, intentPageFor, type SiteRow } from './record.ts';
import { utcDay } from './session.ts';

const DAY = 86_400_000;

export function siteView(ctx: AppContext, site: SiteRow) {
  const now = ctx.now();
  return {
    id: site.id,
    domain: site.domain,
    siteKey: site.siteKey,
    intentPages: site.intentPages,
    snippet: snippetHtml(ctx.config.collector.publicUrl, site.siteKey),
    lastEventAt: site.lastEventAt,
    receiving: !!site.lastEventAt && now - site.lastEventAt < DAY,
    check: site.checkedAt ? { at: site.checkedAt, ok: !!site.checkOk, note: site.checkNote } : null,
    createdAt: site.createdAt,
  };
}

export function collectorStatus(ctx: AppContext, workspaceId: string) {
  const hasKey = !!ctx.db
    .select({ p: providerKeys.provider })
    .from(providerKeys)
    .where(and(eq(providerKeys.workspaceId, workspaceId), eq(providerKeys.provider, 'ipapi')))
    .get();
  const geo = ctx.geo?.state() ?? { source: null, ready: false, updatedAt: null, error: null };
  return { collectorUrl: ctx.config.collector.publicUrl, ipapiKey: hasKey, geo };
}

export function listSites(ctx: AppContext, workspaceId: string) {
  return ctx.db
    .select()
    .from(sites)
    .where(eq(sites.workspaceId, workspaceId))
    .orderBy(sites.createdAt)
    .all()
    .map((s) => siteView(ctx, s));
}

export function requireSite(tx: Tx, workspaceId: string, siteId: string): SiteRow {
  const site = tx
    .select()
    .from(sites)
    .where(and(eq(sites.id, siteId), eq(sites.workspaceId, workspaceId)))
    .get();
  if (!site) throw new CrmError('not_found', 'site not found', 404);
  return site;
}

export function createSite(ctx: AppContext, workspaceId: string, rawDomain: string): SiteRow {
  const domain = normalizeDomain(rawDomain).replace(/^www\./, '');
  if (!isValidDomain(domain))
    throw new CrmError('invalid_domain', `not a valid domain: ${rawDomain}`);
  const exists = ctx.db
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.workspaceId, workspaceId), eq(sites.domain, domain)))
    .get();
  if (exists) throw new CrmError('exists', `${domain} is already a site`, 409);
  const row = {
    id: newId('site'),
    workspaceId,
    domain,
    siteKey: `site_${randomBytes(12).toString('base64url')}`,
    intentPages: DEFAULT_INTENT_PAGES.map((p) => ({ ...p })) as IntentPage[],
    createdAt: ctx.now(),
  };
  ctx.db.insert(sites).values(row).run();
  return requireSite(ctx.db, workspaceId, row.id);
}

/** Install check: the snippet in the homepage HTML, or events received in the last day. */
export async function checkSite(
  ctx: AppContext,
  site: SiteRow,
  fetchHtml: (url: string) => Promise<{ body: string }>,
): Promise<SiteRow> {
  const now = ctx.now();
  let found = false;
  let note: string;
  try {
    const page = await fetchHtml(`https://${site.domain}/`);
    const key = site.siteKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    found =
      new RegExp(`data-site\\s*=\\s*["']${key}["']`).test(page.body) && page.body.includes('/p.js');
    note = found
      ? 'Snippet found on the homepage.'
      : 'Snippet not found in the homepage HTML. If a tag manager loads it, the check passes once events arrive.';
  } catch (err) {
    note = `Couldn't fetch the homepage: ${(err as Error).message}`;
  }
  const receiving = !!site.lastEventAt && now - site.lastEventAt < DAY;
  if (receiving) note += ' Events are arriving.';
  ctx.db
    .update(sites)
    .set({ checkedAt: now, checkOk: found || receiving, checkNote: note })
    .where(eq(sites.id, site.id))
    .run();
  return requireSite(ctx.db, site.workspaceId, site.id);
}

export interface VisitorFilters {
  siteId: string;
  days: number;
  /** "engaged": more than 2 pages or an intent page (docs/ui.md §3.6 default). */
  show: 'engaged' | 'all';
}

export function visitorsReport(ctx: AppContext, workspaceId: string, f: VisitorFilters) {
  const site = requireSite(ctx.db, workspaceId, f.siteId);
  const now = ctx.now();
  const since = now - f.days * DAY;
  const sinceDay = utcDay(since);

  const daily = ctx.db
    .select({
      outcome: visitDaily.outcome,
      sessions: sql<number>`sum(${visitDaily.sessions})`,
      pageviews: sql<number>`sum(${visitDaily.pageviews})`,
    })
    .from(visitDaily)
    .where(and(eq(visitDaily.siteId, site.id), gte(visitDaily.day, sinceDay)))
    .groupBy(visitDaily.outcome)
    .all();
  const outcomes = Object.fromEntries(daily.map((d) => [d.outcome, d]));
  const sessions = daily
    .filter((d) => d.outcome !== 'rate_limited')
    .reduce((s, d) => s + d.sessions, 0);
  const identified = outcomes.matched?.sessions ?? 0;

  const rows = ctx.db
    .select({
      accountId: visits.accountId,
      sessionHash: visits.sessionHash,
      path: visits.path,
      at: visits.at,
      matchSource: visits.matchSource,
      confidence: visits.confidence,
      name: companies.name,
      domain: companies.domain,
      priority: accounts.priority,
      fitScore: accounts.fitScore,
      stage: accounts.stage,
    })
    .from(visits)
    .innerJoin(accounts, eq(accounts.id, visits.accountId))
    .innerJoin(companies, eq(companies.id, accounts.companyId))
    .where(
      and(
        eq(visits.siteId, site.id),
        eq(visits.workspaceId, workspaceId),
        gte(visits.at, since),
        domainNotSuppressed(workspaceId, companies.domain),
      ),
    )
    .orderBy(desc(visits.at))
    .limit(20_000)
    .all();

  type Row = (typeof rows)[number];
  const byAccount = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byAccount.get(r.accountId) ?? [];
    list.push(r);
    byAccount.set(r.accountId, list);
  }
  const companiesOut = [...byAccount.values()].map((list) => {
    const latest = list[0]!;
    const intent = new Map<string, number>();
    for (const v of list) {
      const page = intentPageFor(v.path, site.intentPages);
      if (page) intent.set(page.path, (intent.get(page.path) ?? 0) + 1);
    }
    const lastSession = list
      .filter((v) => v.sessionHash === latest.sessionHash)
      .sort((a, b) => a.at - b.at)
      .map((v) => v.path);
    const best = list.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    return {
      accountId: latest.accountId,
      name: latest.name,
      domain: latest.domain,
      stage: latest.stage,
      priority: latest.priority,
      fitScore: latest.fitScore,
      visits: new Set(list.map((v) => v.sessionHash)).size,
      pages: list.length,
      lastAt: latest.at,
      intentPages: [...intent.entries()].map(([path, count]) => ({ path, count })),
      matchSource: best.matchSource,
      confidence: best.confidence,
      path: lastSession.slice(0, 30),
    };
  });
  const shown =
    f.show === 'all'
      ? companiesOut
      : companiesOut.filter((c) => c.pages > 2 || c.intentPages.length > 0);

  return {
    site: siteView(ctx, site),
    days: f.days,
    kpi: {
      sessions,
      identified,
      matchRate: sessions ? identified / sessions : 0,
      accounts: companiesOut.length,
      newAccounts:
        ctx.db.get<{ n: number }>(
          sql`SELECT count(DISTINCT ${visits.accountId}) AS n FROM ${visits}
            JOIN ${accounts} ON ${accounts.id} = ${visits.accountId}
            WHERE ${visits.siteId} = ${site.id} AND ${accounts.firstSource} = 'visits'
              AND ${accounts.firstSourceAt} >= ${since}`,
        )?.n ?? 0,
    },
    outcomes: Object.fromEntries(
      daily.map((d) => [d.outcome, { sessions: d.sessions, pageviews: d.pageviews }]),
    ),
    companies: shown.sort((a, b) => b.lastAt - a.lastAt),
    hidden: companiesOut.length - shown.length,
    status: collectorStatus(ctx, workspaceId),
  };
}

/**
 * "Wrong company" (docs/ui.md §3.3): every IP-map row that matched this account is marked
 * wrong (it then blocks that domain for that prefix), and the visits and visit signals that
 * came through those rows are removed. The caller audits it.
 */
export function markWrongCompany(ctx: AppContext, workspaceId: string, accountId: string) {
  const now = ctx.now();
  const { company } = requireAccount(ctx.db, workspaceId, accountId);
  const result = ctx.db.transaction((tx) => {
    const fromVisits = tx
      .selectDistinct({ id: visits.ipCompanyId })
      .from(visits)
      .where(and(eq(visits.workspaceId, workspaceId), eq(visits.accountId, accountId)))
      .all()
      .map((r) => r.id)
      .filter((id): id is string => !!id);
    const fromSignals = tx
      .select({ id: sql<string | null>`json_extract(${signals.payload}, '$.ipCompanyId')` })
      .from(signals)
      .where(and(eq(signals.accountId, accountId), eq(signals.stream, 'visits')))
      .all()
      .map((r) => r.id)
      .filter((id): id is string => !!id);
    const byDomain = tx
      .select({ id: ipCompanies.id })
      .from(ipCompanies)
      .where(
        and(
          eq(ipCompanies.workspaceId, workspaceId),
          eq(ipCompanies.companyDomain, company.domain),
        ),
      )
      .all()
      .map((r) => r.id);
    const ids = [...new Set([...fromVisits, ...fromSignals, ...byDomain])];
    if (ids.length === 0) return { prefixes: [] as string[], removedVisits: 0, removedSignals: 0 };
    const rows = tx
      .select()
      .from(ipCompanies)
      .where(and(eq(ipCompanies.workspaceId, workspaceId), inArray(ipCompanies.id, ids)))
      .all();
    tx.update(ipCompanies)
      .set({ wrong: true, seenAt: now })
      .where(and(eq(ipCompanies.workspaceId, workspaceId), inArray(ipCompanies.id, ids)))
      .run();
    const removedVisits = tx
      .delete(visits)
      .where(
        and(
          eq(visits.workspaceId, workspaceId),
          eq(visits.accountId, accountId),
          inArray(visits.ipCompanyId, ids),
        ),
      )
      .run().changes;
    const removedSignals = tx
      .delete(signals)
      .where(
        and(
          eq(signals.accountId, accountId),
          eq(signals.stream, 'visits'),
          inArray(sql`json_extract(${signals.payload}, '$.ipCompanyId')`, ids),
        ),
      )
      .run().changes;
    rescoreAccount(tx, workspaceId, accountId, now);
    return { prefixes: rows.map((r) => r.prefix), removedVisits, removedSignals };
  });
  bumpIpMapVersion();
  return { domain: company.domain, ...result };
}
