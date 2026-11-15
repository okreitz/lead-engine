import type { HttpFetch } from '../src/people/http.ts';

export type Handler = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
) => { status?: number; body?: unknown } | undefined;

/** Fake HTTP for fixed API hosts; records every call. Unknown URLs answer 404. */
export function fakeHttp(handler: Handler) {
  const calls: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
  }[] = [];
  const http: HttpFetch = async (url, init) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    const r = handler(url, init) ?? { status: 404, body: 'Not Found' };
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? null);
    return { status: r.status ?? 200, headers: { get: () => null }, text: async () => text };
  };
  return { http, calls };
}

/**
 * A fake Icypeas: `verify(email)` returns a certainty, `find(first,last,domain)` an email or
 * null. Each submit returns an id that reads as IN_PROGRESS once, then finished.
 */
export function fakeIcypeas(opts: {
  verify: (email: string) => string;
  find: (
    first: string,
    last: string,
    domain: string,
  ) => { email: string; certainty: string } | null;
}): Handler {
  let n = 0;
  const pending = new Map<string, { polls: number; item: unknown }>();
  return (url, init) => {
    if (!url.startsWith('https://app.icypeas.com/api/')) return undefined;
    if (init.headers?.authorization !== 'icy-test-key')
      return { status: 401, body: { code: 'user_not_found_error' } };
    const body = JSON.parse(init.body ?? '{}');
    if (url.endsWith('/email-verification')) {
      const id = `v${++n}`;
      const certainty = opts.verify(body.email);
      pending.set(id, {
        polls: 0,
        item: {
          status: certainty === 'not_found' ? 'NOT_FOUND' : 'FOUND',
          results: { emails: [{ email: body.email, certainty }] },
        },
      });
      return { body: { success: true, item: { _id: id, status: 'NONE' } } };
    }
    if (url.endsWith('/email-search')) {
      const id = `s${++n}`;
      const r = opts.find(body.firstname, body.lastname, body.domainOrCompany);
      pending.set(id, {
        polls: 0,
        item: r
          ? { status: 'DEBITED', results: { emails: [r] } }
          : { status: 'NOT_FOUND', results: { emails: [] } },
      });
      return { body: { success: true, item: { _id: id, status: 'NONE' } } };
    }
    if (url.endsWith('/bulk-single-searchs/read')) {
      const p = pending.get(body.id);
      if (!p)
        return { body: { success: false, validationErrors: [{ type: 'SearchNotFoundError' }] } };
      if (p.polls++ === 0) return { body: { success: true, items: [{ status: 'IN_PROGRESS' }] } };
      return { body: { success: true, items: [p.item] } };
    }
    return undefined;
  };
}
