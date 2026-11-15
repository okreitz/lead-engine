/**
 * Dataset files on the data volume: resumable streaming download and streaming open
 * (ZIP, gzip or plain text). Nothing here reads a whole file into memory.
 */
import { once } from 'node:events';
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { Agent, fetch as undiciFetch } from 'undici';
import yauzl from 'yauzl';
import { safeLookup } from '../crawler/net-guard.ts';

export type DownloadFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | null;
}>;

let defaultFetch: DownloadFetch | null = null;
/** undici with the crawler's SSRF guard: every connection, redirects included, must be public. */
function publicFetch(): DownloadFetch {
  if (!defaultFetch) {
    const dispatcher = new Agent({
      connect: { lookup: safeLookup },
      connectTimeout: 15_000,
      bodyTimeout: 60_000,
    });
    defaultFetch = (url, init) =>
      undiciFetch(url, { ...init, redirect: 'follow', dispatcher }) as ReturnType<DownloadFetch>;
  }
  return defaultFetch;
}

export class DownloadError extends Error {
  override name = 'DownloadError';
  constructor(
    message: string,
    public readonly permanent: boolean,
  ) {
    super(message);
  }
}

export interface DownloadProgress {
  done: boolean;
  bytesDone: number;
  bytesTotal: number | null;
}

/**
 * Downloads `url` into `file` until it is complete or `deadline` passes. A partial file is
 * resumed with an HTTP Range request; a server that ignores Range restarts from zero and is
 * then read to the end in one go (it can't be resumed anyway).
 */
export async function downloadSlice(opts: {
  url: string;
  file: string;
  deadline: number;
  now: () => number;
  headers?: Record<string, string>;
  fetch?: DownloadFetch;
  onProgress?: (p: DownloadProgress) => void;
}): Promise<DownloadProgress> {
  const fetchImpl = opts.fetch ?? publicFetch();
  const offset = existsSync(opts.file) ? statSync(opts.file).size : 0;
  const controller = new AbortController();
  const headers: Record<string, string> = { ...opts.headers, 'accept-encoding': 'identity' };
  if (offset > 0) headers.range = `bytes=${offset}-`;
  let res;
  try {
    res = await fetchImpl(opts.url, { headers, signal: controller.signal });
  } catch (err) {
    throw new DownloadError(`download failed: ${(err as Error).message}`, false);
  }
  if (res.status === 416 && offset > 0) {
    return { done: true, bytesDone: offset, bytesTotal: offset };
  }
  if (res.status !== 200 && res.status !== 206) {
    throw new DownloadError(
      `download failed: HTTP ${res.status}`,
      res.status >= 400 && res.status < 500,
    );
  }
  const resumed = res.status === 206;
  const resumable = resumed || res.headers.get('accept-ranges') === 'bytes';
  const length = Number(res.headers.get('content-length') ?? NaN);
  const range = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '');
  const bytesTotal = range
    ? Number(range[1])
    : Number.isFinite(length)
      ? (resumed ? offset : 0) + length
      : null;
  const out = createWriteStream(opts.file, { flags: resumed ? 'a' : 'w' });
  let bytesDone = resumed ? offset : 0;
  let lastReport = 0;
  let stopped = false;
  try {
    if (res.body) {
      for await (const chunk of res.body) {
        if (!out.write(chunk)) await once(out, 'drain');
        bytesDone += chunk.byteLength;
        const t = opts.now();
        if (t - lastReport > 1000) {
          lastReport = t;
          opts.onProgress?.({ done: false, bytesDone, bytesTotal });
        }
        // Only resumable downloads stop at the deadline.
        if (resumable && t >= opts.deadline) {
          stopped = true;
          controller.abort();
          break;
        }
      }
    }
  } catch (err) {
    if (!stopped) {
      out.end();
      await once(out, 'close');
      throw new DownloadError(`download interrupted: ${(err as Error).message}`, false);
    }
  }
  out.end();
  await once(out, 'close');
  if (stopped) return { done: false, bytesDone, bytesTotal };
  if (bytesTotal !== null && bytesDone < bytesTotal) {
    return { done: false, bytesDone, bytesTotal };
  }
  return { done: true, bytesDone, bytesTotal: bytesTotal ?? bytesDone };
}

/** Allowed file names inside the imports folder (no paths). */
export function safeFileName(name: string): string | null {
  const base = path.basename(name);
  return base === name && /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(base) ? base : null;
}

const DATA_ENTRY = /\.(csv|jsonl?|ndjson|txt|dat)$/i;

/** Opens the dataset as a UTF-8 text stream: the largest data entry of a ZIP, gunzip, or plain. */
export async function openTextStream(file: string): Promise<{ stream: Readable; entry: string }> {
  const fh = await openFile(file, 'r');
  const magic = Buffer.alloc(4);
  try {
    await fh.read(magic, 0, 4, 0);
  } finally {
    await fh.close();
  }
  if (magic[0] === 0x50 && magic[1] === 0x4b) return openZipEntry(file);
  const raw = createReadStream(file, { highWaterMark: 64 * 1024 });
  if (magic[0] === 0x1f && magic[1] === 0x8b) {
    const gz = raw.pipe(createGunzip());
    raw.on('error', (e) => gz.destroy(e));
    gz.setEncoding('utf8');
    return { stream: gz, entry: path.basename(file) };
  }
  raw.setEncoding('utf8');
  return { stream: raw, entry: path.basename(file) };
}

function openZipEntry(file: string): Promise<{ stream: Readable; entry: string }> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('cannot open zip'));
      let best: yauzl.Entry | null = null;
      zip.on('entry', (entry: yauzl.Entry) => {
        if (
          !entry.fileName.endsWith('/') &&
          !entry.fileName.startsWith('__MACOSX') &&
          DATA_ENTRY.test(entry.fileName) &&
          (!best || entry.uncompressedSize > best.uncompressedSize)
        ) {
          best = entry;
        }
        zip.readEntry();
      });
      zip.on('error', reject);
      zip.on('end', () => {
        const chosen = best as yauzl.Entry | null;
        if (!chosen) {
          zip.close();
          return reject(new Error('the ZIP has no CSV or JSON data file'));
        }
        zip.openReadStream(chosen, (e, stream) => {
          if (e || !stream) {
            zip.close();
            return reject(e ?? new Error('cannot read zip entry'));
          }
          stream.on('close', () => zip.close());
          stream.setEncoding('utf8');
          resolve({ stream, entry: chosen.fileName });
        });
      });
      zip.readEntry();
    });
  });
}
