import type { Stream } from '@le/shared';

/** Typed paid operations (SPEC §4.3). */
export type Operation =
  'findEmail' | 'verifyEmail' | 'findPeople' | 'ipLookup' | 'serpSearch' | 'llm' | 'test';

export interface Provenance {
  field: string;
  url?: string;
  confidence: number;
}

export interface ProviderResponse<O> {
  value: O;
  /** Actual cost of this call in USD (0 when it was free). */
  usd: number;
  /** Provider units (credits, tokens, queries). */
  units: number;
  /** True when `usd` is a client-side estimate. */
  estimated?: boolean;
  /** Waterfalls stop at the first confident result. */
  confident: boolean;
  /** Written to FieldSource when the call has a target entity. */
  provenance?: Provenance[];
  /** Kept in the ledger (no secrets, no personal data). */
  meta?: Record<string, unknown>;
}

export interface FreeQuota {
  limit: number;
  period: 'day' | 'month' | 'lifetime';
}

/** One provider operation. Real adapters live next to this file; tests use `fake.ts`. */
export interface ProviderAdapter<I, O> {
  /** Ledger name, e.g. 'icypeas', 'anthropic-api', 'claude-cli'. */
  provider: string;
  operation: Operation;
  /** Which workspace key it needs (null = no key). */
  keyProvider: string | null;
  /** 0 disables the cache. */
  cacheTtlMs: number;
  /** Calls inside the free quota cost $0 and are counted instead. */
  freeQuota?: FreeQuota;
  /** Hard monthly cap on paid spend for this provider ($0 for Serper, SPEC §8.1). */
  maxPaidUsdPerMonth?: number;
  /** Upper bound of a paid call's cost, checked against the budget before calling. */
  estimateUsd(input: I): number;
  /** Emails/domains the call is about, for the suppression check. */
  subjects?(input: I): { emails?: string[]; domains?: string[] };
  /** Stable cache key material (defaults to the whole input). */
  cacheKey?(input: I): unknown;
  call(input: I, env: { apiKey: string | null }): Promise<ProviderResponse<O>>;
}

export interface CallOptions<O> {
  workspaceId: string;
  stream: Stream;
  jobId?: string;
  /** Entity whose fields the result fills, for FieldSource. */
  target?: { entity: 'company' | 'account' | 'contact'; entityId: string };
  /** Skip the cache read (the result is still cached). */
  refresh?: boolean;
  /** Only results that pass are cached (e.g. schema-valid LLM output). */
  accept?: (value: O) => boolean;
}

export type CallResult<O> =
  | { status: 'ok'; value: O; cached: boolean; usd: number; confident: boolean }
  | { status: 'suppressed'; reason: string };
