import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { startImportBodySchema } from '@le/shared';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../audit.ts';
import { checkUrl, CrawlError } from '../../crawler/crawler.ts';
import { companies, universeImports } from '../../db/schema.ts';
import { safeFileName } from '../../universe/files.ts';
import {
  closeCursor,
  icpFilterFor,
  importFilePath,
  resumeImport,
  startImport,
} from '../../universe/import.ts';
import { SOURCES } from '../../universe/sources.ts';
import type { AppContext } from '../context.ts';
import { HttpError, parse, sessionOf, workspaceOf } from '../http.ts';

const idParam = z.object({ id: z.string().min(1).max(64) });
const ACTIVE = ['queued', 'downloading', 'processing'];

/** Company universe import (SPEC §5.1 step 1), run on the VPS as an engine job. */
export function registerUniverseRoutes(app: FastifyInstance, ctx: AppContext): void {
  let countCache: { at: number; total: number; publicCompanies: number } | null = null;

  app.get('/api/v1/universe', async (request) => {
    const { workspaceId } = workspaceOf(request);
    const now = ctx.now();
    if (!countCache || now - countCache.at > 60_000) {
      countCache = {
        at: now,
        total:
          ctx.db
            .select({ n: sql<number>`count(*)` })
            .from(companies)
            .where(eq(companies.universe, true))
            .get()?.n ?? 0,
        publicCompanies:
          ctx.db
            .select({ n: sql<number>`count(*)` })
            .from(companies)
            .where(isNotNull(companies.cik))
            .get()?.n ?? 0,
      };
    }
    let files: { name: string; bytes: number }[] = [];
    if (existsSync(ctx.config.importsDir)) {
      const inUse = new Set(
        ctx.db
          .select({ f: universeImports.fileName })
          .from(universeImports)
          .all()
          .map((r) => r.f),
      );
      files = readdirSync(ctx.config.importsDir)
        .filter((n) => safeFileName(n) && !inUse.has(n) && !n.endsWith('.download'))
        .map((name) => ({ name, bytes: statSync(importFilePath(ctx, { fileName: name })).size }));
    }
    return {
      companies: countCache.total,
      publicCompanies: countCache.publicCompanies,
      hasIcp: icpFilterFor(ctx.db, workspaceId) !== null,
      sources: Object.values(SOURCES).map((s) => ({
        id: s.id,
        label: s.label,
        licence: s.licence,
        homepage: s.homepage,
        attribution: s.attribution,
        fixedUrl: s.fixedUrl ?? null,
        icpFilter: s.icpFilter,
        unavailable: s.unavailable(ctx.config),
      })),
      files,
      imports: ctx.db
        .select()
        .from(universeImports)
        .where(eq(universeImports.workspaceId, workspaceId))
        .orderBy(desc(universeImports.createdAt))
        .limit(20)
        .all()
        .map((r) => ({ ...r, url: r.url ? redactUrl(r.url) : null })),
    };
  });

  app.post('/api/v1/universe/imports', { config: { owner: true } }, async (request, reply) => {
    const auth = sessionOf(request);
    const workspaceId = auth.workspaceId!;
    const body = parse(startImportBodySchema, request.body);
    const source = SOURCES[body.source]!;
    const missing = source.unavailable(ctx.config);
    if (missing) throw new HttpError(409, 'source_unavailable', missing);
    const running = ctx.db
      .select({ id: universeImports.id })
      .from(universeImports)
      .where(sql`${universeImports.state} IN ('queued','downloading','processing')`)
      .get();
    if (running) throw new HttpError(409, 'import_running', 'another import is running');

    let url: string | null = source.fixedUrl ?? null;
    let fileName: string | null = null;
    if (!url) {
      if (body.url && body.file)
        throw new HttpError(400, 'invalid_request', 'give a URL or a file, not both');
      if (body.url) {
        try {
          const u = checkUrl(body.url);
          if (u.protocol !== 'https:') throw new HttpError(400, 'invalid_url', 'use an https link');
          url = u.toString();
        } catch (err) {
          if (err instanceof CrawlError) throw new HttpError(400, 'invalid_url', err.message);
          throw err;
        }
      } else if (body.file) {
        fileName = safeFileName(body.file);
        if (!fileName || !existsSync(importFilePath(ctx, { fileName })))
          throw new HttpError(400, 'invalid_file', `no file ${body.file} in the imports folder`);
      } else {
        throw new HttpError(400, 'invalid_request', 'give a download URL or a file name');
      }
    }
    const filter =
      source.icpFilter && body.filter === 'icp' ? icpFilterFor(ctx.db, workspaceId) : null;
    if (source.icpFilter && body.filter === 'icp' && !filter)
      throw new HttpError(409, 'no_icp', 'approve an offer profile first, or import all companies');
    const res = startImport(ctx, {
      workspaceId,
      userId: auth.userId,
      source,
      url,
      fileName,
      filter,
    });
    audit(
      ctx.db,
      {
        workspaceId,
        userId: auth.userId,
        action: 'universe.import',
        target: `import:${res.id}`,
        details: { source: source.id, filter: filter ? 'icp' : 'all', file: fileName },
      },
      ctx.now(),
    );
    countCache = null;
    return reply.code(201).send(res);
  });

  const requireImport = (workspaceId: string, id: string) => {
    const row = ctx.db
      .select()
      .from(universeImports)
      .where(and(eq(universeImports.id, id), eq(universeImports.workspaceId, workspaceId)))
      .get();
    if (!row) throw new HttpError(404, 'not_found', 'import not found');
    return row;
  };

  app.post('/api/v1/universe/imports/:id/pause', { config: { owner: true } }, async (request) => {
    const { workspaceId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    const row = requireImport(workspaceId, id);
    if (!ACTIVE.includes(row.state))
      throw new HttpError(409, 'not_running', `import is ${row.state}`);
    ctx.db
      .update(universeImports)
      .set({ state: 'paused', updatedAt: ctx.now() })
      .where(eq(universeImports.id, id))
      .run();
    return { ok: true };
  });

  app.post('/api/v1/universe/imports/:id/resume', { config: { owner: true } }, async (request) => {
    const { workspaceId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    const row = requireImport(workspaceId, id);
    if (row.state !== 'paused' && row.state !== 'failed')
      throw new HttpError(409, 'not_paused', `import is ${row.state}`);
    return { ok: true, jobId: resumeImport(ctx, row) };
  });

  // Cancel: stops the import and deletes a downloaded file (rows already written stay).
  app.delete('/api/v1/universe/imports/:id', { config: { owner: true } }, async (request) => {
    const { workspaceId, userId } = workspaceOf(request);
    const { id } = parse(idParam, request.params);
    const row = requireImport(workspaceId, id);
    closeCursor(id);
    if (row.state !== 'done')
      ctx.db
        .update(universeImports)
        .set({ state: 'cancelled', finishedAt: ctx.now(), updatedAt: ctx.now() })
        .where(eq(universeImports.id, id))
        .run();
    if (row.url) rmSync(importFilePath(ctx, row), { force: true });
    audit(
      ctx.db,
      { workspaceId, userId, action: 'universe.cancel', target: `import:${id}` },
      ctx.now(),
    );
    return { ok: true };
  });
}

/** Signed download links carry credentials in the query string; never show them back. */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}${u.search ? '?…' : ''}`;
  } catch {
    return '…';
  }
}
