import { CSRF_HEADER, SESSION_COOKIE } from '@le/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/api/context.ts';
import { buildApi } from '../src/api/server.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { openDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';

export const TEST_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

export function makeCtx(overrides: Partial<Config> = {}, now = () => Date.now()): AppContext {
  const db = openDb(':memory:');
  runMigrations(db);
  const config = {
    ...loadConfig({ LE_MASTER_KEY: TEST_MASTER_KEY, LE_JOBS: 'off' }),
    ...overrides,
  };
  return { db, config, now };
}

export interface Client {
  app: FastifyInstance;
  ctx: AppContext;
  cookie: string;
  csrf: string;
  get(url: string): Promise<{ status: number; body: any }>;
  send(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ): Promise<{ status: number; body: any }>;
}

/** Builds the API on a fresh in-memory DB and signs up the first user (owner of "Acme"). */
export async function setupClient(
  ctx: AppContext = makeCtx(),
  email = 'owner@example.com',
  password = 'correct horse battery',
): Promise<Client> {
  const app = buildApi(ctx, { logLevel: 'silent' });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: { email, password, workspaceName: 'Acme' },
  });
  if (res.statusCode !== 201) throw new Error(`setup failed: ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  return clientFor(app, ctx, cookie, res.json().csrfToken);
}

export function clientFor(
  app: FastifyInstance,
  ctx: AppContext,
  cookie: string,
  csrf: string,
): Client {
  const parseBody = (body: string) => {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  };
  return {
    app,
    ctx,
    cookie,
    csrf,
    async get(url) {
      const r = await app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: cookie } });
      return { status: r.statusCode, body: parseBody(r.body) };
    },
    async send(method, url, payload) {
      const r = await app.inject({
        method,
        url,
        cookies: { [SESSION_COOKIE]: cookie },
        headers: { [CSRF_HEADER]: csrf },
        ...(payload !== undefined ? { payload: payload as object } : {}),
      });
      return { status: r.statusCode, body: parseBody(r.body) };
    },
  };
}
