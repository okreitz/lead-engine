import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/**
 * SQL guards that hide suppressed records in every view and export (SPEC §6, §9). They are
 * evaluated at query time against the global and workspace lists, so removing a suppression
 * restores the records and adding one hides them at once. A domain covers its subdomains.
 */
export function domainNotSuppressed(workspaceId: string, domain: SQLWrapper): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM suppressions s
    WHERE (s.workspace_id = ${workspaceId} OR s.workspace_id IS NULL)
      AND s.kind = 'domain'
      AND (${domain} = s.value OR ${domain} LIKE '%.' || s.value))`;
}

export function emailNotSuppressed(
  workspaceId: string,
  email: SQLWrapper,
  emailDomain: SQLWrapper,
): SQL {
  return sql`(${email} IS NULL OR (
    NOT EXISTS (SELECT 1 FROM suppressions s
      WHERE (s.workspace_id = ${workspaceId} OR s.workspace_id IS NULL)
        AND s.kind = 'email' AND s.value = lower(${email}))
    AND ${domainNotSuppressed(workspaceId, emailDomain)}))`;
}
