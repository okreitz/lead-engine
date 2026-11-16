import { buildApi } from './api/server.ts';
import type { AppContext } from './api/context.ts';
import { GeoService } from './collector/geo.ts';
import { VisitPipeline } from './collector/pipeline.ts';
import { buildCollector } from './collector/server.ts';
import { scheduleConversations } from './conversations/poll.ts';
import { BlueskyStream, officialJetstream } from './conversations/sources/bluesky.ts';
import { purgeExpiredThreads } from './conversations/store.ts';
import { purgeIpLookupCache } from './providers/ipapi.ts';
import { purgeIpCompanies } from './visits/record.ts';
import { systemPtr } from './visits/ptr.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { workspaces } from './db/schema.ts';
import { rescoreWorkspace } from './crm/scoring.ts';
import { jobHandlers } from './jobs/handlers.ts';
import { JobRunner } from './jobs/queue.ts';

const config = loadConfig();

const db = openDb(config.dbPath);
runMigrations(db);

const geo = new GeoService(
  { dir: config.collector.geoDir, ipinfoToken: config.collector.ipinfoToken },
  { download: config.collector.geoDownload, now: Date.now },
);
const ctx: AppContext = { db, config, now: Date.now, geo };
const api = buildApi(ctx, { logLevel: config.logLevel });
const pipeline = new VisitPipeline({ ctx, geo: () => geo.current(), ptr: systemPtr() });
const collector = buildCollector(ctx, pipeline, {
  logLevel: config.logLevel,
  clientIpHeader: config.collector.clientIpHeader,
});
geo.start();

const runner = new JobRunner(ctx, jobHandlers(ctx));
if (config.jobs) runner.start();

// Stream 2: polls are queued when due; the Bluesky stream opens only while a workspace needs it.
const bluesky = new BlueskyStream(ctx, officialJetstream(config.bluesky.jetstreamUrl), {
  enabled: config.bluesky.enabled,
});
ctx.bluesky = bluesky;
const conversationTick = () => {
  try {
    if (config.jobs) scheduleConversations(ctx);
    bluesky.refresh();
  } catch (err) {
    api.log.error({ err: { message: (err as Error).message } }, 'conversation scheduler failed');
  }
};
const conversationTimer = setInterval(conversationTick, 60_000);
conversationTimer.unref();
setTimeout(conversationTick, 5_000).unref();

// Intent decays over time: rescore every workspace hourly (local, no paid calls).
const rescoreTimer = setInterval(() => {
  for (const ws of db.select({ id: workspaces.id }).from(workspaces).all()) {
    db.transaction((tx) => rescoreWorkspace(tx, ws.id, Date.now()));
  }
}, 3600_000);
rescoreTimer.unref();

// Retention (SPEC §9): ipapi.is lookups 30 days, expired IP map rows.
const purgeTimer = setInterval(() => {
  purgeIpLookupCache(ctx);
  purgeIpCompanies(ctx);
  purgeExpiredThreads(db, Date.now());
}, 3600_000);
purgeTimer.unref();

await api.listen({ host: config.host, port: config.enginePort });
await collector.app.listen({ host: config.host, port: config.collectorPort });

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  api.log.info({ signal }, 'shutting down');
  runner.stop();
  geo.stop();
  await bluesky.stop();
  await Promise.allSettled([api.close(), collector.app.close()]);
  await collector.queue.drain();
  db.$client.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
