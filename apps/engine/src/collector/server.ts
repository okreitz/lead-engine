import {
  COLLECTOR_BODY_LIMIT_BYTES,
  collectIdentifySchema,
  collectVisitSchema,
  type Health,
} from '@le/shared';
import { eq } from 'drizzle-orm';
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import type { AppContext } from '../api/context.ts';
import { sites } from '../db/schema.ts';
import { VERSION } from '../version.ts';
import type { SiteRow } from '../visits/record.ts';
import { isProxyPeer, normalizeIp } from './ip.ts';
import { DEFAULT_RATE_LIMITS, RateLimiter, type RateLimits } from './limits.ts';
import type { VisitPipeline } from './pipeline.ts';
import { PIXEL_GIF, SNIPPET_JS } from './snippet.ts';

export interface CollectorOptions {
  logLevel?: string;
  /**
   * Header holding the client IP, set by the reverse proxy. Coolify's Traefik deletes any
   * X-Real-Ip a client sends (untrusted source) and sets it to the TCP peer it saw, so the
   * value can't be spoofed. It is only read when the request comes from a private or
   * loopback address (the proxy on the Docker network); otherwise the socket address is used.
   */
  clientIpHeader?: string;
  rateLimits?: RateLimits;
  /** Pending events held in memory before new ones are refused with 503. */
  maxQueue?: number;
}

/** Sequential in-memory queue between the HTTP handlers and the pipeline (SPEC §2). */
export class EventQueue {
  private items: (() => Promise<unknown>)[] = [];
  private running = false;
  private idle: (() => void)[] = [];

  constructor(
    private readonly max: number,
    private readonly onError: (err: unknown) => void,
  ) {}

  push(task: () => Promise<unknown>): boolean {
    if (this.items.length >= this.max) return false;
    this.items.push(task);
    if (!this.running) void this.run();
    return true;
  }

  private async run(): Promise<void> {
    this.running = true;
    while (this.items.length) {
      const task = this.items.shift()!;
      try {
        await task();
      } catch (err) {
        this.onError(err);
      }
    }
    this.running = false;
    for (const resolve of this.idle.splice(0)) resolve();
  }

