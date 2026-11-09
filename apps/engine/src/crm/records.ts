import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';
import {
  accounts,
  activities,
  companies,
  contacts,
  deals,
  EMAIL_STATUSES,
  fieldSources,
  nextSteps,
  suppressions,
} from '../db/schema.ts';
import { newId } from '../ids.ts';
import { emailDomain, findSuppression, normalizeDomain, normalizeEmail } from '../suppression.ts';
import { stagesOf } from '../workspaces.ts';
import { CrmError, isValidDomain, requireAccount, workspaceRow } from './accounts.ts';
import { domainNotSuppressed, emailNotSuppressed } from './filters.ts';

// ---------------------------------------------------------------- contacts

/** Partial with explicit `undefined`, for PATCH bodies. */
type Opt<T> = { [K in keyof T]?: T[K] | undefined };

export interface ContactInput {
  fullName: string;
  title?: string | null | undefined;
  seniority?: string | null | undefined;
  department?: string | null | undefined;
  email?: string | null | undefined;
  emailStatus?: (typeof EMAIL_STATUSES)[number] | null | undefined;
  phone?: string | null | undefined;
}

function checkEmail(tx: Tx, workspaceId: string, email: string | null | undefined): string | null {
  if (!email) return null;
  const e = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
    throw new CrmError('invalid_email', `not a valid email: ${email}`);
  if (findSuppression(tx, workspaceId, { emails: [e] })) {
    throw new CrmError('suppressed', `${e} is on the suppression list`, 409);
  }
  return e;
}

/**
 * Creates a contact on an account. The account's company must be US-based (it always is:
 * only US companies are created) and the email must not be suppressed (SPEC §9).
 * Manual entries get a FieldSource of `manual` for each field provided.
 */
