#!/usr/bin/env node
/**
 * `pnpm rss`: measures idle RSS of the production web + engine processes (CLAUDE.md:
 * under 512 MB together on the VPS).
 *
 * Builds both apps (skip with --no-build), starts them on spare ports with a throwaway
 * database, warms them up (first-user setup, the main pages and API routes, a site and a
 * burst of collector page views), waits until idle, then samples the RSS of each process
 * tree. Exits 1 if the total is over the limit.
 *
 * Stream 2: an approved offer is written into the throwaway database (no LLM draft), the
 * scheduled polls are turned off (they would call HN and an LLM), and the engine's live Bluesky
 * Jetstream connection must be open, reading real posts, while the idle RSS is sampled.
 * `--no-bluesky` skips that part (e.g. offline).
 *
 * The collector loads the real DB-IP Lite country and ASN databases, as on the VPS: they are
 * downloaded into the throwaway data folder, or copied from --geo-dir=<folder> if given.
 *
 *   pnpm rss [--no-build] [--idle-seconds=20] [--limit-mb=512] [--geo-dir=<folder>] [--no-bluesky]
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const idleSeconds = Number(args['idle-seconds'] ?? 20);
const limitMb = Number(args['limit-mb'] ?? 512);
const PORTS = { web: 14500, engine: 14501, collector: 14511 };

function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')} failed`);
}

if (!args['no-build']) {
  run('pnpm', ['--filter', '@le/engine', 'build']);
  run('pnpm', ['--filter', '@le/web', 'build']);
}
const standalone = path.join(root, 'apps/web/.next/standalone');
const webServer = path.join(standalone, 'apps/web/server.js');
if (!existsSync(webServer)) throw new Error('web standalone build missing; run without --no-build');
// The standalone server serves static assets from next to itself (as in the Dockerfile).
cpSync(path.join(root, 'apps/web/.next/static'), path.join(standalone, 'apps/web/.next/static'), {
  recursive: true,
});

const dataDir = mkdtempSync(path.join(tmpdir(), 'le-rss-'));
const geoDir = path.join(dataDir, 'geo');
if (args['geo-dir']) cpSync(path.resolve(String(args['geo-dir'])), geoDir, { recursive: true });
const children = [];
function start(name, file, env, cwd) {
  const child = spawn(process.execPath, [file], {
    cwd,
    env: { ...process.env, NODE_ENV: 'production', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  children.push({ name, child });
  return child;
}
function cleanup() {
  for (const { child } of children) child.kill('SIGTERM');
  rmSync(dataDir, { recursive: true, force: true });
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

const engine = start(
  'engine',
  path.join(root, 'apps/engine/dist/index.js'),
  {
    LE_HOST: '127.0.0.1',
    LE_ENGINE_PORT: String(PORTS.engine),
    LE_COLLECTOR_PORT: String(PORTS.collector),
    LE_DB_PATH: path.join(dataDir, 'le.db'),
    LE_MASTER_KEY: randomBytes(32).toString('base64'),
    LE_LOG_LEVEL: 'warn',
    LE_GEO_DIR: geoDir,
    LE_GEO_DOWNLOAD: 'on',
  },
  path.join(root, 'apps/engine'),
);
const web = start(
  'web',
  webServer,
  {
    HOSTNAME: '127.0.0.1',
    PORT: String(PORTS.web),
    LE_ENGINE_URL: `http://127.0.0.1:${PORTS.engine}`,
    NEXT_TELEMETRY_DISABLED: '1',
  },
  path.join(standalone, 'apps/web'),
);

const base = `http://127.0.0.1:${PORTS.web}`;
async function waitFor(url) {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not come up`);
}
await waitFor(`http://127.0.0.1:${PORTS.engine}/api/v1/health`);
await waitFor(`${base}/login`);

// Warm up: create the first user through the web proxy, then load pages and API routes.
const setup = await fetch(`${base}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'rss@example.com',
    password: 'rss-measurement-pw',
    workspaceName: 'RSS',
  }),
});
if (setup.status !== 201)
  throw new Error(`warm-up setup failed: ${setup.status} ${await setup.text()}`);
const cookie = setup.headers
  .getSetCookie()
  .map((c) => c.split(';')[0])
  .join('; ');
const { csrfToken } = await setup.json();
const headers = { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' };
for (let i = 0; i < 20; i++) {
  const r = await fetch(`${base}/api/v1/accounts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ domain: `company${i}.com`, name: `Company ${i}`, country: 'US' }),
  });
  if (r.status !== 201) throw new Error(`warm-up account failed: ${r.status}`);
}
// Stream 1: a site, then wait for the country/ASN database and send collector traffic.
const siteRes = await fetch(`${base}/api/v1/sites`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ domain: 'rss-example.com' }),
});
if (siteRes.status !== 201) throw new Error(`warm-up site failed: ${siteRes.status}`);
const site = await siteRes.json();
let geo = null;
for (let i = 0; i < 240 && !geo?.ready; i++) {
  const r = await fetch(`${base}/api/v1/sites`, { headers: { cookie } });
  geo = (await r.json()).status.geo;
  if (!geo.ready) await new Promise((r) => setTimeout(r, 500));
}
if (!geo?.ready)
  throw new Error(`the country/ASN database did not load: ${geo?.error ?? 'timeout'}`);
console.log(`geo database loaded (${geo.source})`);
const ua =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
for (let i = 0; i < 300; i++) {
  // Public addresses across many networks; the collector reads X-Real-Ip from loopback peers.
  const ip = `${[81, 73, 172, 3, 24, 98, 107, 151][i % 8]}.${(i * 7) % 250}.${(i * 13) % 250}.${(i % 200) + 1}`;
  await fetch(`http://127.0.0.1:${PORTS.collector}/collect/v`, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain',
      origin: 'https://www.rss-example.com',
      'x-real-ip': ip,
      'user-agent': ua,
    },
    body: JSON.stringify({ siteKey: site.siteKey, path: ['/', '/pricing', '/demo'][i % 3] }),
  });
}
for (const p of [
  '/',
  '/accounts',
  '/pipeline',
  '/contacts',
  '/offer',
  '/settings',
  '/login',
  '/visitors',
])
  await fetch(base + p, { headers: { cookie } });
for (const p of [
  '/summary',
  '/accounts',
  '/pipeline',
  '/budget',
  '/contacts',
  `/visitors?siteId=${site.id}`,
])
  await fetch(`${base}/api/v1${p}`, { headers: { cookie } });

// Stream 2: approve an offer so the engine opens its Bluesky Jetstream connection.
let bluesky = null;
if (!args['no-bluesky']) {
  const Database = createRequire(path.join(root, 'apps/engine/package.json'))('better-sqlite3');
  const db = new Database(path.join(dataDir, 'le.db'));
  const ws = db.prepare('SELECT id FROM workspaces').get().id;
  const now = Date.now();
  const profile = {
    name: 'RSS offer',
    summary: 'A lightweight CRM for small agencies.',
    valueProps: ['Simple'],
    competitors: ['HubSpot', 'Salesforce'],
    icp: {
      industries: [],
      naics: [],
      employeeRange: '1-200',
      revenueRange: null,
      states: [],
      techUses: [],
      techAvoids: [],
      mustHave: [],
      exclude: [],
    },
    personas: [
      {
        title: 'Founder',
        seniority: 'Owner',
        department: 'Exec',
        pains: ['cost'],
        titleKeywords: [],
      },
    ],
    intentPhrases: [
      'crm alternative',
      'hubspot alternative',
      'salesforce alternative',
      'crm recommendations',
      'looking for a crm',
      'which crm',
    ].map((phrase) => ({ phrase, kind: 'seeking', negative: ['hiring'] })),
  };
  db.prepare(
    `INSERT INTO offers (id, workspace_id, name, website_url, created_at, updated_at)
     VALUES ('off_rss', ?, 'RSS offer', 'https://rss-example.com', ?, ?)`,
  ).run(ws, now, now);
  db.prepare(
    `INSERT INTO offer_versions (id, offer_id, workspace_id, version, status, source, data, created_at, updated_at, approved_at)
     VALUES ('ofv_rss', 'off_rss', ?, 1, 'approved', 'human', ?, ?, ?, ?)`,
  ).run(ws, JSON.stringify(profile), now, now, now);
  db.close();
  for (const source of ['hn', 'stackexchange', 'github', 'reddit']) {
    await fetch(`${base}/api/v1/conversations/sources/${source}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ enabled: false }),
    });
  }
  // The scheduler refreshes the Bluesky matchers every minute.
  for (let i = 0; i < 90 && !bluesky?.connected; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const r = await fetch(`${base}/api/v1/conversations/sources`, { headers: { cookie } });
    bluesky = (await r.json()).sources.find((x) => x.source === 'bluesky')?.live ?? null;
  }
  if (!bluesky?.connected) throw new Error('the Bluesky Jetstream connection did not open');
  await new Promise((r) => setTimeout(r, 5000));
  const r = await fetch(`${base}/api/v1/conversations/sources`, { headers: { cookie } });
  bluesky = (await r.json()).sources.find((x) => x.source === 'bluesky')?.live;
  if (!bluesky.events) throw new Error('Jetstream is connected but no posts arrived');
  console.log(`Jetstream connected: ${bluesky.events} posts read so far`);
  await fetch(`${base}/inbox`, { headers: { cookie } });
  await fetch(`${base}/api/v1/inbox`, { headers: { cookie } });
}

console.log(`warm-up done; waiting ${idleSeconds}s for idle…`);
await new Promise((r) => setTimeout(r, idleSeconds * 1000));

/** RSS in KB of a process and all its descendants (`ps` works on Linux and macOS). */
function treeRssKb(pid) {
  const out = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' }).stdout;
  const rows = out
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map();
  for (const [p, pp] of rows) kids.set(pp, [...(kids.get(pp) ?? []), p]);
  const rss = new Map(rows.map(([p, , r]) => [p, r]));
  let total = 0;
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop();
    total += rss.get(p) ?? 0;
    stack.push(...(kids.get(p) ?? []));
  }
  return total;
}

