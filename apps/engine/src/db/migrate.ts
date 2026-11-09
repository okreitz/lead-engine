import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Db } from './client.ts';

/**
 * Applies checked-in Drizzle migrations. `LE_MIGRATIONS_DIR` overrides the folder
 * (the bundled build and the Docker image copy migrations next to dist/).
 */
export function runMigrations(db: Db, migrationsFolder = defaultMigrationsDir()): void {
  migrate(db, { migrationsFolder });
}

export function defaultMigrationsDir(): string {
  return process.env.LE_MIGRATIONS_DIR ?? fileURLToPath(new URL('./migrations', import.meta.url));
}
