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
});

export interface Config {
  host: string;
  enginePort: number;
  collectorPort: number;
  dbPath: string;
  logLevel: z.infer<typeof envSchema>['LE_LOG_LEVEL'];
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
  };
}