const samples = [];
for (let i = 0; i < 5; i++) {
  samples.push({ engine: treeRssKb(engine.pid), web: treeRssKb(web.pid) });
  await new Promise((r) => setTimeout(r, 1000));
}
const peak = (k) => Math.max(...samples.map((s) => s[k])) / 1024;
const engineMb = peak('engine');
const webMb = peak('web');
const total = engineMb + webMb;
console.log('\nIdle RSS (peak of 5 samples):');
console.log(`  engine (API + collector + jobs)  ${engineMb.toFixed(1)} MB`);
console.log(`  web (Next.js standalone)         ${webMb.toFixed(1)} MB`);
console.log(`  total                            ${total.toFixed(1)} MB  (limit ${limitMb} MB)`);
if (bluesky) {
  const r = await fetch(`${base}/api/v1/conversations/sources`, { headers: { cookie } });
  const live = (await r.json()).sources.find((x) => x.source === 'bluesky')?.live;
  console.log(
    `  Bluesky Jetstream: ${live?.connected ? 'connected' : 'NOT connected'} while sampling, ${live?.events ?? 0} posts read, ${live?.matched ?? 0} matched`,
  );
  if (!live?.connected) {
    console.error('FAIL: the Jetstream connection closed during the measurement');
    process.exit(1);
  }
}
if (total > limitMb) {
  console.error('FAIL: over the memory limit');
  process.exit(1);
}
console.log('OK');
process.exit(0);
