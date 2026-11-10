import { Crawler } from '../src/crawler/crawler.ts';

export interface FakeResponse {
  status?: number;
  type?: string;
  body?: string;
  location?: string;
}

/** A crawler whose "network" is a URL → response map. Records every request. */
export function fakeWeb(pages: Record<string, FakeResponse>, opts: { now?: () => number } = {}) {
  const requests: { url: string; ua: string }[] = [];
  const slept: number[] = [];
  const crawler = new Crawler({
    sleep: async (ms) => {
      slept.push(ms);
    },
    ...(opts.now ? { now: opts.now } : {}),
    fetch: async (url, init) => {
      requests.push({ url, ua: init.headers['user-agent']! });
      const r = pages[url] ?? { status: 404, body: 'not found', type: 'text/plain' };
      const body = r.body ?? '';
      const headers = new Map<string, string>([
        ['content-type', r.type ?? 'text/html; charset=utf-8'],
        ...(r.location ? ([['location', r.location]] as [string, string][]) : []),
      ]);
      return {
        status: r.status ?? 200,
        headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
        body: (async function* () {
          yield new TextEncoder().encode(body);
        })(),
      };
    },
  });
  return { crawler, requests, slept };
}
