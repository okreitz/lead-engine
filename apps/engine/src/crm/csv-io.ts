/**
 * CSV import and export for accounts, contacts and deals (SPEC §6). Imports are US-only
 * and skip suppressed rows; exports never include suppressed records.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';
import { accounts, companies, deals } from '../db/schema.ts';
import { normalizeDomain } from '../suppression.ts';
import { createAccount, CrmError, listAccounts } from './accounts.ts';
import { parseCsvObjects, toCsv } from './csv.ts';
import { domainNotSuppressed } from './filters.ts';
import { createContact, createDeal, listContacts } from './records.ts';
import { EMAIL_STATUS_VALUES } from '@le/shared';

export const MAX_IMPORT_ROWS = 5_000;

export interface ImportReport {
  created: number;
  existing: number;
  skipped: { row: number; reason: string }[];
}

const num = (v: string | undefined) => (v ? Number(v.replace(/[$,\s]/g, '')) : undefined);

function accountIdForDomain(tx: Tx, workspaceId: string, domain: string): string | null {
  const row = tx
    .select({ id: accounts.id })
    .from(accounts)
    .innerJoin(companies, eq(companies.id, accounts.companyId))
    .where(
      and(eq(accounts.workspaceId, workspaceId), eq(companies.domain, normalizeDomain(domain))),
    )
    .get();
  return row?.id ?? null;
}

/** Each row runs in its own savepoint, so one bad row doesn't undo the others. */
export function importCsv(
  tx: Tx,
  workspaceId: string,
  entity: 'accounts' | 'contacts' | 'deals',
  text: string,
  now: number,
): ImportReport {
  const rows = parseCsvObjects(text);
  if (rows.length > MAX_IMPORT_ROWS)
    throw new CrmError('too_many_rows', `at most ${MAX_IMPORT_ROWS} rows per import`);
  const report: ImportReport = { created: 0, existing: 0, skipped: [] };
  rows.forEach((r, idx) => {
    const rowNo = idx + 2; // 1-based, after the header
    try {
      tx.transaction((t) => {
        if (entity === 'accounts') {
          if (!r.domain) throw new CrmError('missing', 'domain is required');
          if (!r.country) throw new CrmError('missing', 'country is required (US only)');
          const res = createAccount(
            t,
            workspaceId,
            {
              domain: r.domain,
              name: r.name || r.domain,
              country: r.country,
              state: r.state || null,
              city: r.city || null,
              industry: r.industry || null,
              naics: r.naics || null,
              sizeRange: r.size_range || r.size || null,
              foundedYear: num(r.founded_year) ?? null,
              stage: r.stage || undefined,
            },
            'manual',
            now,
          );
          if (res.created) report.created++;
          else report.existing++;
        } else if (entity === 'contacts') {
          const domain = r.account_domain || r.domain || r.company_domain;
          if (!domain) throw new CrmError('missing', 'account_domain is required');
          const accountId = accountIdForDomain(t, workspaceId, domain);
          if (!accountId)
            throw new CrmError('missing', `no account for ${domain}; import accounts first`);
          if (!r.full_name && !r.name) throw new CrmError('missing', 'full_name is required');
          const status = r.email_status as (typeof EMAIL_STATUS_VALUES)[number];
          createContact(
            t,
            workspaceId,
            accountId,
            {
              fullName: r.full_name || r.name!,
              title: r.title || null,
              seniority: r.seniority || null,
              department: r.department || null,
              email: r.email || null,
              emailStatus: EMAIL_STATUS_VALUES.includes(status) ? status : null,
              phone: r.phone || null,
            },
            { source: 'csv_import' },
            now,
          );
          report.created++;
        } else {
          const domain = r.account_domain || r.domain;
          if (!domain) throw new CrmError('missing', 'account_domain is required');
          const accountId = accountIdForDomain(t, workspaceId, domain);
          if (!accountId)
            throw new CrmError('missing', `no account for ${domain}; import accounts first`);
          if (!r.name) throw new CrmError('missing', 'name is required');
          const outcome = r.outcome === 'won' || r.outcome === 'lost' ? r.outcome : null;
          createDeal(
            t,
            workspaceId,
            accountId,
            {
              name: r.name,
              stage: r.stage || undefined,
              valueUsd: num(r.value_usd) ?? null,
              outcome,
            },
            now,
          );
          report.created++;
        }
      });
    } catch (err) {
      if (err instanceof CrmError) report.skipped.push({ row: rowNo, reason: err.message });
      else throw err;
    }
  });
  return report;
}

export function exportCsv(
  tx: Tx,
  workspaceId: string,
  entity: 'accounts' | 'contacts' | 'deals',
): { csv: string; rows: number } {
  if (entity === 'accounts') {
    const rows = listAccounts(tx, workspaceId, { limit: 100_000 });
    const cols = [
      'domain',
      'name',
      'state',
      'industry',
      'size_range',
      'stage',
      'fit_score',
      'intent_score',
      'priority',
      'first_source',
      'created_at',
    ];
    return {
      rows: rows.length,
      csv: toCsv(
        cols,
        rows.map((r) => ({
          domain: r.domain,
          name: r.name,
          state: r.state,
          industry: r.industry,
          size_range: r.sizeRange,
          stage: r.stage,
          fit_score: r.fitScore,
          intent_score: r.intentScore,
          priority: r.priority,
          first_source: r.firstSource,
          created_at: new Date(r.createdAt).toISOString(),
        })),
      ),
    };
  }
  if (entity === 'contacts') {
    const rows = listContacts(tx, workspaceId, { limit: 100_000 });
    const cols = [
      'account_domain',
      'company',
      'full_name',
      'title',
      'seniority',
      'department',
      'email',
      'email_status',
      'phone',
    ];
    return {
      rows: rows.length,
      csv: toCsv(
        cols,
        rows.map((r) => ({
          account_domain: r.domain,
          company: r.company,
          full_name: r.fullName,
          title: r.title,
          seniority: r.seniority,
          department: r.department,
          email: r.email,
          email_status: r.emailStatus,
          phone: r.phone,
        })),
      ),
    };
  }
  const rows = tx
    .select({ deal: deals, domain: companies.domain, company: companies.name })
    .from(deals)
    .innerJoin(accounts, eq(accounts.id, deals.accountId))
    .innerJoin(companies, eq(companies.id, accounts.companyId))
    .where(
      and(eq(deals.workspaceId, workspaceId), domainNotSuppressed(workspaceId, companies.domain)),
    )
    .orderBy(desc(deals.updatedAt))
    .all();
  const cols = ['account_domain', 'company', 'name', 'stage', 'value_usd', 'outcome', 'closed_at'];
  return {
    rows: rows.length,
    csv: toCsv(
      cols,
      rows.map((r) => ({
        account_domain: r.domain,
        company: r.company,
        name: r.deal.name,
        stage: r.deal.stage,
        value_usd: r.deal.valueUsd,
        outcome: r.deal.outcome,
        closed_at: r.deal.closedAt ? new Date(r.deal.closedAt).toISOString() : '',
      })),
    ),
  };
}
