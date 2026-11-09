import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';

describe('migrations', () => {
  it('apply cleanly to an empty database', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const rows = db.$client.prepare('select count(*) as n from __drizzle_migrations').get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
    db.$client.close();
  });
});
