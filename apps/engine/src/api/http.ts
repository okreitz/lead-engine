import type { FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import type { Auth, SessionAuth } from '../auth/sessions.ts';

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message?: string,
    public readonly details?: unknown,
  ) {
    super(message ?? code);
  }
}

export function parse<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, 'invalid_request', 'invalid request', result.error.issues);
  }
  return result.data;
}

export function authOf(request: FastifyRequest): Auth {
  if (!request.auth) throw new HttpError(401, 'unauthenticated');
  return request.auth;
}

export function sessionOf(request: FastifyRequest): SessionAuth {
  const auth = authOf(request);
  if (auth.kind !== 'session') throw new HttpError(403, 'session_required');
  return auth;
}

/** The workspace the request acts on, plus the acting user (null for API tokens). */
export function workspaceOf(request: FastifyRequest): {
  workspaceId: string;
  userId: string | null;
} {
  const auth = authOf(request);
  if (!auth.workspaceId) throw new HttpError(409, 'no_workspace', 'select or create a workspace');
  return { workspaceId: auth.workspaceId, userId: auth.kind === 'session' ? auth.userId : null };
}
