import { createOfferBodySchema, offerProfileSchema, saveOfferVersionBodySchema } from '@le/shared';
import { and, asc, desc, eq, max } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../audit.ts';
import { checkUrl, CrawlError } from '../../crawler/crawler.ts';
import { rescoreWorkspace } from '../../crm/scoring.ts';
import type { Tx } from '../../db/client.ts';
import { jobs, offers, offerVersions } from '../../db/schema.ts';
import { newId } from '../../ids.ts';
import { enqueue } from '../../jobs/queue.ts';
import type { AppContext } from '../context.ts';
import { HttpError, parse, workspaceOf } from '../http.ts';

const params = z.object({ id: z.string().min(1).max(64) });
const versionParams = params.extend({ version: z.coerce.number().int().min(1) });

function requireOffer(tx: Tx, workspaceId: string, id: string) {
  const offer = tx
    .select()
    .from(offers)
    .where(and(eq(offers.id, id), eq(offers.workspaceId, workspaceId)))
    .get();
  if (!offer) throw new HttpError(404, 'not_found', 'offer not found');
  return offer;
}

function nextVersion(tx: Tx, offerId: string): number {
  return (
    (tx
      .select({ v: max(offerVersions.version) })
      .from(offerVersions)
      .where(eq(offerVersions.offerId, offerId))
      .get()?.v ?? 0) + 1
  );
}

