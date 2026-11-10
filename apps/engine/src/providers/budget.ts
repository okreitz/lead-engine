import { BUDGET_WARNING_SHARE, type Stream } from '@le/shared';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.ts';
import { costLedger, workspaces, type WorkspaceSettings } from '../db/schema.ts';
import { BudgetExceededError } from './errors.ts';

/** Providers whose spend counts toward the optional `llm` sub-cap. */
export const LLM_PROVIDERS = ['anthropic-api', 'claude-cli'];

/** Default sub-cap shares (SPEC §8.1). Only enforced when `settings.enforceSubCaps`. */
export const DEFAULT_SUB_CAPS = { personas: 0.6, conversations: 0.2, visits: 0.1, llm: 0.1 };

/** Budget months are calendar months in UTC. */
export function monthStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function nextMonthStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export interface BudgetStatus {
  budgetUsd: number;
  spentUsd: number;
  remainingUsd: number;
  share: number;
  state: 'ok' | 'warning' | 'reached';
  monthStart: number;
  byProvider: { provider: string; usd: number; calls: number; freeCalls: number }[];
  byStream: { stream: string; usd: number }[];
}

export function spentSince(
  db: Tx,
  workspaceId: string,
  since: number,
  filter: { stream?: string; providers?: string[] } = {},
): number {
  const conds = [eq(costLedger.workspaceId, workspaceId), gte(costLedger.at, since)];
  if (filter.stream) conds.push(eq(costLedger.stream, filter.stream));
  if (filter.providers) conds.push(inArray(costLedger.provider, filter.providers));
  return (
    db
      .select({ usd: sql<number>`coalesce(sum(${costLedger.usd}), 0)` })
      .from(costLedger)
      .where(and(...conds))
      .get()?.usd ?? 0
  );
}

export function budgetStatus(db: Tx, workspaceId: string, now: number): BudgetStatus {
  const ws = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  if (!ws) throw new Error('workspace not found');
  const since = monthStart(now);
  const spent = spentSince(db, workspaceId, since);
  const budget = ws.monthlyBudgetUsd;
  const share = budget > 0 ? spent / budget : spent > 0 ? Infinity : 1;
  const where = and(eq(costLedger.workspaceId, workspaceId), gte(costLedger.at, since));
  return {
    budgetUsd: budget,
    spentUsd: spent,
    remainingUsd: Math.max(0, budget - spent),
    share: Number.isFinite(share) ? share : 1,
    state: share >= 1 ? 'reached' : share >= BUDGET_WARNING_SHARE ? 'warning' : 'ok',
    monthStart: since,
    byProvider: db
      .select({
        provider: costLedger.provider,
        usd: sql<number>`sum(${costLedger.usd})`,
        calls: sql<number>`count(*)`,
        freeCalls: sql<number>`sum(${costLedger.free})`,
      })
      .from(costLedger)
      .where(where)
      .groupBy(costLedger.provider)
      .all(),
    byStream: db
      .select({ stream: costLedger.stream, usd: sql<number>`sum(${costLedger.usd})` })
      .from(costLedger)
      .where(where)
      .groupBy(costLedger.stream)
      .all(),
  };
}

/**
 * Throws `BudgetExceededError` unless a paid call costing up to `estimateUsd` fits
 * (SPEC §8.1). Order: workspace budget, provider cap, optional stream and LLM sub-caps.
 */
export function assertBudget(
  db: Tx,
  input: {
    workspaceId: string;
    stream: Stream;
    provider: string;
    estimateUsd: number;
    maxPaidUsdPerMonth?: number | undefined;
    now: number;
  },
): void {
  const ws = db.select().from(workspaces).where(eq(workspaces.id, input.workspaceId)).get();
  if (!ws) throw new Error('workspace not found');
  const since = monthStart(input.now);
  const spent = spentSince(db, input.workspaceId, since);
  if (spent >= ws.monthlyBudgetUsd || spent + input.estimateUsd > ws.monthlyBudgetUsd) {
    throw new BudgetExceededError('budget reached');
  }
  if (input.maxPaidUsdPerMonth !== undefined) {
    const providerSpent = spentSince(db, input.workspaceId, since, { providers: [input.provider] });
    if (providerSpent + input.estimateUsd > input.maxPaidUsdPerMonth) {
      throw new BudgetExceededError(
        input.maxPaidUsdPerMonth === 0
          ? `${input.provider} free quota used up (paid calls are capped at $0)`
          : `${input.provider} monthly cap reached`,
      );
    }
  }
  const settings: WorkspaceSettings = ws.settings;
  if (settings.enforceSubCaps) {
    const caps = { ...DEFAULT_SUB_CAPS, ...settings.subCaps };
    if (LLM_PROVIDERS.includes(input.provider)) {
      const llmSpent = spentSince(db, input.workspaceId, since, { providers: LLM_PROVIDERS });
      if (llmSpent + input.estimateUsd > caps.llm * ws.monthlyBudgetUsd) {
        throw new BudgetExceededError('LLM sub-cap reached');
      }
    }
    const streamCap = input.stream === 'manual' ? undefined : caps[input.stream];
    if (streamCap !== undefined) {
      const streamSpent = spentSince(db, input.workspaceId, since, { stream: input.stream });
      if (streamSpent + input.estimateUsd > streamCap * ws.monthlyBudgetUsd) {
        throw new BudgetExceededError(`${input.stream} sub-cap reached`);
      }
    }
  }
}
