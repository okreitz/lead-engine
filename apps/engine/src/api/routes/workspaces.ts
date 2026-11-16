import { clearIpapiBackoff } from '../../providers/ipapi.ts';
import {
  addMemberBodySchema,
  createTokenBodySchema,
  createWorkspaceBodySchema,
  deleteWorkspaceBodySchema,
  KEYED_PROVIDERS,
  providerKeyBodySchema,
  LOGO_MAX_BYTES,
  updateWorkspaceBodySchema,
  workspaceLogoBodySchema,
} from '@le/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../audit.ts';
import { parseSesKey } from '../../providers/ses.ts';
import { hashPassword } from '../../auth/passwords.ts';
import { setSessionWorkspace } from '../../auth/sessions.ts';
import { encryptSecret, MasterKeyMissingError } from '../../crypto/secrets.ts';
import {
  apiTokens,
  auditLog,
  memberships,
  providerKeys,
  users,
  workspaceLogos,
  workspaces,
  type WorkspaceSettings,
} from '../../db/schema.ts';
import { newId, newToken, sha256 } from '../../ids.ts';
import { resumeWaitingJobs } from '../../jobs/queue.ts';
import { createWorkspace, getWorkspace } from '../../workspaces.ts';
import type { AppContext } from '../context.ts';
import { HttpError, parse, sessionOf, workspaceOf } from '../http.ts';

const providerParam = z.object({ provider: z.enum(KEYED_PROVIDERS) });

/** The image type from the file's first bytes, or null when it is not PNG, JPEG or WebP. */
export function sniffImageType(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

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

  // ---- logo (sidebar branding)
  app.get('/api/v1/workspace/logo', async (request, reply) => {
    const { workspaceId } = workspaceOf(request);
    const logo = ctx.db
      .select()
      .from(workspaceLogos)
      .where(eq(workspaceLogos.workspaceId, workspaceId))
      .get();
    if (!logo) throw new HttpError(404, 'not_found');
    return (
      reply
        .header('content-type', logo.contentType)
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'")
        // The URL carries ?v=<updatedAt>, so a new upload is a new URL.
        .header('cache-control', 'private, max-age=31536000, immutable')
        .send(logo.data)
    );
  });

  app.put('/api/v1/workspace/logo', { config: { owner: true } }, async (request) => {
    const auth = sessionOf(request);
    const workspaceId = auth.workspaceId!;
    const { dataUrl } = parse(workspaceLogoBodySchema, request.body);
    const [header, b64] = dataUrl.split(',', 2) as [string, string];
    const declared = header.slice('data:'.length, header.indexOf(';'));
    const data = Buffer.from(b64, 'base64');
    if (data.length > LOGO_MAX_BYTES)
      throw new HttpError(
        400,
        'logo_too_large',
        `the logo must be at most ${LOGO_MAX_BYTES / 1024} kB`,
      );
    const sniffed = sniffImageType(data);
    if (!sniffed || sniffed !== declared)
      throw new HttpError(400, 'logo_invalid', 'the file is not a valid PNG, JPEG or WebP image');
    const now = ctx.now();
    ctx.db
      .insert(workspaceLogos)
      .values({ workspaceId, contentType: sniffed, data, updatedAt: now })
      .onConflictDoUpdate({
        target: workspaceLogos.workspaceId,
        set: { contentType: sniffed, data, updatedAt: now },
      })
      .run();
    audit(
      ctx.db,
      {
        workspaceId,
        userId: auth.userId,
        action: 'workspace.logo_update',
        target: `workspace:${workspaceId}`,
        details: { contentType: sniffed, bytes: data.length },
      },
      now,
    );
    return { logoUpdatedAt: now };
  });

  app.delete('/api/v1/workspace/logo', { config: { owner: true } }, async (request) => {
    const auth = sessionOf(request);
    const workspaceId = auth.workspaceId!;
    ctx.db.delete(workspaceLogos).where(eq(workspaceLogos.workspaceId, workspaceId)).run();
    audit(
      ctx.db,
      {
        workspaceId,
        userId: auth.userId,
        action: 'workspace.logo_remove',
        target: `workspace:${workspaceId}`,
      },
      ctx.now(),
    );
    return { ok: true };
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
      .select({
        provider: providerKeys.provider,
        createdAt: providerKeys.createdAt,
        lastUsedAt: providerKeys.lastUsedAt,
      })
      .from(providerKeys)
      .where(eq(providerKeys.workspaceId, workspaceId))
      .all();
    return {
      masterKeyConfigured: ctx.config.masterKey !== null,
      providers: KEYED_PROVIDERS.map((provider) => ({
        provider,
        configured: rows.some((r) => r.provider === provider),
        createdAt: rows.find((r) => r.provider === provider)?.createdAt ?? null,
        lastUsedAt: rows.find((r) => r.provider === provider)?.lastUsedAt ?? null,
      })),
    };
  });

  app.put('/api/v1/provider-keys/:provider', { config: { owner: true } }, async (request) => {
    const auth = sessionOf(request);
    const workspaceId = auth.workspaceId!;
    const { provider } = parse(providerParam, request.params);
    const { key } = parse(providerKeyBodySchema, request.body);
    if (provider === 'aws-ses' && !parseSesKey(key)) {
      throw new HttpError(
        400,
        'invalid_key',
        'enter the AWS access key ID, secret access key and an SES region such as us-east-1',
      );
    }
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
    if (provider === 'ipapi') clearIpapiBackoff(workspaceId);
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
