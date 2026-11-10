import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.ts';
import { defaultMigrationsDir, runMigrations } from '../src/db/migrate.ts';

describe('migrations', () => {
  it('apply cleanly to an empty database', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const journal = JSON.parse(
      readFileSync(`${defaultMigrationsDir()}/meta/_journal.json`, 'utf8'),
    ) as { entries: unknown[] };
    const rows = db.$client.prepare('select count(*) as n from __drizzle_migrations').get() as {
      n: number;
    };
    expect(rows.n).toBe(journal.entries.length);
    db.$client.close();
  });

  it('keeps the companies FTS index in sync', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const ins = db.$client.prepare(
      "insert into companies (id, domain, name, country, sources, tech, updated_at) values (?, ?, ?, 'US', '[]', '[]', 0)",
    );
    ins.run('c1', 'acme.com', 'Acme Rockets');
    ins.run('c2', 'globex.com', 'Globex');
    const find = (q: string) =>
      db.$client
        .prepare(
          'select c.id from companies_fts f join companies c on c.rowid = f.rowid where companies_fts match ?',
        )
        .all(q)
        .map((r) => (r as { id: string }).id);
    expect(find('rock*')).toEqual(['c1']);
    db.$client.prepare("update companies set name = 'Globex Rockets' where id = 'c2'").run();
    expect(find('rock*').sort()).toEqual(['c1', 'c2']);
    db.$client.prepare("delete from companies where id = 'c1'").run();
    expect(find('rock*')).toEqual(['c2']);
  });
});
