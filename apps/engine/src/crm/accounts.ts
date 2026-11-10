import { and, asc, desc, eq, gte, inArray, sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';
import {
  accounts,
  activities,
  companies,
  contacts,
  deals,
  fieldSources,
  nextSteps,
  signals,
  workspaces,
} from '../db/schema.ts';
import { newId } from '../ids.ts';
import { normalizeDomain } from '../suppression.ts';
import { stagesOf } from '../workspaces.ts';
import { domainNotSuppressed, emailNotSuppressed } from './filters.ts';

export class CrmError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

const US_NAMES = new Set([
  'us',
  'usa',
  'united states',
  'united states of america',
  'u.s.',
  'u.s.a.',
]);

/** Normalises a country to ISO 'US'; anything else is rejected (SPEC §9 country gate). */
export function requireUs(country: string | null | undefined, allowed: string[] = ['US']): 'US' {
  const c = (country ?? '').trim().toLowerCase();
  if (US_NAMES.has(c) && allowed.includes('US')) return 'US';
  throw new CrmError('not_us', 'only US companies can be added (country must be US)');
}

export function isValidDomain(domain: string): boolean {
  return /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain);
}

export interface CompanyInput {
  domain: string;
  name: string;
  country: string;
  state?: string | null | undefined;
  city?: string | null | undefined;
  industry?: string | null | undefined;
  naics?: string | null | undefined;
  sizeRange?: string | null | undefined;
  foundedYear?: number | null | undefined;
}

/** Upserts the company by domain. Existing non-empty fields are kept unless provided. */
export function upsertCompany(tx: Tx, input: CompanyInput, source: string, now: number): string {
  const domain = normalizeDomain(input.domain);
  if (!isValidDomain(domain))
    throw new CrmError('invalid_domain', `not a valid domain: ${input.domain}`);
  const country = requireUs(input.country);
  const existing = tx.select().from(companies).where(eq(companies.domain, domain)).get();
  const fields = {
    name: input.name.trim() || domain,
    ...(input.state ? { state: input.state } : {}),
    ...(input.city ? { city: input.city } : {}),
    ...(input.industry ? { industry: input.industry } : {}),
    ...(input.naics ? { naics: input.naics } : {}),
    ...(input.sizeRange ? { sizeRange: input.sizeRange } : {}),
    ...(input.foundedYear ? { foundedYear: input.foundedYear } : {}),
  };
  if (existing) {
    if (existing.country !== 'US') throw new CrmError('not_us', 'company is not US-based');
    tx.update(companies)
      .set({ ...fields, sources: [...new Set([...existing.sources, source])], updatedAt: now })
      .where(eq(companies.id, existing.id))
      .run();
    return existing.id;
  }
  const id = newId('co');
  tx.insert(companies)
    .values({ id, domain, country, sources: [source], tech: [], updatedAt: now, ...fields })
    .run();
  return id;
}

export function workspaceRow(tx: Tx, workspaceId: string) {
  const ws = tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  if (!ws) throw new CrmError('not_found', 'workspace not found', 404);
  return ws;
}

