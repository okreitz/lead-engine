import {
  conversationSettingsSchema,
  INBOX_TABS,
  sourceToggleSchema,
  THREAD_SOURCES,
  threadUpdateSchema,
} from '@le/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../audit.ts';
import {
  createAccountFromThread,
  CrmError,
  inboxCounts,
  listInbox,
  requireThread,
  sourcesStatus,
  threadView,
  updateThread,
} from '../../conversations/inbox.ts';
import { queuePoll, updateSource } from '../../conversations/poll.ts';
import { workspaces } from '../../db/schema.ts';
import type { AppContext } from '../context.ts';
import { HttpError, parse, workspaceOf } from '../http.ts';

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof CrmError) throw new HttpError(err.status, err.code, err.message);
    throw err;
  }
}

const idParam = z.object({ id: z.string().min(1).max(64) });
const sourceParam = z.object({ source: z.enum(THREAD_SOURCES) });
const listQuery = z.object({
  tab: z.enum(INBOX_TABS).default('priority'),
  source: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',') : undefined))
    .pipe(z.array(z.enum(THREAD_SOURCES)).optional()),
  minIntent: z.coerce.number().int().min(0).max(3).optional(),
  /** Offer id, or `none` for threads without an offer. */
  offer: z.string().min(1).max(64).optional(),
});

/** Stream 2: the Conversations inbox and its sources (docs/ui.md §3.5). */
export function registerConversationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const bluesky = () => ctx.bluesky?.status() ?? null;
  app.get('/api/v1/inbox', async (request) => {
    const { workspaceId } = workspaceOf(request);
    const q = parse(listQuery, request.query);
    const now = ctx.now();
    return {
      threads: listInbox(ctx.db, workspaceId, q, now),
      counts: inboxCounts(ctx.db, workspaceId, now),
    };
  });

  app.get('/api/v1/inbox/:id', async (request) => {
    const { workspaceId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    return guard(() => threadView(ctx.db, requireThread(ctx.db, workspaceId, id), ctx.now()));
  });

  app.patch('/api/v1/inbox/:id', async (request) => {
    const { workspaceId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    const body = parse(threadUpdateSchema, request.body);
    const now = ctx.now();
    return guard(() =>
      ctx.db.transaction((tx) =>
        threadView(tx, updateThread(tx, requireThread(tx, workspaceId, id), body, now), now),
      ),
    );
  });

  app.post('/api/v1/inbox/:id/account', async (request, reply) => {
    const { workspaceId, userId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    const now = ctx.now();
    const res = guard(() =>
      ctx.db.transaction((tx) =>
        createAccountFromThread(tx, requireThread(tx, workspaceId, id), now),
      ),
    );
    audit(
      ctx.db,
      {
        workspaceId,
        userId,
        action: 'inbox.create_account',
        target: res.company.domain,
        details: { threadId: id, accountId: res.accountId, created: res.created },
      },
      now,
    );
    return reply.code(res.created ? 201 : 200).send(res);
  });

  app.get('/api/v1/conversations/sources', async (request) => {
    const { workspaceId } = workspaceOf(request);
    return sourcesStatus(ctx, workspaceId, bluesky());
  });

  app.patch(
    '/api/v1/conversations/sources/:source',
    { config: { owner: true } },
    async (request) => {
      const { workspaceId, userId } = workspaceOf(request);
      const { source } = parse(sourceParam, request.params);
      const { enabled } = parse(sourceToggleSchema, request.body);
      const now = ctx.now();
      updateSource(
        ctx.db,
        workspaceId,
        source,
        { enabled, ...(enabled ? { nextRunAt: now } : {}) },
        now,
      );
      audit(
        ctx.db,
        {
          workspaceId,
          userId,
          action: 'conversations.source',
          target: source,
          details: { enabled },
        },
        now,
      );
      return sourcesStatus(ctx, workspaceId, bluesky());
    },
  );

  app.post('/api/v1/conversations/sources/:source/run', async (request) => {
    const { workspaceId } = workspaceOf(request);
    const { source } = parse(sourceParam, request.params);
    if (source === 'bluesky') throw new HttpError(400, 'live', 'Bluesky is a live stream');
    return { queued: queuePoll(ctx, workspaceId, source) };
  });

  app.put('/api/v1/conversations/settings', { config: { owner: true } }, async (request) => {
    const { workspaceId, userId } = workspaceOf(request);
    const body = parse(conversationSettingsSchema, request.body);
    const now = ctx.now();
    const ws = ctx.db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get()!;
    const conversations = {
      ...ws.settings.conversations,
      ...(body.stackexchangeSites
        ? { stackexchangeSites: [...new Set(body.stackexchangeSites)] }
        : {}),
      ...(body.dailyScoringCap !== undefined ? { dailyScoringCap: body.dailyScoringCap } : {}),
    };
    ctx.db
      .update(workspaces)
      .set({ settings: { ...ws.settings, conversations } })
      .where(eq(workspaces.id, workspaceId))
      .run();
    audit(
      ctx.db,
      {
        workspaceId,
        userId,
        action: 'conversations.settings',
        target: 'conversations',
        details: conversations,
      },
      now,
    );
    return sourcesStatus(ctx, workspaceId, bluesky());
  });
}
