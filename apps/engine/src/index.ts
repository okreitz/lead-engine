import { buildApi } from './api/server.ts';
import type { AppContext } from './api/context.ts';
import { buildCollector } from './collector/server.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';

const config = loadConfig();

const db = openDb(config.dbPath);
runMigrations(db);

const ctx: AppContext = { db, config, now: Date.now };
const api = buildApi(ctx, { logLevel: config.logLevel });
const collector = buildCollector({ logLevel: config.logLevel });

await api.listen({ host: config.host, port: config.enginePort });
await collector.listen({ host: config.host, port: config.collectorPort });

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  api.log.info({ signal }, 'shutting down');
  await Promise.allSettled([api.close(), collector.close()]);
  db.$client.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
