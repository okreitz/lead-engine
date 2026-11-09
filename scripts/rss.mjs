#!/usr/bin/env node
/**
 * `pnpm rss`: measures idle RSS of the production web + engine processes (CLAUDE.md:
 * under 512 MB together on the VPS).
 *
 * Builds both apps (skip with --no-build), starts them on spare ports with a throwaway
 * database, warms them up (first-user setup, the main pages and API routes), waits until
 * idle, then samples the RSS of each process tree. Exits 1 if the total is over the limit.
 *
 *   pnpm rss [--no-build] [--idle-seconds=20] [--limit-mb=512]
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

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
for (const p of ['/', '/accounts', '/pipeline', '/contacts', '/offer', '/settings', '/login'])
  await fetch(base + p, { headers: { cookie } });
for (const p of ['/summary', '/accounts', '/pipeline', '/budget', '/contacts'])
  await fetch(`${base}/api/v1${p}`, { headers: { cookie } });

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
if (total > limitMb) {
  console.error('FAIL: over the memory limit');
  process.exit(1);
}
console.log('OK');
process.exit(0);