export function createContact(
  tx: Tx,
  workspaceId: string,
  accountId: string,
  input: ContactInput,
  source: { source: string; url?: string | null; confidence?: number },
  now: number,
): string {
  const { company } = requireAccount(tx, workspaceId, accountId);
  if (company.country !== 'US')
    throw new CrmError('not_us', 'contacts can only be added to US companies');
  const email = checkEmail(tx, workspaceId, input.email);
  const id = newId('con');
  tx.insert(contacts)
    .values({
      id,
      workspaceId,
      accountId,
      fullName: input.fullName.trim(),
      title: input.title ?? null,
      seniority: input.seniority ?? null,
      department: input.department ?? null,
      email,
      emailDomain: email ? emailDomain(email) : null,
      emailStatus: input.emailStatus ?? (email ? 'unknown' : null),
      phone: input.phone ?? null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  recordSources(tx, workspaceId, id, input, source, now);
  return id;
}

function recordSources(
  tx: Tx,
  workspaceId: string,
  contactId: string,
  input: Opt<ContactInput>,
  source: { source: string; url?: string | null; confidence?: number },
  now: number,
): void {
  for (const field of ['fullName', 'title', 'email', 'phone'] as const) {
    if (input[field]) {
      tx.insert(fieldSources)
        .values({
          id: newId('fs'),
          workspaceId,
          entity: 'contact',
          entityId: contactId,
          field,
          source: source.source,
          url: source.url ?? null,
          fetchedAt: now,
          confidence: source.confidence ?? 1,
        })
        .run();
    }
  }
}

export function updateContact(
  tx: Tx,
  workspaceId: string,
  contactId: string,
  input: Opt<ContactInput>,
  now: number,
): void {
  const row = requireContact(tx, workspaceId, contactId);
  const email = input.email !== undefined ? checkEmail(tx, workspaceId, input.email) : undefined;
  tx.update(contacts)
    .set({
      ...(input.fullName !== undefined ? { fullName: input.fullName.trim() } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.seniority !== undefined ? { seniority: input.seniority } : {}),
      ...(input.department !== undefined ? { department: input.department } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.emailStatus !== undefined ? { emailStatus: input.emailStatus } : {}),
      ...(email !== undefined ? { email, emailDomain: email ? emailDomain(email) : null } : {}),
      updatedAt: now,
    })
    .where(eq(contacts.id, row.id))
    .run();
  recordSources(tx, workspaceId, contactId, input, { source: 'manual' }, now);
}

/** Contact visible in this workspace: not suppressed by email, email domain or company domain. */
export function requireContact(tx: Tx, workspaceId: string, contactId: string) {
  const row = tx
    .select({ contact: contacts })
    .from(contacts)
    .innerJoin(accounts, eq(accounts.id, contacts.accountId))
    .innerJoin(companies, eq(companies.id, accounts.companyId))
    .where(
      and(
        eq(contacts.id, contactId),
        eq(contacts.workspaceId, workspaceId),
        emailNotSuppressed(workspaceId, contacts.email, contacts.emailDomain),
        domainNotSuppressed(workspaceId, companies.domain),
      ),
    )
    .get();
  if (!row) throw new CrmError('not_found', 'contact not found', 404);
  return row.contact;
}

export function listContacts(
  tx: Tx,
  workspaceId: string,
  opts: { q?: string | undefined; limit?: number } = {},
) {
  const q = opts.q?.trim().toLowerCase();
  return tx
    .select({
      id: contacts.id,
      accountId: contacts.accountId,
      fullName: contacts.fullName,
      title: contacts.title,
      seniority: contacts.seniority,
      department: contacts.department,
      personaMatch: contacts.personaMatch,
      email: contacts.email,
      emailStatus: contacts.emailStatus,
      phone: contacts.phone,
      company: companies.name,
      domain: companies.domain,
      createdAt: contacts.createdAt,
    })
    .from(contacts)
    .innerJoin(accounts, eq(accounts.id, contacts.accountId))
    .innerJoin(companies, eq(companies.id, accounts.companyId))
    .where(
      and(
        eq(contacts.workspaceId, workspaceId),
        eq(accounts.status, 'active'),
        emailNotSuppressed(workspaceId, contacts.email, contacts.emailDomain),
        domainNotSuppressed(workspaceId, companies.domain),
        q
          ? sql`(lower(${contacts.fullName}) LIKE ${`%${q}%`} OR lower(coalesce(${contacts.email}, '')) LIKE ${`%${q}%`} OR lower(${companies.name}) LIKE ${`%${q}%`})`
          : undefined,
      ),
    )
    .orderBy(asc(companies.name), asc(contacts.fullName))
    .limit(opts.limit ?? 1000)
    .all();
}

// ---------------------------------------------------------------- deals

export interface DealInput {
  name: string;
  stage?: string | undefined;
  valueUsd?: number | null | undefined;
  outcome?: 'won' | 'lost' | null | undefined;
  closedAt?: number | null | undefined;
}

export function createDeal(
  tx: Tx,
  workspaceId: string,
  accountId: string,
  input: DealInput,
  now: number,
): string {
  requireAccount(tx, workspaceId, accountId);
  const stages = stagesOf(workspaceRow(tx, workspaceId).settings);
  const stage = input.stage ?? stages[0]!;
  if (!stages.includes(stage)) throw new CrmError('invalid_stage', `unknown stage: ${stage}`);
  const id = newId('deal');
  tx.insert(deals)
    .values({
      id,
      workspaceId,
      accountId,
      name: input.name.trim(),
      stage,
      valueUsd: input.valueUsd ?? null,
      outcome: input.outcome ?? null,
      closedAt: input.closedAt ?? (input.outcome ? now : null),
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

export function updateDeal(
  tx: Tx,
  workspaceId: string,
  dealId: string,
  input: Opt<DealInput>,
  userId: string | null,
  now: number,
): void {
  const deal = tx
    .select()
    .from(deals)
    .where(and(eq(deals.id, dealId), eq(deals.workspaceId, workspaceId)))
    .get();
  if (!deal) throw new CrmError('not_found', 'deal not found', 404);
  requireAccount(tx, workspaceId, deal.accountId);
  if (input.stage !== undefined) {
    const stages = stagesOf(workspaceRow(tx, workspaceId).settings);
    if (!stages.includes(input.stage))
      throw new CrmError('invalid_stage', `unknown stage: ${input.stage}`);
  }
  tx.update(deals)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.stage !== undefined ? { stage: input.stage } : {}),
      ...(input.valueUsd !== undefined ? { valueUsd: input.valueUsd } : {}),
      ...(input.outcome !== undefined
        ? { outcome: input.outcome, closedAt: input.outcome ? (input.closedAt ?? now) : null }
        : {}),
      updatedAt: now,
    })
    .where(eq(deals.id, dealId))
    .run();
  if (input.stage !== undefined && input.stage !== deal.stage) {
    tx.insert(activities)
      .values({
        id: newId('act'),
        workspaceId,
        accountId: deal.accountId,
        dealId,
        kind: 'stage_change',
        body: `Deal "${deal.name}" moved from ${deal.stage} to ${input.stage}`,
        meta: { from: deal.stage, to: input.stage, deal: dealId },
        at: now,
        userId,
      })
      .run();
  }
}

// ---------------------------------------------------------------- activities and next steps

export function logActivity(
  tx: Tx,
  workspaceId: string,
  input: {
    accountId: string;
    contactId?: string | null | undefined;
    dealId?: string | null | undefined;
    kind: 'note' | 'email' | 'call' | 'meeting' | 'reply';
    body: string;
    at?: number | undefined;
  },
  userId: string | null,
  now: number,
): string {
  requireAccount(tx, workspaceId, input.accountId);
  if (input.contactId) {
    const c = requireContact(tx, workspaceId, input.contactId);
    if (c.accountId !== input.accountId)
      throw new CrmError('mismatch', 'contact belongs to another account');
  }
  if (input.dealId) {
    const d = tx
      .select()
      .from(deals)
      .where(and(eq(deals.id, input.dealId), eq(deals.accountId, input.accountId)))
      .get();
    if (!d) throw new CrmError('mismatch', 'deal belongs to another account');
  }
  const id = newId('act');
  tx.insert(activities)
    .values({
      id,
      workspaceId,
      accountId: input.accountId,
      contactId: input.contactId ?? null,
      dealId: input.dealId ?? null,
      kind: input.kind,
      body: input.body,
      at: input.at ?? now,
      userId,
    })
    .run();
  tx.update(accounts).set({ updatedAt: now }).where(eq(accounts.id, input.accountId)).run();
  return id;
}

export function addNextStep(
  tx: Tx,
  workspaceId: string,
  accountId: string,
  input: { text: string; dueAt?: number | null | undefined },
  now: number,
): string {
  requireAccount(tx, workspaceId, accountId);
  const id = newId('ns');
  tx.insert(nextSteps)
    .values({
      id,
      workspaceId,
      accountId,
      text: input.text,
      dueAt: input.dueAt ?? null,
      createdAt: now,
    })
    .run();
  return id;
}

export function setNextStepDone(
  tx: Tx,
  workspaceId: string,
  id: string,
  done: boolean,
  now: number,
): void {
  const row = tx
    .select()
    .from(nextSteps)
    .where(and(eq(nextSteps.id, id), eq(nextSteps.workspaceId, workspaceId)))
    .get();
  if (!row) throw new CrmError('not_found', 'next step not found', 404);
  requireAccount(tx, workspaceId, row.accountId);
  tx.update(nextSteps)
    .set({ doneAt: done ? now : null })
    .where(eq(nextSteps.id, id))
    .run();
}

// ---------------------------------------------------------------- suppression list

export function addSuppression(
  tx: Tx,
  workspaceId: string,
  input: { kind: 'email' | 'domain'; value: string; reason: string },
  userId: string | null,
  now: number,
): { id: string; created: boolean } {
  const value = input.kind === 'email' ? normalizeEmail(input.value) : normalizeDomain(input.value);
  if (input.kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new CrmError('invalid_email', `not a valid email: ${input.value}`);
  }
  if (input.kind === 'domain' && !isValidDomain(value)) {
    throw new CrmError('invalid_domain', `not a valid domain: ${input.value}`);
  }
  const existing = tx
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(
      and(
        eq(suppressions.workspaceId, workspaceId),
        eq(suppressions.kind, input.kind),
        eq(suppressions.value, value),
      ),
    )
    .get();
  if (existing) return { id: existing.id, created: false };
  const id = newId('sup');
  tx.insert(suppressions)
    .values({
      id,
      workspaceId,
      kind: input.kind,
      value,
      reason: input.reason,
      createdBy: userId,
      createdAt: now,
    })
    .run();
  return { id, created: true };
}

export function listSuppressions(tx: Tx, workspaceId: string) {
  return tx
    .select()
    .from(suppressions)
    .where(or(eq(suppressions.workspaceId, workspaceId), isNull(suppressions.workspaceId)))
    .orderBy(sql`${suppressions.createdAt} DESC`)
    .all();
}
