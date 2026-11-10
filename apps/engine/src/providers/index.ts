/**
 * The only way to make a paid call (CLAUDE.md "Budget", SPEC §4.3). Every call goes:
 *
 *   1. suppression check   → suppressed subjects never reach a provider
 *   2. cache               → per workspace, TTL per adapter
 *   3. budget / free quota → free calls are counted; paid calls must fit the budget
 *   4. provider call       → result stripped of LinkedIn-derived fields
 *   5. CostLedger          → every call, including failures that cost money
 *   6. FieldSource         → provenance for the target entity
 */
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { AppContext } from '../api/context.ts';
import { decryptSecret } from '../crypto/secrets.ts';
import { costLedger, fieldSources, providerCache, providerKeys, quotaUsage } from '../db/schema.ts';
import { newId } from '../ids.ts';
import { maskSecrets } from '../log-mask.ts';
import { findSuppression } from '../suppression.ts';
import { assertBudget } from './budget.ts';
import { ProviderCallError, ProviderKeyMissingError } from './errors.ts';
import { stripLinkedIn } from './sanitize.ts';
import type { CallOptions, CallResult, FreeQuota, ProviderAdapter } from './types.ts';

export * from './errors.ts';
export type * from './types.ts';

/** Deterministic JSON (sorted keys) for cache keys. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function cacheKeyOf<I, O>(adapter: ProviderAdapter<I, O>, input: I): string {
  const material = adapter.cacheKey ? adapter.cacheKey(input) : input;
  return createHash('sha256')
    .update(`${adapter.provider}:${adapter.operation}:${stableStringify(material)}`)
    .digest('hex');
}

export function quotaPeriod(quota: FreeQuota, now: number): string {
  const iso = new Date(now).toISOString();
  return quota.period === 'day'
    ? iso.slice(0, 10)
    : quota.period === 'month'
      ? iso.slice(0, 7)
      : 'lifetime';
}

export function quotaUsed(
  ctx: AppContext,
  workspaceId: string,
  provider: string,
  period: string,
): number {
  return (
    ctx.db
      .select({ used: quotaUsage.used })
      .from(quotaUsage)
      .where(
        and(
          eq(quotaUsage.workspaceId, workspaceId),
          eq(quotaUsage.provider, provider),
          eq(quotaUsage.period, period),
        ),
      )
      .get()?.used ?? 0
  );
}

/** Decrypted workspace key, falling back to an instance key where one exists. */
export function getProviderKey(
  ctx: AppContext,
  workspaceId: string,
  provider: string,
): string | null {
  const row = ctx.db
    .select()
    .from(providerKeys)
    .where(and(eq(providerKeys.workspaceId, workspaceId), eq(providerKeys.provider, provider)))
    .get();
  if (row) return decryptSecret(ctx.config.masterKey, workspaceId, provider, row.encryptedKey);
  if (provider === 'anthropic') return ctx.config.anthropicApiKey;
  return null;
}

