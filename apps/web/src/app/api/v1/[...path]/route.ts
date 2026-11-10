/**
 * Same-origin proxy from the web app to the engine API (SPEC §7). The browser only ever
 * talks to :4500, so the session cookie stays first-party and httpOnly; the engine on :4501
 * is never exposed. LE_ENGINE_URL is read at request time (Docker sets it to the engine
 * service).
 */
import type { NextRequest } from 'next/server';

const engineUrl = () => process.env.LE_ENGINE_URL ?? 'http://127.0.0.1:4501';

// Only these headers cross the proxy; everything else stays at the edge.
const FORWARD_REQUEST = [
  'accept',
  'content-type',
  'cookie',
  'authorization',
  'x-csrf-token',
  'user-agent',
];
const FORWARD_RESPONSE = ['content-type', 'content-disposition', 'cache-control'];

async function proxy(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const target = new URL(`/api/v1/${path.map(encodeURIComponent).join('/')}`, engineUrl());
  target.search = request.nextUrl.search;

  const headers = new Headers();
  for (const name of FORWARD_REQUEST) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const proto =
    request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(':', '');
  headers.set('x-forwarded-proto', proto);
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) headers.set('x-forwarded-for', fwd);

  const hasBody = !['GET', 'HEAD'].includes(request.method);
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch {
    return Response.json(
      { error: 'engine_unreachable', message: 'the engine is not reachable' },
      { status: 502 },
    );
  }

  const out = new Headers();
  for (const name of FORWARD_RESPONSE) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  for (const cookie of upstream.headers.getSetCookie()) out.append('set-cookie', cookie);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
