/**
 * Country and ASN lookups from local free `.mmdb` files (SPEC §5.2 step 3, docs/decisions.md):
 * - DB-IP Lite (CC BY 4.0, no account) by default: one country and one ASN database, monthly.
 * - IPinfo Lite (CC BY-SA 4.0) when `LE_IPINFO_TOKEN` is set: one file with both.
 *
 * Files are downloaded at runtime into `<data>/geo/` and never shipped in the image or repo
 * (IPinfo's ShareAlike). Each file is read once into a Buffer (DB-IP: ~18 MB together) and
 * queried with `maxmind`'s reader, which decodes records lazily with a small LRU cache.
 * Without a database the collector fails closed: no country means the visit is dropped.
 */
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { Reader, type AsnResponse, type CountryResponse, type Response } from 'maxmind';
import { fetch as undiciFetch } from 'undici';

export interface GeoInfo {
  /** ISO 3166-1 alpha-2, upper case. */
  country: string | null;
  asn: number | null;
  asOrg: string | null;
  /** IPinfo Lite only. */
  asDomain: string | null;
}

export interface GeoDb {
  readonly source: 'dbip' | 'ipinfo' | 'fake';
  lookup(ip: string): GeoInfo | null;
}

export interface GeoStatus {
  source: 'dbip' | 'ipinfo' | 'fake' | null;
  ready: boolean;
  /** When the files on disk were downloaded. */
  updatedAt: number | null;
  error: string | null;
}

const MAX_BYTES = 200 * 1024 * 1024;
const REFRESH_MS = 32 * 86_400_000;
/** A bounded cache for decoded records (reset when full; cheap and good enough here). */
function smallCache(max = 2000) {
  const map = new Map<string | number, unknown>();
  return {
    get: (key: string | number) => map.get(key),
    set: (key: string | number, value: unknown) => {
      if (map.size >= max) map.clear();
      map.set(key, value);
    },
  };
}

interface IpinfoLite {
  country_code?: string;
  asn?: string;
  as_name?: string;
  as_domain?: string;
}

export class DbipGeo implements GeoDb {
  readonly source = 'dbip' as const;
  constructor(
    private readonly country: Reader<CountryResponse>,
    private readonly asn: Reader<AsnResponse> | null,
  ) {}
  lookup(ip: string): GeoInfo | null {
    const c = this.country.get(ip);
    const a = this.asn?.get(ip) ?? null;
    if (!c && !a) return null;
    return {
      country: c?.country?.iso_code?.toUpperCase() ?? null,
      asn: a?.autonomous_system_number ?? null,
      asOrg: a?.autonomous_system_organization ?? null,
      asDomain: null,
    };
  }
}

export class IpinfoGeo implements GeoDb {
  readonly source = 'ipinfo' as const;
  constructor(private readonly reader: Reader<Response>) {}
  lookup(ip: string): GeoInfo | null {
    const r = this.reader.get(ip) as IpinfoLite | null;
    if (!r) return null;
    const asn = r.asn ? Number(r.asn.replace(/^AS/i, '')) : NaN;
    return {
      country: r.country_code?.toUpperCase() ?? null,
      asn: Number.isFinite(asn) ? asn : null,
      asOrg: r.as_name ?? null,
      asDomain: r.as_domain ?? null,
    };
  }
}

/** A fixed table of CIDR → info, for tests and fixtures. */
export class FakeGeo implements GeoDb {
  readonly source = 'fake' as const;
  constructor(private readonly table: (GeoInfo & { match: (ip: string) => boolean })[]) {}
  lookup(ip: string): GeoInfo | null {
    const hit = this.table.find((r) => r.match(ip));
    return hit
      ? { country: hit.country, asn: hit.asn, asOrg: hit.asOrg, asDomain: hit.asDomain }
      : null;
  }
}

function openReader<T extends Response>(file: string): Reader<T> {
  return new Reader<T>(readFileSync(file), { cache: smallCache() });
}

export interface GeoFiles {
  dir: string;
  ipinfoToken: string | null;
}

function filesFor(f: GeoFiles) {
  return f.ipinfoToken
    ? { source: 'ipinfo' as const, files: [path.join(f.dir, 'ipinfo_lite.mmdb')] }
    : {
        source: 'dbip' as const,
        files: [path.join(f.dir, 'dbip-country-lite.mmdb'), path.join(f.dir, 'dbip-asn-lite.mmdb')],
      };
}

/** Opens whatever is on disk; null when a file is missing. */
export function loadGeo(f: GeoFiles): GeoDb | null {
  const { source, files } = filesFor(f);
  if (!files.every((p) => existsSync(p))) return null;
  if (source === 'ipinfo') return new IpinfoGeo(openReader<Response>(files[0]!));
  return new DbipGeo(openReader<CountryResponse>(files[0]!), openReader<AsnResponse>(files[1]!));
}

