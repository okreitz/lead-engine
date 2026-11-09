import { CSRF_HEADER, SESSION_COOKIE } from '@le/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { buildApi } from '../src/api/server.ts';
import { auditLog, providerKeys, sessions, users } from '../src/db/schema.ts';
import { decryptSecret, encryptSecret } from '../src/crypto/secrets.ts';
import { maskSecrets } from '../src/log-mask.ts';
import { clientFor, makeCtx, setupClient, TEST_MASTER_KEY } from './helpers.ts';

describe('setup and login', () => {
  it('creates the first user with an argon2id hash and refuses a second setup', async () => {
    const c = await setupClient();
    const user = c.ctx.db.select().from(users).get()!;
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    const again = await c.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { email: 'x@example.com', password: 'another long password', workspaceName: 'X' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('requires LE_SETUP_TOKEN when bound to a non-loopback interface', async () => {
    const ctx = makeCtx({ host: '0.0.0.0', setupToken: 'a-very-long-setup-token' });
    const app = buildApi(ctx, { logLevel: 'silent' });
    const body = { email: 'o@example.com', password: 'correct horse battery', workspaceName: 'A' };
    const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: body });
    expect(bad.statusCode).toBe(403);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { ...body, setupToken: 'a-very-long-setup-token' },
    });
    expect(ok.statusCode).toBe(201);
  });

  it('sets an httpOnly SameSite=Lax session cookie and stores only its hash', async () => {
    const c = await setupClient();
    const res = await c.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'OWNER@example.com', password: 'correct horse battery' },
    });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((x) => x.name === SESSION_COOKIE)!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    const rows = c.ctx.db.select().from(sessions).all();
    expect(rows.some((r) => r.id === cookie.value)).toBe(false);
  });

  it('rejects wrong passwords and audits the failure', async () => {
    const c = await setupClient();
    const res = await c.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'owner@example.com', password: 'wrong password' },
    });
    expect(res.statusCode).toBe(401);
    const actions = c.ctx.db
      .select()
      .from(auditLog)
      .all()
      .map((a) => a.action);
    expect(actions).toContain('auth.login_failed');
  });

  it('rate-limits repeated login attempts', async () => {
    const c = await setupClient();
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const r = await c.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'nobody@example.com', password: 'nope' },
      });
      last = r.statusCode;
    }
    expect(last).toBe(429);
  });
});

