/**
 * ICP filter (SPEC §5.1 step 2): SQL over the universe companies by industry/NAICS, size,
 * state and founded year, then ranked by the rule-based fit score. Only companies a public
 * dataset listed are searched (never other workspaces' hand-entered companies), suppressed
 * domains and companies that are already accounts in this workspace are left out.
 */
import { and, asc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { domainNotSuppressed } from '../crm/filters.ts';
import { fitScore, parseRange, type Icp } from '../crm/scoring.ts';
import type { Tx } from '../db/client.ts';
import { companies, type CandidateFilters } from '../db/schema.ts';

export const DEFAULT_CANDIDATES = 500;
export const MAX_CANDIDATES = 2_000;
/** How many SQL matches are ranked by rule fit to pick the candidates. */
const POOL_FACTOR = 4;
const MAX_POOL = 8_000;
const COUNT_CAP = 100_000;

export function filtersFromIcp(icp: Icp): CandidateFilters {
  const range = parseRange(icp.employeeRange);
  return {
    industries: icp.industries,
    naics: icp.naics,
    sizeMin: range ? range[0] : null,
    sizeMax: range && Number.isFinite(range[1]) ? range[1] : null,
    states: icp.states,
    foundedFrom: null,
    foundedTo: null,
    exclude: icp.exclude,
  };
}

const like = (s: string) => `%${s.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 3);

function conditions(workspaceId: string, f: CandidateFilters): SQL[] {
  const conds: SQL[] = [
    eq(companies.universe, true),
    eq(companies.country, 'US'),
    domainNotSuppressed(workspaceId, companies.domain),
    sql`NOT EXISTS (SELECT 1 FROM accounts a WHERE a.workspace_id = ${workspaceId} AND a.company_id = ${companies.id})`,
  ];
  const industry: SQL[] = [];
  for (const phrase of f.industries) {
    industry.push(sql`lower(${companies.industry}) LIKE ${like(phrase)} ESCAPE '\\'`);
    for (const w of words(phrase))
      industry.push(sql`lower(${companies.industry}) LIKE ${like(w)} ESCAPE '\\'`);
  }
  for (const code of f.naics) {
    if (/^\d{2,6}$/.test(code)) industry.push(sql`${companies.naics} LIKE ${`${code}%`}`);
  }
  if (industry.length) conds.push(sql`(${sql.join(industry, sql` OR `)})`);
  if (f.sizeMin !== null || f.sizeMax !== null) {
    const min = f.sizeMin ?? 0;
    const max = f.sizeMax ?? 1e12;
    conds.push(
      sql`(${companies.sizeMin} IS NULL OR (coalesce(${companies.sizeMax}, 1e12) >= ${min} AND ${companies.sizeMin} <= ${max}))`,
    );
  }
  if (f.states.length) conds.push(inArray(companies.state, f.states));
  if (f.foundedFrom !== null) conds.push(gte(companies.foundedYear, f.foundedFrom));
  if (f.foundedTo !== null) conds.push(lte(companies.foundedYear, f.foundedTo));
  for (const phrase of f.exclude) {
    conds.push(
      sql`NOT (lower(${companies.name} || ' ' || coalesce(${companies.industry}, '')) LIKE ${like(phrase)} ESCAPE '\\')`,
    );
  }
  return conds;
}

/** How many universe companies match (capped, for the dry-run count). */
export function countCandidates(tx: Tx, workspaceId: string, f: CandidateFilters): number {
  const inner = tx
    .select({ one: sql`1` })
    .from(companies)
    .where(and(...conditions(workspaceId, f)))
    .limit(COUNT_CAP);
  return (
    tx
      .select({ n: sql<number>`count(*)` })
      .from(inner.as('m'))
      .get()?.n ?? 0
  );
}

export interface Candidate {
  companyId: string;
  name: string;
  domain: string;
  state: string | null;
  industry: string | null;
  sizeRange: string | null;
  ruleFit: number;
}

/** The top `limit` matches by rule-based fit. */
export function selectCandidates(
  tx: Tx,
  workspaceId: string,
  icp: Icp,
  f: CandidateFilters,
  limit: number,
): Candidate[] {
  const pool = tx
    .select({
      companyId: companies.id,
      name: companies.name,
      domain: companies.domain,
      state: companies.state,
      industry: companies.industry,
      naics: companies.naics,
      sizeRange: companies.sizeRange,
      tech: companies.tech,
    })
    .from(companies)
    .where(and(...conditions(workspaceId, f)))
    .orderBy(sql`${companies.sizeMin} IS NULL`, sql`${companies.state} IS NULL`, asc(companies.id))
    .limit(Math.min(MAX_POOL, limit * POOL_FACTOR))
    .all();
  return pool
    .map((c) => ({ c, fit: fitScore(c, icp).score }))
    .sort((a, b) => b.fit - a.fit || a.c.name.localeCompare(b.c.name))
    .slice(0, limit)
    .map(({ c, fit }) => ({
      companyId: c.companyId,
      name: c.name,
      domain: c.domain,
      state: c.state,
      industry: c.industry,
      sizeRange: c.sizeRange,
      ruleFit: fit,
    }));
}