function dbipUrls(now: number): { kind: 'country' | 'asn'; urls: string[] }[] {
  const d = new Date(now);
  const months = [0, 1].map((back) => {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1));
    return m.toISOString().slice(0, 7);
  });
  // The new month's file appears on the 1st; fall back to last month's until then.
  return (['country', 'asn'] as const).map((kind) => ({
    kind,
    urls: months.map((m) => `https://download.db-ip.com/free/dbip-${kind}-lite-${m}.mmdb.gz`),
  }));
}

async function download(url: string, dest: string, gz: boolean): Promise<void> {
  const res = await undiciFetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(5 * 60_000),
    headers: { 'user-agent': 'LeadEngine geo updater' },
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) throw new Error('file too large');
  let seen = 0;
  const source = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
  source.on('data', (chunk: Buffer) => {
    seen += chunk.length;
    if (seen > MAX_BYTES) source.destroy(new Error('file too large'));
  });
  const tmp = `${dest}.part`;
  try {
    if (gz) await pipeline(source, createGunzip(), createWriteStream(tmp));
    else await pipeline(source, createWriteStream(tmp));
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Moves `<file>.part` into place after checking it opens and knows a well-known US address. */
function commit(file: string, check: (r: Reader<Response>) => boolean): void {
  const tmp = `${file}.part`;
  let ok = false;
  try {
    ok = check(new Reader<Response>(readFileSync(tmp)));
  } catch {
    ok = false;
  }
  if (!ok) {
    rmSync(tmp, { force: true });
    throw new Error(`${path.basename(file)} failed validation`);
  }
  renameSync(tmp, file);
}

const US_PROBE = '8.8.8.8';

/** Downloads the configured databases when missing or older than ~a month. */
export async function updateGeoFiles(f: GeoFiles, now: number, force = false): Promise<boolean> {
  mkdirSync(f.dir, { recursive: true });
  const { source, files } = filesFor(f);
  const stale =
    force || files.some((p) => !existsSync(p) || now - statSync(p).mtimeMs > REFRESH_MS);
  if (!stale) return false;
  if (source === 'ipinfo') {
    const file = files[0]!;
    const url = `https://ipinfo.io/data/ipinfo_lite.mmdb?token=${encodeURIComponent(f.ipinfoToken!)}`;
    try {
      await download(url, `${file}`, false);
    } catch (err) {
      // Never log the URL: it carries the token.
      throw new Error(`IPinfo Lite download failed: ${(err as Error).message}`);
    }
    commit(file, (r) => (r.get(US_PROBE) as IpinfoLite | null)?.country_code === 'US');
    return true;
  }
  for (const { kind, urls } of dbipUrls(now)) {
    const file = path.join(f.dir, `dbip-${kind}-lite.mmdb`);
    let last: Error | null = null;
    for (const url of urls) {
      try {
        await download(url, file, true);
        last = null;
        break;
      } catch (err) {
        last = err as Error;
      }
    }
    if (last) throw new Error(`DB-IP ${kind} download failed: ${last.message}`);
    commit(file, (r) =>
      kind === 'country'
        ? (r.get(US_PROBE) as CountryResponse | null)?.country?.iso_code === 'US'
        : typeof (r.get(US_PROBE) as AsnResponse | null)?.autonomous_system_number === 'number',
    );
  }
  return true;
}

/** Holds the current database, refreshes it daily in the background and swaps it in place. */
export class GeoService {
  private db: GeoDb | null = null;
  private status: GeoStatus = { source: null, ready: false, updatedAt: null, error: null };
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly files: GeoFiles,
    private readonly opts: { download: boolean; now: () => number },
  ) {}

  current(): GeoDb | null {
    return this.db;
  }

  state(): GeoStatus {
    return this.status;
  }

  private reload(): void {
    this.db = loadGeo(this.files);
    const { files } = filesFor(this.files);
    this.status = {
      source: this.db?.source ?? null,
      ready: this.db !== null,
      updatedAt: this.db ? Math.min(...files.map((p) => statSync(p).mtimeMs)) : null,
      error: this.status.error,
    };
  }

  async refresh(force = false): Promise<void> {
    try {
      if (this.opts.download) await updateGeoFiles(this.files, this.opts.now(), force);
      this.status.error = null;
    } catch (err) {
      this.status.error = (err as Error).message;
    }
    try {
      this.reload();
    } catch (err) {
      this.status = { ...this.status, ready: this.db !== null, error: (err as Error).message };
    }
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 86_400_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