  /** Resolves when every queued event has been processed (tests, shutdown). */
  drain(): Promise<void> {
    if (!this.running && this.items.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }

  get size(): number {
    return this.items.length;
  }
}

export interface Collector {
  app: FastifyInstance;
  queue: EventQueue;
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The site's own domain or a subdomain of it (www., shop., …). */
export function hostMatchesSite(host: string | null, domain: string): boolean {
  if (!host) return false;
  return host === domain || host.endsWith(`.${domain}`);
}

/** Origin first (fetch sends it on cross-origin POSTs), else the Referer. */
function requestHost(request: FastifyRequest): string | null {
  const origin = request.headers.origin;
  if (origin && origin !== 'null') return hostOf(origin);
  return hostOf(request.headers.referer);
}

function cleanPath(path: string): string {
  const p = path.split(/[?#]/)[0] ?? '/';
  return (p.startsWith('/') ? p : `/${p}`).slice(0, 512);
}

function cleanReferrer(ref: string | undefined, site: string): string | null {
  if (!ref) return null;
  try {
    const u = new URL(ref);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (hostMatchesSite(u.hostname.toLowerCase(), site)) return null;
    return `${u.origin}${u.pathname}`.slice(0, 512);
  } catch {
    return null;
  }
}

/**
 * The public, unauthenticated, write-only collector on :4511 (SPEC §5.2, §10). It answers
 * before the pipeline runs: requests are validated (schema, 2 KB body, site key, Origin or
 * Referer against the site's domain, rate limits) and queued in memory. Request logging is
 * off and the request serialiser keeps only method and URL, so IPs never reach the logs.
 *
 * Without a pipeline (`ctx` null) it only validates and answers 503, which keeps the stub
 * behaviour for tests of the bare listener.
 */
export function buildCollector(
  ctx: AppContext | null,
  pipeline: VisitPipeline | null,
  options: CollectorOptions = {},
): Collector {
  const app = Fastify({
    logger: {
      level: options.logLevel ?? 'info',
      serializers: {
        req: (req: { method: string; url: string }) => ({
          method: req.method,
          url: req.url.split('?')[0] ?? '',
        }),
      },
    },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: COLLECTOR_BODY_LIMIT_BYTES,
  });
  const queue = new EventQueue(options.maxQueue ?? 1000, (err) =>
    app.log.error({ err: { message: String((err as Error).message) } }, 'collector pipeline error'),
  );
  const limiter = new RateLimiter(options.rateLimits ?? DEFAULT_RATE_LIMITS, ctx?.now ?? Date.now);
  const ipHeader = (options.clientIpHeader ?? 'x-real-ip').toLowerCase();

  // sendBeacon/fetch with text/plain avoids a CORS preflight; the body is still JSON.
  app.removeContentTypeParser('text/plain');
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(null, undefined);
    }
  });

  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cross-origin-resource-policy', 'cross-origin');
    reply.header('referrer-policy', 'no-referrer');
  });

  function clientIp(request: FastifyRequest): string | null {
    const peer = normalizeIp(request.socket.remoteAddress);
    if (peer && isProxyPeer(peer)) {
      const raw = request.headers[ipHeader];
      const value = Array.isArray(raw) ? raw[0] : raw;
      const fromProxy = normalizeIp(value?.split(',')[0]);
      if (fromProxy) return fromProxy;
    }
    return peer;
  }

  function siteByKey(key: string): SiteRow | null {
    if (!ctx) return null;
    return ctx.db.select().from(sites).where(eq(sites.siteKey, key)).get() ?? null;
  }

  app.get('/healthz', async (): Promise<Health> => {
    return { status: 'ok', service: 'collector', version: VERSION };
  });

  app.get('/p.js', async (_request, reply) => {
    return reply
      .header('content-type', 'application/javascript; charset=utf-8')
      .header('cache-control', 'public, max-age=3600')
      .send(SNIPPET_JS);
  });

  type Gate =
    | { ok: true; site: SiteRow; ip: string; userAgent: string }
    | { ok: false; code: number; error: string };

  function gate(request: FastifyRequest, siteKey: string): Gate {
    if (!ctx || !pipeline) return { ok: false, code: 503, error: 'collector_disabled' };
    const ip = clientIp(request);
    if (!ip) return { ok: false, code: 400, error: 'no_client_ip' };
    if (!limiter.allowIp(ip)) return { ok: false, code: 429, error: 'rate_limited' };
    const site = siteByKey(siteKey);
    if (!site) return { ok: false, code: 404, error: 'unknown_site' };
    if (!hostMatchesSite(requestHost(request), site.domain))
      return { ok: false, code: 403, error: 'origin_mismatch' };
    if (!limiter.allow(ip, site.id)) {
      pipeline.countRateLimited(site);
      return { ok: false, code: 429, error: 'rate_limited' };
    }
    pipeline.touchSite(site);
    return { ok: true, site, ip, userAgent: String(request.headers['user-agent'] ?? '') };
  }

  app.post('/collect/v', async (request, reply) => {
    const parsed = collectVisitSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const g = gate(request, parsed.data.siteKey);
    if (!g.ok) return reply.code(g.code).send({ error: g.error });
    const body = parsed.data;
    const utm =
      body.utm && Object.keys(body.utm).length ? (body.utm as Record<string, string>) : null;
    const queued = queue.push(() =>
      pipeline!.processVisit({
        site: g.site,
        ip: g.ip,
        userAgent: g.userAgent,
        path: cleanPath(body.path),
        referrer: cleanReferrer(body.referrer, g.site.domain),
        utm,
      }),
    );
    return reply.code(queued ? 202 : 503).send();
  });

  // `<noscript>` pixel: the path comes from the Referer (usually just the origin).
  app.get<{ Querystring: { s?: string } }>('/collect/v.gif', async (request, reply) => {
    reply.header('content-type', 'image/gif').header('cache-control', 'no-store').code(200);
    const key = typeof request.query.s === 'string' ? request.query.s : '';
    if (key.length < 8 || key.length > 64) return reply.send(PIXEL_GIF);
    const g = gate(request, key);
    if (g.ok) {
      let path = '/';
      try {
        path = new URL(request.headers.referer ?? '').pathname || '/';
      } catch {
        path = '/';
      }
      queue.push(() =>
        pipeline!.processVisit({
          site: g.site,
          ip: g.ip,
          userAgent: g.userAgent,
          path: cleanPath(path),
          referrer: null,
          utm: null,
        }),
      );
    }
    return reply.send(PIXEL_GIF);
  });

  app.post('/collect/identify', async (request, reply) => {
    const parsed = collectIdentifySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const g = gate(request, parsed.data.siteKey);
    if (!g.ok) return reply.code(g.code).send({ error: g.error });
    const queued = queue.push(() =>
      pipeline!.processIdentify({
        site: g.site,
        ip: g.ip,
        userAgent: g.userAgent,
        emailDomain: parsed.data.emailDomain,
      }),
    );
    return reply.code(queued ? 202 : 503).send();
  });

  return { app, queue };
}
