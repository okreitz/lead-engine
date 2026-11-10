import { timingSafeEqual } from 'node:crypto';
import {
  changePasswordBodySchema,
  loginBodySchema,
  SESSION_COOKIE,
  setupBodySchema,
  switchWorkspaceBodySchema,
} from '@le/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { audit } from '../../audit.ts';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../../auth/passwords.ts';
import {
  createSession,
  deleteSession,
  SESSION_TTL_MS,
  setSessionWorkspace,
} from '../../auth/sessions.ts';
import { isLoopback } from '../../config.ts';
import { memberships, sessions, users, workspaces } from '../../db/schema.ts';
import { newId } from '../../ids.ts';
import { createWorkspace } from '../../workspaces.ts';
import type { AppContext } from '../context.ts';
import { HttpError, parse, sessionOf } from '../http.ts';

/** Small in-memory limiter for login attempts: 10 per 15 minutes per IP and per email. */
class AttemptLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  allow(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.hits.clear(); // bound memory
    return true;
  }
}

function setSessionCookie(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
): void {
  const secure =
    ctx.config.cookieSecure === 'true' ||
    (ctx.config.cookieSecure === 'auto' && request.headers['x-forwarded-proto'] === 'https');
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function workspacesOfUser(ctx: AppContext, userId: string) {
  return ctx.db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(memberships.userId, userId))
    .orderBy(workspaces.name)
    .all();
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const limiter = new AttemptLimiter(10, 15 * 60_000);
  const userCount = () =>
    ctx.db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .get()?.n ?? 0;
  const setupTokenRequired = () => !isLoopback(ctx.config.host);

  app.get('/api/v1/auth/state', { config: { public: true } }, async () => ({
    needsSetup: userCount() === 0,
    setupTokenRequired: setupTokenRequired(),
  }));

  // First run only: creates the first user and workspace.
  app.post('/api/v1/auth/setup', { config: { public: true } }, async (request, reply) => {
    const body = parse(setupBodySchema, request.body);
    if (userCount() > 0) throw new HttpError(409, 'already_set_up');
    if (setupTokenRequired()) {
      const expected = ctx.config.setupToken;
      if (!expected) {
        throw new HttpError(
          403,
          'setup_token_unset',
          'set LE_SETUP_TOKEN to create the first user',
        );
      }
      const sent = Buffer.from(body.setupToken ?? '');
      const want = Buffer.from(expected);
      if (sent.length !== want.length || !timingSafeEqual(sent, want)) {
        throw new HttpError(403, 'invalid_setup_token');
      }
    }
    const now = ctx.now();
    const passwordHash = await hashPassword(body.password);
    const userId = newId('usr');
    const workspaceId = ctx.db.transaction((tx) => {
      tx.insert(users)
        .values({ id: userId, email: body.email, passwordHash, createdAt: now })
        .run();
      return createWorkspace(tx, { name: body.workspaceName, ownerUserId: userId, now });
    });
    audit(ctx.db, { workspaceId, userId, action: 'auth.setup', target: `user:${userId}` }, now);
    const { token, csrfToken } = createSession(ctx.db, userId, workspaceId, now);
    setSessionCookie(ctx, request, reply, token);
    return reply.code(201).send({ csrfToken });
  });

  app.post('/api/v1/auth/login', { config: { public: true } }, async (request, reply) => {
    const body = parse(loginBodySchema, request.body);
    const now = ctx.now();
    if (!limiter.allow(`ip:${request.ip}`, now) || !limiter.allow(`email:${body.email}`, now)) {
      throw new HttpError(429, 'too_many_attempts', 'too many login attempts; try again later');
    }
    const user = ctx.db.select().from(users).where(eq(users.email, body.email)).get();
    const ok = user ? await verifyPassword(user.passwordHash, body.password) : false;
    if (!user) await burnPasswordCheck(body.password);
    if (!user || !ok) {
      audit(
        ctx.db,
        {
          workspaceId: null,
          userId: user?.id ?? null,
          action: 'auth.login_failed',
          target: 'login',
        },
        now,
      );
      throw new HttpError(401, 'invalid_credentials', 'wrong email or password');
    }
    const first = workspacesOfUser(ctx, user.id)[0];
    const { token, csrfToken } = createSession(ctx.db, user.id, first?.id ?? null, now);
    audit(
      ctx.db,
      {
        workspaceId: first?.id ?? null,
        userId: user.id,
        action: 'auth.login',
        target: `user:${user.id}`,
      },
      now,
    );
    setSessionCookie(ctx, request, reply, token);
    return { csrfToken };
  });

  app.post('/api/v1/auth/logout', { config: { noWorkspace: true } }, async (request, reply) => {
    const auth = sessionOf(request);
    const cookie = request.cookies[SESSION_COOKIE];
    if (cookie) deleteSession(ctx.db, cookie);
    audit(
      ctx.db,
      {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        action: 'auth.logout',
        target: `user:${auth.userId}`,
      },
      ctx.now(),
    );
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/v1/auth/me', { config: { noWorkspace: true } }, async (request) => {
    const auth = sessionOf(request);
    const workspace = auth.workspaceId
      ? ctx.db.select().from(workspaces).where(eq(workspaces.id, auth.workspaceId)).get()
      : null;
    return {
      user: { id: auth.userId, email: auth.email },
      csrfToken: auth.csrfToken,
      role: auth.role,
      workspace: workspace ?? null,
      workspaces: workspacesOfUser(ctx, auth.userId),
    };
  });

  app.post('/api/v1/auth/switch', { config: { noWorkspace: true } }, async (request) => {
    const auth = sessionOf(request);
    const { workspaceId } = parse(switchWorkspaceBodySchema, request.body);
    const m = ctx.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, auth.userId), eq(memberships.workspaceId, workspaceId)))
      .get();
    if (!m) throw new HttpError(404, 'not_found');
    setSessionWorkspace(ctx.db, auth.sessionId, workspaceId);
    return { ok: true };
  });

  app.post('/api/v1/auth/password', { config: { noWorkspace: true } }, async (request) => {
    const auth = sessionOf(request);
    const body = parse(changePasswordBodySchema, request.body);
    const user = ctx.db.select().from(users).where(eq(users.id, auth.userId)).get();
    if (!user || !(await verifyPassword(user.passwordHash, body.currentPassword))) {
      throw new HttpError(401, 'invalid_credentials', 'current password is wrong');
    }
    const passwordHash = await hashPassword(body.newPassword);
    ctx.db.update(users).set({ passwordHash }).where(eq(users.id, auth.userId)).run();
    // Sign out every other session of this user.
    ctx.db
      .delete(sessions)
      .where(and(eq(sessions.userId, auth.userId), sql`${sessions.id} <> ${auth.sessionId}`))
      .run();
    audit(
      ctx.db,
      {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        action: 'auth.password_change',
        target: `user:${auth.userId}`,
      },
      ctx.now(),
    );
    return { ok: true };
  });
}
