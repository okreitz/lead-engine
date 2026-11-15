import { CrmError } from '../crm/accounts.ts';
export { createContact } from '../crm/records.ts';

/** Runs a CRM write; a refused record (suppressed, not US) returns null instead of throwing. */
export function CrmErrorGuard<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch (err) {
    if (err instanceof CrmError) return null;
    throw err;
  }
}