export async function callProvider<I, O>(
  ctx: AppContext,
  adapter: ProviderAdapter<I, O>,
  input: I,
  opts: CallOptions<O>,
): Promise<CallResult<O>> {
  const { db } = ctx;
  const { workspaceId } = opts;

  // 1. Suppression
  if (adapter.subjects) {
    const hit = findSuppression(db, workspaceId, adapter.subjects(input));
    if (hit) return { status: 'suppressed', reason: `${hit.kind} ${hit.value} is suppressed` };
  }

  // 2. Cache
  const key = cacheKeyOf(adapter, input);
  const startedAt = ctx.now();
  if (adapter.cacheTtlMs > 0 && !opts.refresh) {
    const hit = db
      .select()
      .from(providerCache)
      .where(and(eq(providerCache.workspaceId, workspaceId), eq(providerCache.key, key)))
      .get();
    if (hit && hit.expiresAt > startedAt) {
      return { status: 'ok', value: hit.result as O, cached: true, usd: 0, confident: true };
    }
  }

  // 3. Free quota first, then the budget.
  let free = false;
  let period: string | null = null;
  if (adapter.freeQuota) {
    period = quotaPeriod(adapter.freeQuota, startedAt);
    free = quotaUsed(ctx, workspaceId, adapter.provider, period) < adapter.freeQuota.limit;
  }
  if (!free) {
    assertBudget(db, {
      workspaceId,
      stream: opts.stream,
      provider: adapter.provider,
      estimateUsd: adapter.estimateUsd(input),
      maxPaidUsdPerMonth: adapter.maxPaidUsdPerMonth,
      now: startedAt,
    });
  }

  const apiKey = adapter.keyProvider ? getProviderKey(ctx, workspaceId, adapter.keyProvider) : null;
  if (adapter.keyProvider && !apiKey) throw new ProviderKeyMissingError(adapter.keyProvider);

  // 4. Call
  if (free && period) bumpQuota(ctx, workspaceId, adapter.provider, period);
  const ledger = (usd: number, units: number, estimated: boolean, meta?: Record<string, unknown>) =>
    db
      .insert(costLedger)
      .values({
        id: newId('led'),
        workspaceId,
        provider: adapter.provider,
        operation: adapter.operation,
        units,
        usd: free ? 0 : usd,
        estimated,
        free,
        stream: opts.stream,
        jobId: opts.jobId ?? null,
        meta: meta ?? null,
        at: ctx.now(),
      })
      .run();

  let response;
  try {
    response = await adapter.call(input, { apiKey });
  } catch (err) {
    // 5. Failed calls that cost money are still metered.
    if (err instanceof ProviderCallError && err.cost) {
      ledger(err.cost.usd, err.cost.units, err.cost.estimated ?? false, {
        error: maskSecrets(err.message).slice(0, 200),
      });
    }
    throw err;
  }
  const value = stripLinkedIn(response.value);

  // 5. Ledger
  ledger(response.usd, response.units, response.estimated ?? false, response.meta);

  // 6. Provenance
  if (opts.target && response.provenance?.length) {
    const fetchedAt = ctx.now();
    for (const p of response.provenance) {
      db.insert(fieldSources)
        .values({
          id: newId('fs'),
          workspaceId,
          entity: opts.target.entity,
          entityId: opts.target.entityId,
          field: p.field,
          source: adapter.provider,
          url: p.url ?? null,
          fetchedAt,
          confidence: p.confidence,
        })
        .run();
    }
  }

  if (adapter.cacheTtlMs > 0 && (opts.accept ? opts.accept(value) : true)) {
    const fetchedAt = ctx.now();
    db.insert(providerCache)
      .values({
        workspaceId,
        key,
        provider: adapter.provider,
        operation: adapter.operation,
        result: value,
        fetchedAt,
        expiresAt: fetchedAt + adapter.cacheTtlMs,
      })
      .onConflictDoUpdate({
        target: [providerCache.workspaceId, providerCache.key],
        set: { result: value, fetchedAt, expiresAt: fetchedAt + adapter.cacheTtlMs },
      })
      .run();
  }

  return {
    status: 'ok',
    value,
    cached: false,
    usd: free ? 0 : response.usd,
    confident: response.confident,
  };
}

function bumpQuota(ctx: AppContext, workspaceId: string, provider: string, period: string): void {
  ctx.db
    .insert(quotaUsage)
    .values({ workspaceId, provider, period, used: 1 })
    .onConflictDoUpdate({
      target: [quotaUsage.workspaceId, quotaUsage.provider, quotaUsage.period],
      set: { used: sql`${quotaUsage.used} + 1` },
    })
    .run();
}

export type WaterfallResult<O> =
  | { status: 'ok'; value: O; provider: string; confident: boolean; tried: string[] }
  | { status: 'suppressed'; reason: string }
  | { status: 'none'; tried: string[] };

/**
 * Runs adapters in order (cheapest first) and stops at the first confident result
 * (SPEC §4.3). Steps without a key are skipped. A suppressed subject stops the whole
 * waterfall. `BudgetExceededError` propagates so the job waits. If nothing is confident,
 * the first non-confident result is returned.
 */
export async function runWaterfall<I, O>(
  ctx: AppContext,
  steps: ProviderAdapter<I, O>[],
  input: I,
  opts: CallOptions<O>,
  isUsable: (value: O) => boolean = () => true,
): Promise<WaterfallResult<O>> {
  const tried: string[] = [];
  let fallback: { value: O; provider: string } | null = null;
  for (const step of steps) {
    let res: CallResult<O>;
    try {
      res = await callProvider(ctx, step, input, opts);
    } catch (err) {
      if (err instanceof ProviderKeyMissingError) continue;
      if (err instanceof ProviderCallError && err.retryable === false) {
        tried.push(step.provider);
        continue;
      }
      throw err;
    }
    tried.push(step.provider);
    if (res.status === 'suppressed') return res;
    if (!isUsable(res.value)) continue;
    if (res.confident)
      return { status: 'ok', value: res.value, provider: step.provider, confident: true, tried };
    fallback ??= { value: res.value, provider: step.provider };
  }
  return fallback
    ? { status: 'ok', ...fallback, confident: false, tried }
    : { status: 'none', tried };
}
