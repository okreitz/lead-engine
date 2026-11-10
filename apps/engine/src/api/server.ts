import cookie from '@fastify/cookie';
import type { Health } from '@le/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { LOG_REDACT_PATHS, maskSecrets } from '../log-mask.ts';
import { VERSION } from '../version.ts';
import { registerAuthHook } from './auth-hook.ts';
import type { AppContext } from './context.ts';
import { HttpError } from './http.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerBudgetRoutes } from './routes/budget.ts';
import { registerCrmRoutes } from './routes/crm.ts';
import { registerOfferRoutes } from './routes/offers.ts';
import { registerSummaryRoutes } from './routes/summary.ts';
import { registerTodayRoutes } from './routes/today.ts';
import { registerWorkspaceRoutes } from './routes/workspaces.ts';

export interface ApiOptions {
  logLevel?: string;
}

/**
 * The authenticated engine API on :4501 (SPEC §7). Every route needs a session or a bearer
 * token unless it is marked `config.public` (see `auth-hook.ts`).
 */
export function buildApi(ctx: AppContext, options: ApiOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: { level: options.logLevel ?? 'info', redact: LOG_REDACT_PATHS },
    bodyLimit: 5 * 1024 * 1024, // CSV imports
    trustProxy: 'loopback,uniquelocal', // the Next.js proxy (same host or Docker network) sets X-Forwarded-*
  });

  app.register(cookie);
  app.register(async (scoped) => {
    registerAuthHook(scoped, ctx);

    scoped.get('/api/v1/health', { config: { public: true } }, async (): Promise<Health> => {
      return { status: 'ok', service: 'engine', version: VERSION };
    });
    registerAuthRoutes(scoped, ctx);
    registerWorkspaceRoutes(scoped, ctx);
    registerBudgetRoutes(scoped, ctx);
    registerCrmRoutes(scoped, ctx);
    registerOfferRoutes(scoped, ctx);
    registerSummaryRoutes(scoped, ctx);
    registerTodayRoutes(scoped, ctx);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply
        .code(status)
        .send({ error: 'bad_request', message: maskSecrets(String((error as Error).message)) });
    }
    request.log.error(
      { err: { message: maskSecrets(String((error as Error).message)) } },
      'unhandled error',
    );
    return reply.code(500).send({ error: 'internal', message: 'internal error' });
  });

  return app;
}
