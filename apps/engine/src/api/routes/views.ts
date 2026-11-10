/**
 * Saved views (docs/ui.md §3.2) and bulk actions on accounts (the bulk bar).
 * A view belongs to its creator unless shared (userId null); pinned views show in the sidebar.
 */
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../audit.ts';
import { CrmError, requireAccount, setAccountStage } from '../../crm/accounts.ts';
import { addSuppression } from '../../crm/records.ts';
import { accounts, savedViews } from '../../db/schema.ts';
import { newId } from '../../ids.ts';
import type { AppContext } from '../context.ts';
import { HttpError, parse, sessionOf, workspaceOf } from '../http.ts';

const viewState = z
  .object({
    filters: z.record(z.string().max(40), z.array(z.string().max(200)).max(50)).optional(),
    sort: z.string().max(40).optional(),
    columns: z.array(z.string().max(40)).max(30).optional(),
    layout: z.enum(['table', 'board']).optional(),
  })
  .strict();

const createView = z
  .object({
    name: z.string().trim().min(1).max(60),
    entity: z.enum(['accounts', 'pipeline']).default('accounts'),
    state: viewState,
    pinned: z.boolean().default(false),
    shared: z.boolean().default(false),
  })
  .strict();

const updateView = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    state: viewState.optional(),
    pinned: z.boolean().optional(),
    position: z.number().int().min(0).max(1000).optional(),
  })
  .strict();

const bulkBody = z
  .object({
    ids: z.array(z.string().min(1).max(64)).min(1).max(1000),
    action: z.enum(['stage', 'archive', 'suppress']),
    stage: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

export function registerViewRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/views', async (request) => {
    const auth = sessionOf(request);
    const { workspaceId } = workspaceOf(request);
    return ctx.db
      .select()
      .from(savedViews)
      .where(
        and(
          eq(savedViews.workspaceId, workspaceId),
          or(eq(savedViews.userId, auth.userId), isNull(savedViews.userId)),
        ),
      )
      .orderBy(asc(savedViews.position), asc(savedViews.createdAt))
      .all();
  });

  app.post('/api/v1/views', async (request, reply) => {
    const auth = sessionOf(request);
    const { workspaceId } = workspaceOf(request);
    const body = parse(createView, request.body);
    const id = newId('view');
    ctx.db
      .insert(savedViews)
      .values({
        id,
        workspaceId,
        userId: body.shared ? null : auth.userId,
        entity: body.entity,
        name: body.name,
        state: body.state,
        pinned: body.pinned,
        position: 0,
        createdAt: ctx.now(),
      })
      .run();
    return reply.code(201).send({ id });
  });

  const ownView = (workspaceId: string, userId: string, id: string) => {
    const v = ctx.db
      .select()
      .from(savedViews)
      .where(and(eq(savedViews.id, id), eq(savedViews.workspaceId, workspaceId)))
      .get();
    if (!v || (v.userId !== null && v.userId !== userId))
      throw new HttpError(404, 'not_found', 'view not found');
    return v;
  };

  app.patch('/api/v1/views/:id', async (request) => {
    const auth = sessionOf(request);
    const { workspaceId } = workspaceOf(request);
    const { id } = parse(z.object({ id: z.string().max(64) }), request.params);
    const body = parse(updateView, request.body);
    ownView(workspaceId, auth.userId, id);
    ctx.db
      .update(savedViews)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.state !== undefined ? { state: body.state } : {}),
        ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
        ...(body.position !== undefined ? { position: body.position } : {}),
      })
      .where(eq(savedViews.id, id))
      .run();
    return { ok: true };
  });

  app.delete('/api/v1/views/:id', async (request) => {
    const auth = sessionOf(request);
    const { workspaceId } = workspaceOf(request);
    const { id } = parse(z.object({ id: z.string().max(64) }), request.params);
    ownView(workspaceId, auth.userId, id);
    ctx.db.delete(savedViews).where(eq(savedViews.id, id)).run();
    return { ok: true };
  });

  /** Bulk bar: set stage (each change logged as an activity), archive, or suppress domains. */
  app.post('/api/v1/accounts/bulk', async (request) => {
    const { workspaceId, userId } = workspaceOf(request);
    const body = parse(bulkBody, request.body);
    const now = ctx.now();
    let changed = 0;
    try {
      ctx.db.transaction((tx) => {
        for (const id of body.ids) {
          const { company } = requireAccount(tx, workspaceId, id);
          if (body.action === 'stage') {
            if (!body.stage) throw new CrmError('missing', 'stage is required');
            if (setAccountStage(tx, workspaceId, id, body.stage, userId, now)) changed++;
          } else if (body.action === 'archive') {
            tx.update(accounts)
              .set({ status: 'archived', updatedAt: now })
              .where(eq(accounts.id, id))
              .run();
            changed++;
          } else {
            const r = addSuppression(
              tx,
              workspaceId,
              { kind: 'domain', value: company.domain, reason: 'bulk suppress' },
              userId,
              now,
            );
            if (r.created) changed++;
          }
        }
      });
    } catch (err) {
      if (err instanceof CrmError) throw new HttpError(err.status, err.code, err.message);
      throw err;
    }
    if (body.action !== 'stage') {
      audit(
        ctx.db,
        {
          workspaceId,
          userId,
          action: body.action === 'suppress' ? 'suppression.add' : 'account.archive',
          target: `accounts:${body.ids.length}`,
          details: { count: changed, bulk: true },
        },
        now,
      );
    }
    return { ok: true, changed };
  });
}
