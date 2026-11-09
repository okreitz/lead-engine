import { loadConfig } from '../config.ts';
import { openDb } from './client.ts';
import { runMigrations } from './migrate.ts';

const config = loadConfig();
const db = openDb(config.dbPath);
runMigrations(db);
db.$client.close();
console.log(`migrations applied to ${config.dbPath}`);
