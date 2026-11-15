/**
 * The company-universe import (SPEC §5.1 step 1) as a resumable engine job on the VPS.
 *
 * Each run of the `universe.import` job is one slice of about `LIMITS.sliceMs`:
 *   1. download: stream the file to `<imports dir>/<file>`; a partial file resumes with Range;
 *   2. process: stream-parse records, keep US companies with a website (and the workspace ICP
 *      where the source allows it), and upsert them in batches of `LIMITS.batch` rows per transaction.
 * The slice returns `ContinueJob`, so other jobs run in between. `rows_read` is updated in
 * the same transaction as each batch, so after a crash the import skips exactly the rows
 * already written. The record iterator is kept between slices of one process.
 */
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../api/context.ts';
import { activeIcp } from '../crm/scoring.ts';
import type { Db, Tx } from '../db/client.ts';
import { companies, universeImports, type ImportFilter } from '../db/schema.ts';
import { newId } from '../ids.ts';
import { ContinueJob, enqueue, PermanentJobError, type JobHandler } from '../jobs/queue.ts';
import { DownloadError, downloadSlice, openTextStream } from './files.ts';
import { icpDropReason, nameKey, sizeBounds, type UniverseRow } from './normalize.ts';
import type { RawRecord } from './records.ts';
import { SOURCES, type SourceDef } from './sources.ts';

/** Slice length and batch size (tests shrink them). Each slice writes at least one batch. */
export const LIMITS = { sliceMs: 15_000, batch: 1_000 };

type ImportRow = typeof universeImports.$inferSelect;

interface Cursor {
  rowsRead: number;
  iter: AsyncIterator<RawRecord>;
  close(): void;
}
const cursors = new Map<string, Cursor>();

export function closeCursor(importId: string): void {
  cursors.get(importId)?.close();
  cursors.delete(importId);
}

export function importFilePath(ctx: AppContext, row: Pick<ImportRow, 'fileName'>): string {
  return path.join(ctx.config.importsDir, row.fileName);
}

export function sourceOf(id: string): SourceDef {
  const s = SOURCES[id];
  if (!s) throw new PermanentJobError(`unknown source ${id}`);
  return s;
}

/** The ICP prefilter from the workspace's approved offer, or null (no ICP / not applicable). */
export function icpFilterFor(db: Db, workspaceId: string): ImportFilter | null {
  const icp = activeIcp(db, workspaceId);
  if (!icp) return null;
  return {
    industries: icp.industries,
    employeeRange: icp.employeeRange || null,
    states: icp.states,
    exclude: icp.exclude,
  };
}