export function createAccount(
  tx: Tx,
  workspaceId: string,
  input: CompanyInput & { stage?: string | undefined; ownerUserId?: string | null | undefined },
  firstSource: 'manual' | 'personas' | 'visits' | 'conversations',
  now: number,
): { id: string; created: boolean } {
  const ws = workspaceRow(tx, workspaceId);
  requireUs(input.country, ws.allowedCountries);
  const stages = stagesOf(ws.settings);
  const stage = input.stage ?? stages[0]!;
  if (!stages.includes(stage)) throw new CrmError('invalid_stage', `unknown stage: ${stage}`);
  const companyId = upsertCompany(tx, input, firstSource, now);
  const existing = tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.companyId, companyId)))
    .get();
  if (existing) return { id: existing.id, created: false };
  const id = newId('acc');
  tx.insert(accounts)
    .values({
      id,
      workspaceId,
      companyId,
      stage,
      ownerUserId: input.ownerUserId ?? null,
      firstSource,
      firstSourceAt: now,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return { id, created: true };
}

export interface AccountFilters {
  q?: string | undefined;
  /** Values within one filter are OR; separate filters are AND (docs/ui.md §3.2). */
  stage?: string | string[] | undefined;
  stream?: string | string[] | undefined;
  ids?: string[] | undefined;
  minFit?: number | undefined;
  minIntent?: number | undefined;
  status?: 'active' | 'archived' | undefined;
  sort?: 'priority' | 'fit' | 'intent' | 'updated' | 'name' | 'last' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/** FTS5 prefix query from free text: each word becomes `"word"*`. */
export function ftsQuery(q: string): string | null {
  const words = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
  return words.length ? words.map((w) => `"${w}"*`).join(' ') : null;
}

/** Latest signal or activity on the account ("Last" column). */
const lastActivityAt = sql<number>`max(${accounts.updatedAt},
  coalesce((SELECT max(occurred_at) FROM signals s WHERE s.account_id = ${accounts.id}), 0),
  coalesce((SELECT max(at) FROM activities a WHERE a.account_id = ${accounts.id}), 0))`;
/** When the account entered its current stage (last stage change, else creation). */
const stageSince = sql<number>`coalesce((SELECT max(at) FROM activities a WHERE a.account_id = ${accounts.id} AND a.kind = 'stage_change' AND a.deal_id IS NULL), ${accounts.createdAt})`;

export type AccountRow = ReturnType<typeof listAccounts>[number];

export function listAccounts(tx: Tx, workspaceId: string, f: AccountFilters = {}) {
  const conds: SQL[] = [
    eq(accounts.workspaceId, workspaceId),
    eq(accounts.status, f.status ?? 'active'),
    domainNotSuppressed(workspaceId, companies.domain),
  ];
  const many = (v: string | string[] | undefined) =>
    v === undefined ? [] : Array.isArray(v) ? v : [v];
  const stages = many(f.stage);
  const streams = many(f.stream) as ('manual' | 'personas' | 'visits' | 'conversations')[];
  if (stages.length) conds.push(inArray(accounts.stage, stages));
  if (streams.length) conds.push(inArray(accounts.firstSource, streams));
  if (f.ids) conds.push(f.ids.length ? inArray(accounts.id, f.ids) : sql`0`);
  if (f.minFit !== undefined) conds.push(gte(accounts.fitScore, f.minFit));
  if (f.minIntent !== undefined) conds.push(gte(accounts.intentScore, f.minIntent));
  const fts = f.q ? ftsQuery(f.q) : null;
  if (fts) {
    conds.push(
      sql`${companies}.rowid IN (SELECT rowid FROM companies_fts WHERE companies_fts MATCH ${fts})`,
    );
  }
  const order = {
    priority: [desc(accounts.priority), desc(accounts.updatedAt)],
    fit: [sql`${accounts.fitScore} IS NULL`, desc(accounts.fitScore)],
    intent: [desc(accounts.intentScore)],
    updated: [desc(accounts.updatedAt)],
    name: [asc(companies.name)],
    last: [desc(lastActivityAt)],
  }[f.sort ?? 'priority'];
  return tx
    .select({
      id: accounts.id,
      name: companies.name,
      domain: companies.domain,
      state: companies.state,
      industry: companies.industry,
      sizeRange: companies.sizeRange,
      stage: accounts.stage,
      fitScore: accounts.fitScore,
      intentScore: accounts.intentScore,
      priority: accounts.priority,
      firstSource: accounts.firstSource,
      status: accounts.status,
      updatedAt: accounts.updatedAt,
      createdAt: accounts.createdAt,
      scoreReasons: accounts.scoreReasons,
      lastActivityAt,
      stageSince,
      nextStep: sql<
        string | null
      >`(SELECT text FROM next_steps n WHERE n.account_id = ${accounts.id} AND n.done_at IS NULL ORDER BY n.due_at IS NULL, n.due_at LIMIT 1)`,
      nextStepDueAt: sql<
        number | null
      >`(SELECT due_at FROM next_steps n WHERE n.account_id = ${accounts.id} AND n.done_at IS NULL ORDER BY n.due_at IS NULL, n.due_at LIMIT 1)`,
      openDealsUsd: sql<number>`(SELECT coalesce(sum(value_usd), 0) FROM deals d WHERE d.account_id = ${accounts.id} AND d.outcome IS NULL)`,
    })
    .from(accounts)
    .innerJoin(companies, eq(companies.id, accounts.companyId))
    .where(and(...conds))
    .orderBy(...order)
    .limit(f.limit ?? 200)
    .offset(f.offset ?? 0)
    .all();
}

/** The account if it exists in this workspace and isn't hidden by suppression. */
export function findAccount(tx: Tx, workspaceId: string, accountId: string) {
  return tx
    .select({ account: accounts, company: companies })
    .from(accounts)
    .innerJoin(companies, eq(companies.id, accounts.companyId))
    .where(
      and(
        eq(accounts.id, accountId),
        eq(accounts.workspaceId, workspaceId),
        domainNotSuppressed(workspaceId, companies.domain),
      ),
    )
    .get();
}

export function requireAccount(tx: Tx, workspaceId: string, accountId: string) {
  const row = findAccount(tx, workspaceId, accountId);
  if (!row) throw new CrmError('not_found', 'account not found', 404);
  return row;
}

export function accountDetail(tx: Tx, workspaceId: string, accountId: string) {
  const { account, company } = requireAccount(tx, workspaceId, accountId);
  const contactRows = tx
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.accountId, accountId),
        emailNotSuppressed(workspaceId, contacts.email, contacts.emailDomain),
      ),
    )
    .orderBy(asc(contacts.fullName))
    .all();
  const contactIds = contactRows.map((c) => c.id);
  const sources = tx
    .select()
    .from(fieldSources)
    .where(
      and(
        eq(fieldSources.workspaceId, workspaceId),
        sql`(${fieldSources.entity} = 'account' AND ${fieldSources.entityId} = ${accountId})
          OR (${fieldSources.entity} = 'company' AND ${fieldSources.entityId} = ${company.id})
          ${contactIds.length ? sql`OR (${fieldSources.entity} = 'contact' AND ${inArray(fieldSources.entityId, contactIds)})` : sql``}`,
      ),
    )
    .all();
  return {
    account,
    company,
    contacts: contactRows,
    deals: tx
      .select()
      .from(deals)
      .where(eq(deals.accountId, accountId))
      .orderBy(desc(deals.updatedAt))
      .all(),
    activities: tx
      .select()
      .from(activities)
      .where(eq(activities.accountId, accountId))
      .orderBy(desc(activities.at))
      .limit(200)
      .all(),
    nextSteps: tx
      .select()
      .from(nextSteps)
      .where(eq(nextSteps.accountId, accountId))
      .orderBy(sql`${nextSteps.doneAt} IS NOT NULL`, asc(nextSteps.dueAt))
      .all(),
    signals: tx
      .select()
      .from(signals)
      .where(eq(signals.accountId, accountId))
      .orderBy(desc(signals.occurredAt))
      .limit(200)
      .all(),
    fieldSources: sources,
  };
}

