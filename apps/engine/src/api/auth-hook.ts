import { timingSafeEqual } from 'node:crypto';
import { CSRF_HEADER, SESSION_COOKIE } from '@le/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { lookupApiToken, lookupSession, type Auth } from '../auth/sessions.ts';
import type { AppContext } from './context.ts';
import { HttpError } from './http.ts';

declare module 'fastify' {
  interface FastifyRequest {
    auth: Auth | null;
  }
  interface FastifyContextConfig {
    /** No authentication (health, auth state, setup, login). */
    public?: boolean;
    /** Bearer tokens allowed: 'read' (any token, GET only) or 'write' (write-scope tokens). */
    token?: 'read' | 'write';
    /** Only workspace owners (sessions). */
    owner?: boolean;
    /** Route works without an active workspace (auth/me, create workspace). */
    noWorkspace?: boolean;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m?.[1] ?? null;
}

/**
 * Authenticates every route that isn't marked `public` (SPEC §7, §10):
 * - a session cookie (web app), with a CSRF header on unsafe methods, or
 * - a bearer API token, only on routes that opt in with `config.token`.
 */
export function registerAuthHook(app: FastifyInstance, ctx: AppContext): void {
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (request) => {
    const cfg = request.routeOptions.config;
    if (cfg.public || !request.routeOptions.url) return; // 404s fall through to the not-found handler

    const now = ctx.now();
    const token = bearer(request);
    if (token) {
      const auth = lookupApiToken(ctx.db, token, now);
      if (!auth) throw new HttpError(401, 'invalid_token');
      if (!cfg.token)
        throw new HttpError(403, 'token_not_allowed', 'this route needs a login session');
      if (auth.scope === 'read' && !SAFE_METHODS.has(request.method)) {
        throw new HttpError(403, 'read_only_token');
      }
      if (cfg.token === 'write' && auth.scope !== 'write')
        throw new HttpError(403, 'read_only_token');
      request.auth = auth;
      return;
    }

    const cookie = request.cookies[SESSION_COOKIE];
    const session = cookie ? lookupSession(ctx.db, cookie, now) : null;
    if (!session) throw new HttpError(401, 'unauthenticated');

    if (!SAFE_METHODS.has(request.method)) {
      const sent = request.headers[CSRF_HEADER];
      if (typeof sent !== 'string' || !safeEqual(sent, session.csrfToken)) {
        throw new HttpError(403, 'csrf', 'missing or invalid CSRF token');
      }
    }
    if (!cfg.noWorkspace && !session.workspaceId) {
      throw new HttpError(409, 'no_workspace', 'select or create a workspace');
    }
    if (cfg.owner && session.role !== 'owner') throw new HttpError(403, 'owner_only');
    request.auth = session;
  });
}