/** Creates a `drafting` version and queues the LLM draft job. */
function startDraft(
  ctx: AppContext,
  tx: Tx,
  workspaceId: string,
  offerId: string,
  input: { notes?: string; competitors?: string[] },
): { versionId: string; version: number; jobId: string } {
  const now = ctx.now();
  const versionId = newId('ofv');
  const version = nextVersion(tx, offerId);
  tx.insert(offerVersions)
    .values({
      id: versionId,
      offerId,
      workspaceId,
      version,
      status: 'drafting',
      source: 'llm',
      input,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const jobId = enqueue(
    tx,
    { workspaceId, type: 'offer.draft', payload: { offerVersionId: versionId }, maxAttempts: 2 },
    now,
  );
  tx.update(offerVersions).set({ jobId }).where(eq(offerVersions.id, versionId)).run();
  return { versionId, version, jobId };
}

export function registerOfferRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/offers', async (request) => {
    const { workspaceId } = workspaceOf(request);
    const list = ctx.db
      .select()
      .from(offers)
      .where(eq(offers.workspaceId, workspaceId))
      .orderBy(desc(offers.updatedAt))
      .all();
    return list.map((o) => {
      const versions = ctx.db
        .select({
          version: offerVersions.version,
          status: offerVersions.status,
          approvedAt: offerVersions.approvedAt,
        })
        .from(offerVersions)
        .where(eq(offerVersions.offerId, o.id))
        .orderBy(desc(offerVersions.version))
        .all();
      return {
        ...o,
        latest: versions[0] ?? null,
        approvedVersion: versions.find((v) => v.status === 'approved')?.version ?? null,
      };
    });
  });

  // URL → crawl + LLM draft (as a job)
  app.post('/api/v1/offers', async (request, reply) => {
    const { workspaceId, userId } = workspaceOf(request);
    const body = parse(createOfferBodySchema, request.body);
    let url: URL;
    try {
      url = checkUrl(body.websiteUrl);
    } catch (err) {
      if (err instanceof CrawlError) throw new HttpError(400, 'invalid_url', err.message);
      throw err;
    }
    const now = ctx.now();
    const offerId = newId('off');
    const res = ctx.db.transaction((tx) => {
      tx.insert(offers)
        .values({
          id: offerId,
          workspaceId,
          name: body.name ?? '',
          websiteUrl: url.toString(),
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return startDraft(ctx, tx, workspaceId, offerId, {
        ...(body.notes ? { notes: body.notes } : {}),
        ...(body.competitors ? { competitors: body.competitors } : {}),
      });
    });
    audit(
      ctx.db,
      {
        workspaceId,
        userId,
        action: 'offer.create',
        target: `offer:${offerId}`,
        details: { url: url.toString() },
      },
      now,
    );
    return reply.code(201).send({ id: offerId, ...res });
  });

  app.get('/api/v1/offers/:id', async (request) => {
    const { workspaceId } = workspaceOf(request);
    const { id } = parse(params, request.params);
    const offer = requireOffer(ctx.db, workspaceId, id);
    const versions = ctx.db
      .select({
        v: offerVersions,
        jobState: jobs.state,
        waitReason: jobs.waitReason,
        jobError: jobs.lastError,
      })
      .from(offerVersions)
      .leftJoin(jobs, eq(jobs.id, offerVersions.jobId))
      .where(eq(offerVersions.offerId, id))
      .orderBy(asc(offerVersions.version))
      .all()
      .map((r) => ({
        ...r.v,
        job: r.v.jobId
          ? { state: r.jobState, waitReason: r.waitReason, lastError: r.jobError }
          : null,
      }));
    return { offer, versions };
  });

  app.post('/api/v1/offers/:id/redraft', async (request, reply) => {
    const { workspaceId } = workspaceOf(request);
    const { id } = parse(params, request.params);
    const body = parse(
      z
        .object({
          notes: z.string().max(4000).optional(),
          competitors: z.array(z.string().min(1).max(120)).max(20).optional(),
        })
        .strict(),
      request.body ?? {},
    );
    requireOffer(ctx.db, workspaceId, id);
    const res = ctx.db.transaction((tx) =>
      startDraft(ctx, tx, workspaceId, id, body as { notes?: string; competitors?: string[] }),
    );
    return reply.code(201).send(res);
  });

  /**
   * Saves an edit. A draft is updated in place; editing an approved (or superseded)
   * version creates a new draft version, so approved versions never change (SPEC §4.1).
   */
  app.put('/api/v1/offers/:id/versions/:version', async (request) => {
    const { workspaceId } = workspaceOf(request);
    const { id, version } = parse(versionParams, request.params);
    const { data } = parse(saveOfferVersionBodySchema, request.body);
    requireOffer(ctx.db, workspaceId, id);
    const now = ctx.now();
    return ctx.db.transaction((tx) => {
      const current = tx
        .select()
        .from(offerVersions)
        .where(and(eq(offerVersions.offerId, id), eq(offerVersions.version, version)))
        .get();
      if (!current) throw new HttpError(404, 'not_found', 'version not found');
      if (current.status === 'drafting')
        throw new HttpError(409, 'drafting', 'this version is still being drafted');
      if (current.status === 'draft' || current.status === 'failed') {
        tx.update(offerVersions)
          .set({ data, status: 'draft', source: 'human', error: null, updatedAt: now })
          .where(eq(offerVersions.id, current.id))
          .run();
        return { version, created: false };
      }
      const v = nextVersion(tx, id);
      tx.insert(offerVersions)
        .values({
          id: newId('ofv'),
          offerId: id,
          workspaceId,
          version: v,
          status: 'draft',
          source: 'human',
          data,
          input: current.input,
          pages: current.pages,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return { version: v, created: true };
    });
  });

  app.post('/api/v1/offers/:id/versions/:version/approve', async (request) => {
    const { workspaceId, userId } = workspaceOf(request);
    const { id, version } = parse(versionParams, request.params);
    requireOffer(ctx.db, workspaceId, id);
    const now = ctx.now();
    const rescored = ctx.db.transaction((tx) => {
      const current = tx
        .select()
        .from(offerVersions)
        .where(and(eq(offerVersions.offerId, id), eq(offerVersions.version, version)))
        .get();
      if (!current) throw new HttpError(404, 'not_found', 'version not found');
      if (current.status !== 'draft')
        throw new HttpError(
          409,
          'not_draft',
          `only drafts can be approved (this one is ${current.status})`,
        );
      const valid = offerProfileSchema.safeParse(current.data);
      if (!valid.success)
        throw new HttpError(
          400,
          'invalid_profile',
          'the profile is incomplete',
          valid.error.issues,
        );
      tx.update(offerVersions)
        .set({ status: 'superseded', updatedAt: now })
        .where(and(eq(offerVersions.offerId, id), eq(offerVersions.status, 'approved')))
        .run();
      tx.update(offerVersions)
        .set({ status: 'approved', approvedAt: now, approvedBy: userId, updatedAt: now })
        .where(eq(offerVersions.id, current.id))
        .run();
      tx.update(offers)
        .set({ name: valid.data.name, updatedAt: now })
        .where(eq(offers.id, id))
        .run();
      // Fit is recomputed when the offer version changes (SPEC §4.2).
      return rescoreWorkspace(tx, workspaceId, now);
    });
    audit(
      ctx.db,
      { workspaceId, userId, action: 'offer.approve', target: `offer:${id}`, details: { version } },
      now,
    );
    return { ok: true, rescored };
  });
}
