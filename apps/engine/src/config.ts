import path from 'node:path';
import { DEFAULT_HOST, PORTS } from '@le/shared';
import { z } from 'zod';

const port = (fallback: number) => z.coerce.number().int().min(1).max(65535).default(fallback);

const envSchema = z.object({
  /** Interface to bind. Loopback by default; the Docker image sets 0.0.0.0 inside the container. */
  LE_HOST: z.string().default(DEFAULT_HOST),
  LE_ENGINE_PORT: port(PORTS.engine),
  LE_COLLECTOR_PORT: port(PORTS.collector),
  LE_DB_PATH: z.string().default('../../data/le.db'),
  LE_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  /** 32 bytes, base64. Encrypts workspace provider keys. Optional until a key is saved. */
  LE_MASTER_KEY: z.string().optional(),
  /** Required to create the first user when the engine binds a non-loopback interface. */
  LE_SETUP_TOKEN: z.string().min(16).optional(),
  /** `auto` marks the session cookie Secure when the request came in over HTTPS. */
  LE_COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
  /** Run the in-process job worker (off in tests). */
  LE_JOBS: z.enum(['on', 'off']).default('on'),
  /** Fallback Anthropic API key for the `anthropic-api` adapter (workspace keys take precedence). */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Folder for dataset downloads (company universe import). Default: `imports/` next to the DB. */
  LE_IMPORTS_DIR: z.string().optional(),
  /**
   * SEC EDGAR requires a declared User-Agent with a contact address, e.g.
   * "Lead Engine admin@yourdomain.com" (docs/providers.md). EDGAR features are off without it.
   */
  LE_SEC_USER_AGENT: z.string().min(5).optional(),
  /** Reacher sidecar: off until outbound port 25 is confirmed (docs/providers.md). */
  LE_REACHER: z.enum(['on', 'off']).default('off'),
  LE_REACHER_URL: z.string().url().default('http://reacher:8080'),
  LE_REACHER_SECRET: z.string().optional(),
  /** Minimum gap between Reacher checks to one recipient domain. */
  LE_REACHER_DOMAIN_INTERVAL_MS: z.coerce.number().int().min(0).default(60_000),
  /** Public URL of the collector, used in the snippet (e.g. https://collect.example.com). */
  LE_COLLECTOR_URL: z.string().url().optional(),
  /** Header the reverse proxy puts the client IP in (Traefik: X-Real-Ip). */
  LE_CLIENT_IP_HEADER: z
    .string()
    .regex(/^[A-Za-z0-9-]+$/)
    .default('x-real-ip'),
  /** Folder for the country/ASN .mmdb files. Default: `geo/` next to the DB. */
  LE_GEO_DIR: z.string().optional(),
  /** Download and refresh the .mmdb files at runtime (off in tests and offline setups). */
  LE_GEO_DOWNLOAD: z.enum(['on', 'off']).default('on'),
  /** Optional IPinfo Lite token: use IPinfo Lite (CC BY-SA) instead of DB-IP Lite. */
  LE_IPINFO_TOKEN: z.string().min(6).optional(),
  /** Stream 2: the Bluesky Jetstream connection (opens only for workspaces with an approved offer). */
  LE_BLUESKY: z.enum(['on', 'off']).default('on'),
  /** Jetstream v2 instance (us-east or us-west). */
  LE_JETSTREAM_URL: z.string().url().default('https://jetstream.us-east.bsky.network'),
});

export interface Config {
  host: string;
  enginePort: number;
  collectorPort: number;
  dbPath: string;
  logLevel: z.infer<typeof envSchema>['LE_LOG_LEVEL'];
  /** Decoded LE_MASTER_KEY, or null when unset. */
  masterKey: Buffer | null;
  setupToken: string | null;
  cookieSecure: 'auto' | 'true' | 'false';
  jobs: boolean;
  anthropicApiKey: string | null;
  importsDir: string;
  secUserAgent: string | null;
  reacher: { enabled: boolean; url: string; secret: string | null; domainIntervalMs: number };
  collector: {
    publicUrl: string;
    clientIpHeader: string;
    geoDir: string;
    geoDownload: boolean;
    ipinfoToken: string | null;
  };
  bluesky: { enabled: boolean; jetstreamUrl: string };
}

/** True for loopback binds, where first-user setup needs no token. */
export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function decodeMasterKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('LE_MASTER_KEY must be 32 bytes, base64-encoded');
  return key;
}

/**
 * Reads instance settings from environment variables. A relative `LE_DB_PATH` resolves
 * against the working directory; pnpm runs package scripts from `apps/engine`, so the
 * default lands in the repo's gitignored `data/`. Docker sets an absolute path.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Compose passes unset optional variables as empty strings (`${VAR:-}`): treat them as unset.
  const parsed = envSchema.parse(
    Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== '')),
  );
  return {
    host: parsed.LE_HOST,
    enginePort: parsed.LE_ENGINE_PORT,
    collectorPort: parsed.LE_COLLECTOR_PORT,
    dbPath: path.resolve(parsed.LE_DB_PATH),
    logLevel: parsed.LE_LOG_LEVEL,
    masterKey: decodeMasterKey(parsed.LE_MASTER_KEY),
    setupToken: parsed.LE_SETUP_TOKEN ?? null,
    cookieSecure: parsed.LE_COOKIE_SECURE,
    jobs: parsed.LE_JOBS === 'on',
    anthropicApiKey: parsed.ANTHROPIC_API_KEY ?? null,
    importsDir: path.resolve(
      parsed.LE_IMPORTS_DIR ?? path.join(path.dirname(path.resolve(parsed.LE_DB_PATH)), 'imports'),
    ),
    secUserAgent: parsed.LE_SEC_USER_AGENT ?? null,
    reacher: {
      enabled: parsed.LE_REACHER === 'on',
      url: parsed.LE_REACHER_URL,
      secret: parsed.LE_REACHER_SECRET ?? null,
      domainIntervalMs: parsed.LE_REACHER_DOMAIN_INTERVAL_MS,
    },
    collector: {
      publicUrl: (
        parsed.LE_COLLECTOR_URL ??
        `http://${parsed.LE_HOST === '0.0.0.0' ? '127.0.0.1' : parsed.LE_HOST}:${parsed.LE_COLLECTOR_PORT}`
      ).replace(/\/+$/, ''),
      clientIpHeader: parsed.LE_CLIENT_IP_HEADER.toLowerCase(),
      geoDir: path.resolve(
        parsed.LE_GEO_DIR ?? path.join(path.dirname(path.resolve(parsed.LE_DB_PATH)), 'geo'),
      ),
      geoDownload: parsed.LE_GEO_DOWNLOAD === 'on',
      ipinfoToken: parsed.LE_IPINFO_TOKEN ?? null,
    },
    bluesky: {
      enabled: parsed.LE_BLUESKY === 'on' && parsed.LE_JOBS === 'on',
      jetstreamUrl: parsed.LE_JETSTREAM_URL.replace(/\/+$/, ''),
    },
  };
}
