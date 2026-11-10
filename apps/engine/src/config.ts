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
  const parsed = envSchema.parse(env);
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
  };
}