/** Moves an account to a stage and writes the change as an Activity (SPEC §6). */
export function setAccountStage(
  tx: Tx,
  workspaceId: string,
  accountId: string,
  stage: string,
  userId: string | null,
  now: number,
): boolean {
  const ws = workspaceRow(tx, workspaceId);
  if (!stagesOf(ws.settings).includes(stage))
    throw new CrmError('invalid_stage', `unknown stage: ${stage}`);
  const { account } = requireAccount(tx, workspaceId, accountId);
  if (account.stage === stage) return false;
  tx.update(accounts).set({ stage, updatedAt: now }).where(eq(accounts.id, accountId)).run();
  tx.insert(activities)
    .values({
      id: newId('act'),
      workspaceId,
      accountId,
      kind: 'stage_change',
      body: `Stage changed from ${account.stage} to ${stage}`,
      meta: { from: account.stage, to: stage },
      at: now,
      userId,
    })
    .run();
  return true;
}

export function pipeline(tx: Tx, workspaceId: string, filters: AccountFilters = {}) {
  const ws = workspaceRow(tx, workspaceId);
  const stages = stagesOf(ws.settings);
  const rows = listAccounts(tx, workspaceId, { ...filters, limit: 2000 });
  return {
    stages,
    columns: stages.map((stage) => {
      const list = rows.filter((r) => r.stage === stage);
      return {
        stage,
        accounts: list,
        count: list.length,
        /** Open deal value in this column (docs/ui.md §3.4 column totals). */
        openDealsUsd: list.reduce((sum, r) => sum + (r.openDealsUsd ?? 0), 0),
      };
    }),
    /** Accounts whose stage is no longer in the workspace's list. */
    other: rows.filter((r) => !stages.includes(r.stage)),
  };
}
