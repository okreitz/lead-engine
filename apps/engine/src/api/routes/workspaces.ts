import {
  addMemberBodySchema,
  createTokenBodySchema,
  createWorkspaceBodySchema,
  deleteWorkspaceBodySchema,
  KEYED_PROVIDERS,
  providerKeyBodySchema,
  updateWorkspaceBodySchema,
} from '@le/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../audit.ts';
import { hashPassword } from '../../auth/passwords.ts';
import { setSessionWorkspace } from '../../auth/sessions.ts';
import { encryptSecret, MasterKeyMissingError } from '../../crypto/secrets.ts';
import {
  apiTokens,
  auditLog,
  memberships,
  providerKeys,
  users,
  workspaces,
  type WorkspaceSettings,
} from '../../db/schema.ts';
import { newId, newToken, sha256 } from '../../ids.ts';
import { resumeWaitingJobs } from '../../jobs/queue.ts';
import { createWorkspace, getWorkspace } from '../../workspaces.ts';
import type { AppContext } from '../context.ts';
import { HttpError, parse, sessionOf, workspaceOf } from '../http.ts';

const providerParam = z.object({ provider: z.enum(KEYED_PROVIDERS) });

export function registerWorkspaceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/v1/workspaces', { config: { noWorkspace: true } }, async (request, reply) => {
    const auth = sessionOf(request);
    const { name } = parse(createWorkspaceBodySchema, request.body);
    const now = ctx.now();
    const id = ctx.db.transaction((tx) =>
      createWorkspace(tx, { name, ownerUserId: auth.userId, now }),
    );
    setSessionWorkspace(ctx.db, auth.sessionId, id);
    audit(
      ctx.db,
      {
        workspaceId: id,
        userId: auth.userId,
        action: 'workspace.create',
        target: `workspace:${id}`,
      },
      now,
    );
    return reply.code(201).send(getWorkspace(ctx.db, id));
  });

  app.get('/api/v1/workspace', { config: { token: 'read' } }, async (request) => {
    const { workspaceId } = workspaceOf(request);
    return getWorkspace(ctx.db, workspaceId);
  });

  app.patch('/api/v1/workspace', { config: { owner: true } }, async (request) => {
    const auth = sessionOf(request);
    const workspaceId = auth.workspaceId!;
    const body = parse(updateWorkspaceBodySchema, request.body);
    const before = getWorkspace(ctx.db, workspaceId);
    const now = ctx.now();
    ctx.db
      .update(workspaces)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.monthlyBudgetUsd !== undefined ? { monthlyBudgetUsd: body.monthlyBudgetUsd } : {}),
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
        ...(body.settings !== undefined
          ? { settings: { ...before.settings, ...body.settings } as WorkspaceSettings }
          : {}),
      })
      .where(eq(workspaces.id, workspaceId))
      .run();
    const budgetChanged =
      body.monthlyBudgetUsd !== undefined && body.monthlyBudgetUsd !== before.monthlyBudgetUsd;
    const capsChanged =
      body.settings?.subCaps !== undefined || body.settings?.enforceSubCaps !== undefined;
    if (budgetChanged || capsChanged) {
      resumeWaitingJobs(ctx.db, workspaceId, now);
      audit(
        ctx.db,
        {
          workspaceId,
          userId: auth.userId,
          action: 'budget.update',
          target: `workspace:${workspaceId}`,
          details: {
            from: before.monthlyBudgetUsd,
            to: body.monthlyBudgetUsd ?? before.monthlyBudgetUsd,
            ...(capsChanged
              ? { subCaps: body.settings?.subCaps, enforceSubCaps: body.settings?.enforceSubCaps }
              : {}),
          },
        },
        now,
      );
    }
    audit(
      ctx.db,
      {
        workspaceId,
        userId: auth.userId,
        action: 'workspace.update',
        target: `workspace:${workspaceId}`,
        details: { fields: Object.keys(body) },
      },
      now,
    );
    return getWorkspace(ctx.db, workspaceId);
  });

  // Destructive: the caller must type the workspace's exact name (CLAUDE.md).
  app.delete('/api/v1/workspace', { config: { owner: true } }, async (request) => {
    const auth = sessionOf(request);
    const workspaceId = auth.workspaceId!;
    const { confirmName } = parse(deleteWorkspaceBodySchema, request.body);
    const ws = getWorkspace(ctx.db, workspaceId);
    if (confirmName !== ws.name)
      throw new HttpError(400, 'confirm_mismatch', 'type the workspace name exactly to delete it');
    ctx.db.delete(workspaces).where(eq(workspaces.id, workspaceId)).run();
    // The workspace's own audit rows are gone with it; keep an instance-level record.
    audit(
      ctx.db,
      {
        workspaceId: null,
        userId: auth.userId,
        action: 'workspace.delete',
        target: `workspace:${workspaceId}`,
        details: { name: ws.name },
      },
      ctx.now(),
    );
    return { ok: true };
  });

  // ---- members
  app.get('/api/v1/workspace/members', async (request) => {
    const { workspaceId } = workspaceOf(request);
    return ctx.db
      .select({ userId: users.id, email: users.email, role: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.workspaceId, workspaceId))
      .orderBy(users.email)
      .all();
  });

  app.post('/api/v1/workspace/members', { config: { owner: true } }, async (request, reply) => {
    const auth = sessionOf(request);
    const workspaceId = auth.workspaceId!;
    const body = parse(addMemberBodySchema, request.body);
    const now = ctx.now();
    let user = ctx.db.select().from(users).where(eq(users.email, body.email)).get();
    if (!user) {
      if (!body.password)
        throw new HttpError(400, 'password_required', 'new users need an initial password');
      const passwordHash = await hashPassword(body.password);
      user = { id: newId('usr'), email: body.email, passwordHash, createdAt: now };
      ctx.db.insert(users).values(user).run();
    }
    ctx.db
      .insert(memberships)
      .values({ userId: user.id, workspaceId, role: body.role })
      .onConflictDoUpdate({
        target: [memberships.userId, memberships.workspaceId],
        set: { role: body.role },
      })
      .run();
    audit(
      ctx.db,
      {
        workspaceId,
        userId: auth.userId,
        action: 'member.add',
        target: `user:${user.id}`,
        details: { role: body.role },
      },
      now,
    );
    return reply.code(201).send({ userId: user.id, email: user.email, role: body.role });
  });

  app.delete('/api/v1/workspace/members/:userId', { config: { owner: true } }, async (request) => {
    const auth = sessionOf(request);
    const workspaceId = auth.workspaceId!;
    const { userId } = parse(z.object({ userId: z.string() }), request.params);
    const owners =
      ctx.db
        .select({ n: sql<number>`count(*)` })
        .from(memberships)
        .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, 'owner')))
        .get()?.n ?? 0;
    const target = ctx.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
      .get();
    if (!target) throw new HttpError(404, 'not_found');
    if (target.role === 'owner' && owners <= 1)
      throw new HttpError(409, 'last_owner', 'a workspace needs an owner');
    ctx.db
      .delete(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
      .run();
    audit(
      ctx.db,
      { workspaceId, userId: auth.userId, action: 'member.remove', target: `user:${userId}` },
      ctx.now(),
    );
    return { ok: true };
  });

  // ---- API tokens (Ground Control uses a read token for /summary)
  app.get('/api/v1/tokens', { config: { owner: true } }, async (request) => {
    const { workspaceId } = workspaceOf(request);
    return ctx.db
      .select({
        id: apiTokens.id,
        name: apiTokens.name,
        scope: apiTokens.scope,
        createdAt: apiTokens.createdAt,
        lastUsedAt: apiTokens.lastUsedAt,
      })
      .from(apiTokens)
      .where(and(eq(apiTokens.workspaceId, workspaceId), isNull(apiTokens.revokedAt)))
      .orderBy(desc(apiTokens.createdAt))
      .all();
  });

  app.post('/api/v1/tokens', { config: { owner: true } }, async (request, reply) => {
    const auth = sessionOf(request);
    const workspaceId = auth.workspaceId!;
    const body = parse(createTokenBodySchema, request.body);
    const token = newToken('le_tok');
    const id = newId('tok');
    const now = ctx.now();
    ctx.db
      .insert(apiTokens)
      .values({
        id,
        workspaceId,
        name: body.name,
        scope: body.scope,
        tokenHash: sha256(token),
        createdBy: auth.userId,
        createdAt: now,
      })
      .run();
    audit(
      ctx.db,
      {
        workspaceId,
        userId: auth.userId,
        action: 'token.create',
        target: `token:${id}`,
        details: { name: body.name, scope: body.scope },
      },
      now,
    );
    // The raw token is shown once and never stored.
    return reply.code(201).send({ id, name: body.name, scope: body.scope, token });
  });

  app.delete('/api/v1/tokens/:id', { config: { owner: true } }, async (request) => {
    const auth = sessionOf(request);
    const workspaceId = auth.workspaceId!;
    const { id } = parse(z.object({ id: z.string() }), request.params);
    const res = ctx.db
      .update(apiTokens)
      .set({ revokedAt: ctx.now() })
      .where(
        and(
          eq(apiTokens.id, id),
          eq(apiTokens.workspaceId, workspaceId),
          isNull(apiTokens.revokedAt),
        ),
      )
      .run();
    if (res.changes === 0) throw new HttpError(404, 'not_found');
    audit(
      ctx.db,
      { workspaceId, userId: auth.userId, action: 'token.revoke', target: `token:${id}` },
      ctx.now(),
    );
    return { ok: true };
  });

  // ---- provider keys (never returned, only whether one is set)
  app.get('/api/v1/provider-keys', async (request) => {
    const { workspaceId } = workspaceOf(request);
    const rows = ctx.db
      .select({ provider: providerKeys.provider, createdAt: providerKeys.createdAt })
      .from(providerKeys)
      .where(eq(providerKeys.workspaceId, workspaceId))
      .all();
    return {
      masterKeyConfigured: ctx.config.masterKey !== null,
      providers: KEYED_PROVIDERS.map((provider) => ({
        provider,
        configured: rows.some((r) => r.provider === provider),
        createdAt: rows.find((r) => r.provider === provider)?.createdAt ?? null,
      })),
    };
  });

  app.put('/api/v1/provider-keys/:provider', { config: { owner: true } }, async (request) => {
    const auth = sessionOf(request);
    const workspaceId = auth.workspaceId!;
    const { provider } = parse(providerParam, request.params);
    const { key } = parse(providerKeyBodySchema, request.body);
    let encryptedKey: string;
    try {
      encryptedKey = encryptSecret(ctx.config.masterKey, workspaceId, provider, key);
    } catch (err) {
      if (err instanceof MasterKeyMissingError)
        throw new HttpError(503, 'master_key_missing', err.message);
      throw err;
    }
    const now = ctx.now();
    ctx.db
      .insert(providerKeys)
      .values({ workspaceId, provider, encryptedKey, createdAt: now })
      .onConflictDoUpdate({
        target: [providerKeys.workspaceId, providerKeys.provider],
        set: { encryptedKey, createdAt: now },
      })
      .run();
    audit(
      ctx.db,
      {
        workspaceId,
        userId: auth.userId,
        action: 'provider_key.set',
        target: `provider:${provider}`,
      },
      now,
    );
    resumeWaitingJobs(ctx.db, workspaceId, now);
    return { ok: true };
  });

  app.delete('/api/v1/provider-keys/:provider', { config: { owner: true } }, async (request) => {
    const auth = sessionOf(request);
    const workspaceId = auth.workspaceId!;
    const { provider } = parse(providerParam, request.params);
    ctx.db
      .delete(providerKeys)
      .where(and(eq(providerKeys.workspaceId, workspaceId), eq(providerKeys.provider, provider)))
      .run();
    audit(
      ctx.db,
      {
        workspaceId,
        userId: auth.userId,
        action: 'provider_key.delete',
        target: `provider:${provider}`,
      },
      ctx.now(),
    );
    return { ok: true };
  });

  // ---- audit log
  app.get('/api/v1/audit', { config: { owner: true } }, async (request) => {
    const { workspaceId } = workspaceOf(request);
    const { limit } = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
      request.query,
    );
    return ctx.db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        target: auditLog.target,
        at: auditLog.at,
        details: auditLog.details,
        email: users.email,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.userId))
      .where(eq(auditLog.workspaceId, workspaceId))
      .orderBy(desc(auditLog.at))
      .limit(limit)
      .all();
  });
}
