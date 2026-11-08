import type { Health } from '@le/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { VERSION } from '../version.ts';

export interface ApiOptions {
  logLevel?: string;
}

/**
 * The authenticated engine API on :4501 (SPEC §7). Phase 0 has only the health check;
 * session and token auth land in Phase 1, before any data route is added.
 */
export function buildApi(options: ApiOptions = {}): FastifyInstance {
  const app = Fastify({ logger: { level: options.logLevel ?? 'info' } });

  app.get('/api/v1/health', async (): Promise<Health> => {
    return { status: 'ok', service: 'engine', version: VERSION };
  });

  return app;
}
