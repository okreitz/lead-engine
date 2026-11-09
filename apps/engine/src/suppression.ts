import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Tx } from './db/client.ts';
import { suppressions } from './db/schema.ts';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Lower-case, strip scheme, path and a leading `www.`. */
export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0] ?? '';
  d = d
    .replace(/:\d+$/, '')
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  return d;
}

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  return at > 0 ? normalizeDomain(email.slice(at + 1)) : null;
}

/** The domain and every parent domain, e.g. a.b.com → [a.b.com, b.com]. */
export function domainAndParents(domain: string): string[] {
  const parts = normalizeDomain(domain).split('.');
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join('.'));
  return out;
}

/**
 * Checks the global and workspace suppression lists (SPEC §9). A suppressed domain also
 * suppresses its subdomains and every email at it.
 */
export function findSuppression(
  db: Tx,
  workspaceId: string,
  subjects: { emails?: string[]; domains?: string[] },
): { kind: 'email' | 'domain'; value: string } | null {
  const emails = (subjects.emails ?? []).map(normalizeEmail);
  const domains = new Set<string>();
  for (const d of subjects.domains ?? []) for (const p of domainAndParents(d)) domains.add(p);
  for (const e of emails) {
    const d = emailDomain(e);
    if (d) for (const p of domainAndParents(d)) domains.add(p);
  }
  if (emails.length === 0 && domains.size === 0) return null;
  const conds = [];
  if (emails.length)
    conds.push(and(eq(suppressions.kind, 'email'), inArray(suppressions.value, emails)));
  if (domains.size)
    conds.push(and(eq(suppressions.kind, 'domain'), inArray(suppressions.value, [...domains])));
  const row = db
    .select({ kind: suppressions.kind, value: suppressions.value })
    .from(suppressions)
    .where(
      and(
        or(eq(suppressions.workspaceId, workspaceId), isNull(suppressions.workspaceId)),
        or(...conds),
      ),
    )
    .get();
  return row ?? null;
}
