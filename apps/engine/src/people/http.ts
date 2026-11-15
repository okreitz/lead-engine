/**
 * Minimal JSON/text HTTP for fixed API hosts (Icypeas, SEC EDGAR, ATS job boards, the Reacher
 * sidecar). Hosts are fixed or operator-configured, never user-typed, so no SSRF guard here;
 * tests replace it with a fake through `AppContext.http`.
 */
import { fetch as undiciFetch } from 'undici';

export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type HttpFetch = (
  url: string,
  init: {
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  },
) => Promise<HttpResponse>;

export const defaultHttp: HttpFetch = async (url, init) => {
  const res = await undiciFetch(url, {
    method: init.method ?? 'GET',
    headers: init.headers ?? {},
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
  });
  return res;
};

export async function readJson(res: HttpResponse, maxChars = 5_000_000): Promise<unknown> {
  const text = await res.text();
  if (text.length > maxChars) throw new Error('response too large');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
