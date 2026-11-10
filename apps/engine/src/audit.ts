import type { Db } from './db/client.ts';
import { auditLog } from './db/schema.ts';
import { newId } from './ids.ts';

export interface AuditEntry {
  workspaceId: string | null;
  userId: string | null;
  action: string;
  target: string;
  details?: Record<string, unknown>;
}

/**
 * Appends to `AuditLog` (SPEC §10): logins, exports, suppression, budget, provider-key and
 * token changes, and deletions. Never put secrets in `details`.
 */
export function audit(db: Db, entry: AuditEntry, now = Date.now()): void {
  db.insert(auditLog)
    .values({
      id: newId('aud'),
      workspaceId: entry.workspaceId,
      userId: entry.userId,
      action: entry.action,
      target: entry.target,
      details: entry.details ?? {},
      at: now,
    })
    .run();
}
