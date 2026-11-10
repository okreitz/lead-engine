'use client';
import { CSRF_HEADER } from '@le/shared';

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Calls the engine through the same-origin proxy. Attaches the CSRF token to unsafe methods. */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; raw?: BodyInit; contentType?: string } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET' && csrfToken) headers[CSRF_HEADER] = csrfToken;
  let body: BodyInit | undefined;
  if (init.raw !== undefined) {
    body = init.raw;
    headers['content-type'] = init.contentType ?? 'text/plain';
  } else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`/api/v1${path}`, { method, headers, body, credentials: 'same-origin' });
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const err = (data ?? {}) as { error?: string; message?: string; details?: unknown };
    throw new ApiError(
      res.status,
      err.error ?? 'error',
      err.message ?? res.statusText,
      err.details,
    );
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export const usd = (n: number | null | undefined) =>
  n == null ? '—' : `$${n.toFixed(n < 1 && n > 0 ? 4 : 2)}`;

export const fmtDate = (ms: number | null | undefined) =>
  ms == null
    ? '—'
    : new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
