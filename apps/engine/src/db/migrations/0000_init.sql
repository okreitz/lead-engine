-- Phase 0: empty first migration. Tables from SPEC §3 arrive in Phase 1.
-- Drizzle rejects a migration with no statements, so this one runs a no-op.
SELECT 1;