/** Creates the import row and queues its job. */
export function startImport(
  ctx: AppContext,
  input: {
    workspaceId: string;
    userId: string | null;
    source: SourceDef;
    url: string | null;
    fileName: string | null;
    filter: ImportFilter | null;
  },
): { id: string; jobId: string } {
  const now = ctx.now();
  const id = newId('imp');
  const fileName = input.fileName ?? `${id}.download`;
  return ctx.db.transaction((tx) => {
    tx.insert(universeImports)
      .values({
        id,
        workspaceId: input.workspaceId,
        source: input.source.id,
        url: input.url,
        fileName,
        state: 'queued',
        filter: input.filter,
        createdBy: input.userId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const jobId = enqueue(
      tx,
      { workspaceId: input.workspaceId, type: 'universe.import', payload: { importId: id } },
      now,
    );
    tx.update(universeImports).set({ jobId }).where(eq(universeImports.id, id)).run();
    return { id, jobId };
  });
}

/** Queues another slice for a paused (or interrupted) import. */
export function resumeImport(ctx: AppContext, row: ImportRow): string {
  const now = ctx.now();
  return ctx.db.transaction((tx) => {
    const jobId = enqueue(
      tx,
      { workspaceId: row.workspaceId, type: 'universe.import', payload: { importId: row.id } },
      now,
    );
    tx.update(universeImports)
      .set({
        state:
          row.url && !(row.bytesTotal !== null && row.bytesDone >= row.bytesTotal)
            ? 'downloading'
            : 'processing',
        error: null,
        jobId,
        updatedAt: now,
      })
      .where(eq(universeImports.id, row.id))
      .run();
    return jobId;
  });
}

export interface WriteCounts {
  inserted: number;
  updated: number;
  dropped: Record<string, number>;
}

const FIELDS = ['state', 'city', 'industry', 'naics', 'sizeRange', 'foundedYear'] as const;

/**
 * Upserts dataset companies by domain. Existing values win (manual edits and earlier data are
 * never overwritten); fields the dataset fills are recorded in `origins` for source dots.
 */
export function writeCompanies(
  db: Tx,
  source: string,
  rows: UniverseRow[],
  now: number,
  counts: WriteCounts,
): void {
  for (const r of rows) {
    const existing = db.select().from(companies).where(eq(companies.domain, r.domain)).get();
    const key = nameKey(r.name);
    if (!existing) {
      const origins: Record<string, string> = { name: source };
      for (const f of FIELDS) if (r[f] !== null) origins[f] = source;
      db.insert(companies)
        .values({
          id: newId('co'),
          domain: r.domain,
          name: r.name,
          country: 'US',
          state: r.state,
          city: r.city,
          industry: r.industry,
          naics: r.naics,
          sizeRange: r.sizeRange,
          ...sizeBounds(r.sizeRange),
          foundedYear: r.foundedYear,
          sources: [source],
          tech: [],
          universe: true,
          nameKey: key,
          origins,
          updatedAt: now,
        })
        .run();
      counts.inserted++;
      continue;
    }
    if (existing.country !== 'US') {
      counts.dropped.not_us = (counts.dropped.not_us ?? 0) + 1;
      continue;
    }
    const set: Partial<typeof companies.$inferInsert> = {};
    const origins = { ...existing.origins };
    for (const f of FIELDS) {
      if (existing[f] == null && r[f] != null) {
        (set as Record<string, unknown>)[f] = r[f];
        origins[f] = source;
      }
    }
    if (set.sizeRange) Object.assign(set, sizeBounds(set.sizeRange));
    else if (existing.sizeRange && existing.sizeMin == null)
      Object.assign(set, sizeBounds(existing.sizeRange));
    db.update(companies)
      .set({
        ...set,
        origins,
        universe: true,
        nameKey: existing.nameKey ?? key,
        sources: existing.sources.includes(source)
          ? existing.sources
          : [...existing.sources, source],
        updatedAt: now,
      })
      .where(eq(companies.id, existing.id))
      .run();
    counts.updated++;
  }
}

/** Tags existing companies with an EDGAR CIK when exactly one company has the same name key. */
export function writeMatches(
  db: Tx,
  source: string,
  rows: { nameKey: string; cik: string; ticker: string | null }[],
  now: number,
  counts: WriteCounts,
): void {
  for (const r of rows) {
    const hits = db
      .select({ id: companies.id, sources: companies.sources, origins: companies.origins })
      .from(companies)
      .where(eq(companies.nameKey, r.nameKey))
      .limit(2)
      .all();
    if (hits.length !== 1) {
      const reason = hits.length ? 'ambiguous' : 'no_match';
      counts.dropped[reason] = (counts.dropped[reason] ?? 0) + 1;
      continue;
    }
    const hit = hits[0]!;
    db.update(companies)
      .set({
        cik: r.cik,
        ticker: r.ticker,
        sources: hit.sources.includes(source) ? hit.sources : [...hit.sources, source],
        origins: { ...hit.origins, cik: source },
        updatedAt: now,
      })
      .where(eq(companies.id, hit.id))
      .run();
    counts.updated++;
  }
}

async function openCursor(ctx: AppContext, row: ImportRow, source: SourceDef): Promise<Cursor> {
  const { stream } = await openTextStream(importFilePath(ctx, row));
  const iter = source.records(stream)[Symbol.asyncIterator]();
  const cursor: Cursor = {
    rowsRead: 0,
    iter,
    close: () => {
      stream.destroy();
      void iter.return?.(undefined);
    },
  };
  // Skip rows a previous process already wrote.
  while (cursor.rowsRead < row.rowsRead) {
    const n = await iter.next();
    if (n.done) break;
    cursor.rowsRead++;
  }
  return cursor;
}

export function universeImportHandler(): JobHandler {
  return async ({ ctx, job }) => {
    const importId = String(job.payload.importId);
    const load = () =>
      ctx.db.select().from(universeImports).where(eq(universeImports.id, importId)).get();
    let row = load();
    if (!row) throw new PermanentJobError('import not found');
    if (row.jobId && row.jobId !== job.id) return { skipped: 'superseded' };
    if (['paused', 'done', 'failed', 'cancelled'].includes(row.state)) {
      closeCursor(importId);
      return { skipped: row.state };
    }
    const source = sourceOf(row.source);
    const update = (values: Partial<ImportRow>) =>
      ctx.db
        .update(universeImports)
        .set({ ...values, updatedAt: ctx.now() })
        .where(eq(universeImports.id, importId))
        .run();
    const fail = (message: string) => {
      update({ state: 'failed', error: message, finishedAt: ctx.now() });
      closeCursor(importId);
      return new PermanentJobError(message);
    };
    const missing = source.unavailable(ctx.config);
    if (missing) throw fail(missing);
    const deadline = ctx.now() + LIMITS.sliceMs;
    mkdirSync(ctx.config.importsDir, { recursive: true });

    // 1. Download
    if (row.url && (row.state === 'queued' || row.state === 'downloading')) {
      update({ state: 'downloading' });
      let progress;
      try {
        progress = await downloadSlice({
          url: row.url,
          file: importFilePath(ctx, row),
          deadline,
          now: ctx.now,
          headers: source.headers(ctx.config),
          ...(ctx.download ? { fetch: ctx.download } : {}),
          onProgress: (p) => update({ bytesDone: p.bytesDone, bytesTotal: p.bytesTotal }),
        });
      } catch (err) {
        if (err instanceof DownloadError && err.permanent) throw fail(err.message);
        throw err; // retried with backoff; the partial file resumes
      }
      update({ bytesDone: progress.bytesDone, bytesTotal: progress.bytesTotal });
      if (!progress.done)
        return new ContinueJob(0, { phase: 'download', bytes: progress.bytesDone });
      update({ state: 'processing' });
      row = load()!;
    } else if (row.state === 'queued') {
      update({ state: 'processing' });
      row = load()!;
    }

    // 2. Process
    let cursor = cursors.get(importId);
    if (!cursor || cursor.rowsRead !== row.rowsRead) {
      closeCursor(importId);
      try {
        cursor = await openCursor(ctx, row, source);
      } catch (err) {
        throw fail(`cannot read ${row.fileName}: ${(err as Error).message}`);
      }
      cursors.set(importId, cursor);
    }
    const filter = source.icpFilter ? row.filter : null;
    let finished = false;
    do {
      const companiesBatch: UniverseRow[] = [];
      const matches: { nameKey: string; cik: string; ticker: string | null }[] = [];
      const counts: WriteCounts = { inserted: 0, updated: 0, dropped: {} };
      let read = 0;
      while (read < LIMITS.batch) {
        let n;
        try {
          n = await cursor.iter.next();
        } catch (err) {
          throw fail(`cannot parse ${row.fileName}: ${(err as Error).message}`);
        }
        if (n.done) {
          finished = true;
          break;
        }
        read++;
        const mapped = source.map(n.value);
        if (mapped.kind === 'drop') {
          counts.dropped[mapped.reason] = (counts.dropped[mapped.reason] ?? 0) + 1;
        } else if (mapped.kind === 'match') {
          matches.push(mapped);
        } else {
          const reason = filter ? icpDropReason(mapped.row, filter) : null;
          if (reason) counts.dropped[reason] = (counts.dropped[reason] ?? 0) + 1;
          else companiesBatch.push(mapped.row);
        }
      }
      const now = ctx.now();
      const current = row;
      ctx.db.transaction((tx) => {
        writeCompanies(tx, source.id, companiesBatch, now, counts);
        writeMatches(tx, source.id, matches, now, counts);
        const dropped = { ...current.dropped };
        for (const [k, v] of Object.entries(counts.dropped)) dropped[k] = (dropped[k] ?? 0) + v;
        tx.update(universeImports)
          .set({
            rowsRead: current.rowsRead + read,
            rowsKept: current.rowsKept + companiesBatch.length + matches.length,
            rowsInserted: current.rowsInserted + counts.inserted,
            rowsUpdated: current.rowsUpdated + counts.updated,
            dropped,
            updatedAt: now,
          })
          .where(eq(universeImports.id, importId))
          .run();
      });
      cursor.rowsRead += read;
      row = load()!;
      if (row.state !== 'processing') {
        // Paused or cancelled from the UI mid-slice.
        closeCursor(importId);
        return { stopped: row.state };
      }
    } while (!finished && ctx.now() < deadline);
    if (!finished) return new ContinueJob(0, { phase: 'process', rows: row.rowsRead });
    closeCursor(importId);
    update({ state: 'done', finishedAt: ctx.now(), error: null });
    // Downloaded files are deleted once imported; files placed by an operator are kept.
    if (row.url) rmSync(importFilePath(ctx, row), { force: true });
    return { rowsRead: row.rowsRead, inserted: row.rowsInserted, updated: row.rowsUpdated };
  };
}