describe('session auth and CSRF', () => {
  it('rejects unauthenticated requests', async () => {
    const c = await setupClient();
    const res = await c.app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('requires the CSRF header on unsafe methods', async () => {
    const c = await setupClient();
    const noCsrf = await c.app.inject({
      method: 'PATCH',
      url: '/api/v1/workspace',
      cookies: { [SESSION_COOKIE]: c.cookie },
      payload: { name: 'Renamed' },
    });
    expect(noCsrf.statusCode).toBe(403);
    const wrong = await c.app.inject({
      method: 'PATCH',
      url: '/api/v1/workspace',
      cookies: { [SESSION_COOKIE]: c.cookie },
      headers: { [CSRF_HEADER]: 'nope' },
      payload: { name: 'Renamed' },
    });
    expect(wrong.statusCode).toBe(403);
    const ok = await c.send('PATCH', '/api/v1/workspace', { name: 'Renamed' });
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe('Renamed');
  });

  it('logs out', async () => {
    const c = await setupClient();
    expect((await c.send('POST', '/api/v1/auth/logout')).status).toBe(200);
    expect((await c.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('expires idle sessions', async () => {
    let t = 1_700_000_000_000;
    const ctx = makeCtx({}, () => t);
    const c = await setupClient(ctx);
    t += 8 * 24 * 3600_000;
    expect((await c.get('/api/v1/auth/me')).status).toBe(401);
  });
});

describe('workspaces and members', () => {
  it('lets members read but not change owner-only settings', async () => {
    const owner = await setupClient();
    const add = await owner.send('POST', '/api/v1/workspace/members', {
      email: 'member@example.com',
      password: 'member password 123',
    });
    expect(add.status).toBe(201);
    const login = await owner.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'member@example.com', password: 'member password 123' },
    });
    const member = clientFor(
      owner.app,
      owner.ctx,
      login.cookies.find((x) => x.name === SESSION_COOKIE)!.value,
      login.json().csrfToken,
    );
    expect((await member.get('/api/v1/workspace')).status).toBe(200);
    expect(
      (await member.send('PATCH', '/api/v1/workspace', { monthlyBudgetUsd: 500 })).status,
    ).toBe(403);
  });

  it('deletes a workspace only when its exact name is typed', async () => {
    const c = await setupClient();
    expect((await c.send('DELETE', '/api/v1/workspace', { confirmName: 'acme' })).status).toBe(400);
    expect((await c.send('DELETE', '/api/v1/workspace', { confirmName: 'Acme' })).status).toBe(200);
    const me = await c.get('/api/v1/auth/me');
    expect(me.body.workspace).toBeNull();
    const actions = c.ctx.db
      .select()
      .from(auditLog)
      .all()
      .map((a) => a.action);
    expect(actions).toContain('workspace.delete');
  });

  it('audits budget changes', async () => {
    const c = await setupClient();
    await c.send('PATCH', '/api/v1/workspace', { monthlyBudgetUsd: 20 });
    const row = c.ctx.db.select().from(auditLog).where(eq(auditLog.action, 'budget.update')).get();
    expect(row?.details).toMatchObject({ from: 50, to: 20 });
  });
});

describe('API tokens', () => {
  it('a read token can GET token-enabled routes only', async () => {
    const c = await setupClient();
    const created = await c.send('POST', '/api/v1/tokens', {
      name: 'Ground Control',
      scope: 'read',
    });
    const token = created.body.token as string;
    const auth = { authorization: `Bearer ${token}` };
    const ws = await c.app.inject({ method: 'GET', url: '/api/v1/workspace', headers: auth });
    expect(ws.statusCode).toBe(200);
    const members = await c.app.inject({
      method: 'GET',
      url: '/api/v1/workspace/members',
      headers: auth,
    });
    expect(members.statusCode).toBe(403);
    const patch = await c.app.inject({
      method: 'PATCH',
      url: '/api/v1/workspace',
      headers: auth,
      payload: {},
    });
    expect(patch.statusCode).toBe(403);
  });

  it('revoked tokens stop working', async () => {
    const c = await setupClient();
    const created = await c.send('POST', '/api/v1/tokens', { name: 't', scope: 'read' });
    await c.send('DELETE', `/api/v1/tokens/${created.body.id}`);
    const res = await c.app.inject({
      method: 'GET',
      url: '/api/v1/workspace',
      headers: { authorization: `Bearer ${created.body.token}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('provider keys', () => {
  it('stores keys encrypted and never returns them', async () => {
    const c = await setupClient();
    const put = await c.send('PUT', '/api/v1/provider-keys/icypeas', { key: 'icy-secret-key-123' });
    expect(put.status).toBe(200);
    const row = c.ctx.db.select().from(providerKeys).get()!;
    expect(row.encryptedKey).not.toContain('icy-secret');
    const list = await c.get('/api/v1/provider-keys');
    expect(JSON.stringify(list.body)).not.toContain('icy-secret');
    expect(
      list.body.providers.find((p: { provider: string }) => p.provider === 'icypeas').configured,
    ).toBe(true);
    const key = Buffer.from(TEST_MASTER_KEY, 'base64');
    expect(decryptSecret(key, row.workspaceId, 'icypeas', row.encryptedKey)).toBe(
      'icy-secret-key-123',
    );
    const actions = c.ctx.db
      .select()
      .from(auditLog)
      .all()
      .map((a) => a.action);
    expect(actions).toContain('provider_key.set');
  });

  it('answers 503 when LE_MASTER_KEY is missing', async () => {
    const c = await setupClient(makeCtx({ masterKey: null }));
    const put = await c.send('PUT', '/api/v1/provider-keys/serper', { key: 'serper-key-12345' });
    expect(put.status).toBe(503);
  });
});

describe('secret encryption', () => {
  const key = Buffer.alloc(32, 1);
  it('round-trips and binds ciphertext to workspace and provider', () => {
    const enc = encryptSecret(key, 'ws_1', 'serper', 'abc');
    expect(decryptSecret(key, 'ws_1', 'serper', enc)).toBe('abc');
    expect(() => decryptSecret(key, 'ws_2', 'serper', enc)).toThrow();
    expect(() => decryptSecret(key, 'ws_1', 'icypeas', enc)).toThrow();
    expect(() => decryptSecret(Buffer.alloc(32, 2), 'ws_1', 'serper', enc)).toThrow();
  });
  it('uses a fresh IV each time', () => {
    expect(encryptSecret(key, 'w', 'p', 'x')).not.toBe(encryptSecret(key, 'w', 'p', 'x'));
  });
});

describe('maskSecrets', () => {
  it('masks keys and tokens', () => {
    const s = maskSecrets(
      'failed with sk-ant-api03-abcdefghijklmnop and Bearer le_tok_abcdefghijklmnopqrstuvwxyz api_key=12345678',
    );
    expect(s).not.toContain('abcdefghijklmnop');
    expect(s).not.toContain('12345678');
    expect(s).toContain('Bearer ***');
  });
});
