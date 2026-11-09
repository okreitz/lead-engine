/** Default local ports (SPEC §2, CLAUDE.md). */
export const PORTS = {
  web: 4500,
  engine: 4501,
  collector: 4511,
} as const;

/** Local mode binds to loopback only (CLAUDE.md "Bind and auth"). */
export const DEFAULT_HOST = '127.0.0.1';

/** v1 is US only (SPEC §9). */
export const ALLOWED_COUNTRIES = ['US'] as const;
export type AllowedCountry = (typeof ALLOWED_COUNTRIES)[number];

/** Default monthly spend cap per workspace, in USD (SPEC §8.1). */
export const DEFAULT_MONTHLY_BUDGET_USD = 50;

/** Collector request body cap in bytes (SPEC §5.2, §10). */
export const COLLECTOR_BODY_LIMIT_BYTES = 2048;
