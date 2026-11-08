import {
  COLLECTOR_BODY_LIMIT_BYTES,
  collectIdentifySchema,
  collectVisitSchema,
  type Health,
} from '@le/shared';
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import type { ZodType } from 'zod';
import { VERSION } from '../version.ts';

export interface CollectorOptions {
  logLevel?: string;
}

/**
 * The public, unauthenticated, write-only collector on :4511 (SPEC §5.2, §10).
 *
 * Phase 0 is a stub: it enforces the 2 KB body cap and validates the request schema,
 * then answers 501. Nothing is stored. Request logging is off and the request serialiser
 * omits the client IP, so IPs never reach the logs; the drop-before-storage pipeline arrives in Phase 3.
 */
export function buildCollector(options: CollectorOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: options.logLevel ?? 'info',
      // Error logs still serialise the request; keep the client IP out of them.
      serializers: {
        req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
      },
    },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: COLLECTOR_BODY_LIMIT_BYTES,
  });

  app.get('/healthz', async (): Promise<Health> => {
    return { status: 'ok', service: 'collector', version: VERSION };
  });

  const stub = (schema: ZodType) => async (request: FastifyRequest, reply: FastifyReply) => {
    if (!schema.safeParse(request.body).success) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    return reply.code(501).send({ error: 'not_implemented' });
  };

  app.post('/collect/v', stub(collectVisitSchema));
  app.post('/collect/identify', stub(collectIdentifySchema));
  app.get('/p.js', async (_request, reply) => reply.code(501).send({ error: 'not_implemented' }));

  return app;
}
