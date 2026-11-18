import { siteCreateSchema, siteUpdateSchema } from '@le/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../audit.ts';
import { CrmError } from '../../crm/accounts.ts';
import { Crawler } from '../../crawler/crawler.ts';
import { sites } from '../../db/schema.ts';
import {
  checkSite,
  collectorStatus,
  createSite,
  listSites,
  markWrongCompany,
  requireSite,
  requireWorkspaceOffer,
  siteView,
  visitorsReport,
} from '../../visits/report.ts';
import type { AppContext } from '../context.ts';
import { HttpError, parse, workspaceOf } from '../http.ts';

async function guard<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CrmError) throw new HttpError(err.status, err.code, err.message);
    throw err;
  }
}

/** Stream 1: sites and snippets (Settings → Sites & snippet) and the Visitors page. */
export function registerVisitorRoutes(app: FastifyInstance, ctx: AppContext): void {
  let crawler: Crawler | null = null;
  const getCrawler = () => (ctx.crawler ??= crawler ??= new Crawler());

  app.get('/api/v1/sites', async (request) => {
    const { workspaceId } = workspaceOf(request);
    return { sites: listSites(ctx, workspaceId), status: collectorStatus(ctx, workspaceId) };
  });

  app.post('/api/v1/sites', { config: { owner: true } }, async (request, reply) => {
    const { workspaceId, userId } = workspaceOf(request);
    const body = parse(siteCreateSchema, request.body);
    const site = await guard(() => createSite(ctx, workspaceId, body.domain, body.offerId));
    audit(ctx.db, { workspaceId, userId, action: 'site.create', target: site.domain }, ctx.now());
    return reply.code(201).send(siteView(ctx, site));
  });

  app.patch<{ Params: { id: string } }>(
    '/api/v1/sites/:id',
    { config: { owner: true } },
    async (request) => {
      const { workspaceId, userId } = workspaceOf(request);
      const body = parse(siteUpdateSchema, request.body);
      const site = await guard(() => requireSite(ctx.db, workspaceId, request.params.id));
      if (body.intentPages) {
        const seen = new Set<string>();
        const intentPages = body.intentPages.filter((p) => {
          const k = p.path.toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        ctx.db.update(sites).set({ intentPages }).where(eq(sites.id, site.id)).run();
        audit(
          ctx.db,
          {
            workspaceId,
            userId,
            action: 'site.intent_pages',
            target: site.domain,
            details: { intentPages },
          },
          ctx.now(),
        );
      }
      if (body.offerId !== undefined) {
        const offerId = body.offerId;
        if (offerId) await guard(() => requireWorkspaceOffer(ctx.db, workspaceId, offerId));
        ctx.db.update(sites).set({ offerId }).where(eq(sites.id, site.id)).run();
        audit(
          ctx.db,
          { workspaceId, userId, action: 'site.offer', target: site.domain, details: { offerId } },
          ctx.now(),
        );
      }
      return siteView(ctx, requireSite(ctx.db, workspaceId, site.id));
    },
  );

  /** Deletes the site with its visits and counters (the UI asks to type the domain). */
  app.delete<{ Params: { id: string } }>(
    '/api/v1/sites/:id',
    { config: { owner: true } },
    async (request) => {
      const { workspaceId, userId } = workspaceOf(request);
      const site = await guard(() => requireSite(ctx.db, workspaceId, request.params.id));
      ctx.db
        .delete(sites)
        .where(and(eq(sites.id, site.id), eq(sites.workspaceId, workspaceId)))
        .run();
      audit(ctx.db, { workspaceId, userId, action: 'site.delete', target: site.domain }, ctx.now());
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>('/api/v1/sites/:id/check', async (request) => {
    const { workspaceId } = workspaceOf(request);
    const site = await guard(() => requireSite(ctx.db, workspaceId, request.params.id));
    const checked = await checkSite(ctx, site, (url) => getCrawler().fetchHtml(url));
    return siteView(ctx, checked);
  });

  app.get('/api/v1/visitors', { config: { token: 'read' } }, async (request) => {
    const { workspaceId } = workspaceOf(request);
    const q = parse(
      z.object({
        siteId: z.string().min(1),
        days: z.coerce.number().int().min(1).max(90).default(30),
        show: z.enum(['engaged', 'all']).default('engaged'),
      }),
      request.query,
    );
    return guard(() => visitorsReport(ctx, workspaceId, q));
  });

  /** "Wrong company" (`W`): corrects the IP map, removes the matched visits, and is audited. */
  app.post('/api/v1/visitors/wrong', async (request) => {
    const { workspaceId, userId } = workspaceOf(request);
    const body = parse(z.object({ accountId: z.string().min(1) }), request.body);
    const result = await guard(() => markWrongCompany(ctx, workspaceId, body.accountId));
    audit(
      ctx.db,
      {
        workspaceId,
        userId,
        action: 'visitors.wrong_company',
        target: result.domain,
        details: {
          accountId: body.accountId,
          prefixes: result.prefixes,
          removedVisits: result.removedVisits,
          removedSignals: result.removedSignals,
        },
      },
      ctx.now(),
    );
    return result;
  });
}
