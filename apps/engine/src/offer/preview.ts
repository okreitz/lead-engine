/**
 * Offer profile helpers for the review screen (docs/ui.md §3.7): the live ICP match preview
 * and the cost estimate shown before a draft runs.
 */
import { DEFAULT_FIT_THRESHOLD, needsCostConfirm } from '@le/shared';
import { and, eq, ne } from 'drizzle-orm';
import type { AppContext } from '../api/context.ts';
import { domainNotSuppressed } from '../crm/filters.ts';
import { fitScore, type Icp } from '../crm/scoring.ts';
import type { Tx } from '../db/client.ts';
import { accounts, companies, workspaces } from '../db/schema.ts';
import { llmAdapterFor } from '../llm/index.ts';
import { estimateCallUsd } from '../llm/pricing.ts';
import { UNTRUSTED_RULES } from '../llm/prompt.ts';
import { budgetStatus } from '../providers/budget.ts';
import { MAX_KEY_PAGES, OFFER_SYSTEM, PAGE_CHARS } from './draft.ts';

export interface PreviewIcp {
  industries: string[];
  naics: string[];
  employeeRange: string;
  states: string[];
  techUses: string[];
  techAvoids: string[];
  exclude: string[];
}

/**
 * Counts the workspace's companies (its accounts, suppressed domains excluded) whose rule-based
 * fit under `icp` reaches the fit threshold. Only the workspace's own companies are read, so
 * the preview never reveals another workspace's records.
 */
export function previewMatches(tx: Tx, workspaceId: string, icp: PreviewIcp) {
  const ws = tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  const threshold = ws?.settings.fitThreshold ?? DEFAULT_FIT_THRESHOLD;
  const full: Icp = {
    ...icp,
    states: icp.states.map((s) => s.toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s)),
    revenueRange: null,
    mustHave: [],
  };
  const rows = tx
    .select({
      name: companies.name,
      industry: companies.industry,
      naics: companies.naics,
      sizeRange: companies.sizeRange,
      state: companies.state,
      tech: companies.tech,
    })
    .from(accounts)
    .innerJoin(companies, eq(companies.id, accounts.companyId))
    .where(
      and(
        eq(accounts.workspaceId, workspaceId),
        ne(accounts.status, 'archived'),
        domainNotSuppressed(workspaceId, companies.domain),
      ),
    )
    .all();
  const matched = rows
    .map((c) => ({ c, fit: fitScore(c, full).score }))
    .filter((r) => r.fit >= threshold)
    .sort((a, b) => b.fit - a.fit);
  const byState = new Map<string, number>();
  for (const { c } of matched) {
    const k = c.state?.toUpperCase() ?? 'Unknown';
    byState.set(k, (byState.get(k) ?? 0) + 1);
  }
  return {
    scanned: rows.length,
    matches: matched.length,
    threshold,
    byState: [...byState.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([state, count]) => ({ state, count })),
    sample: matched.slice(0, 5).map((r) => r.c.name),
  };
}

/** Upper bound for one offer draft: the system prompt plus every page at its size cap. */
export function draftEstimate(ctx: AppContext, workspaceId: string) {
  const adapter = llmAdapterFor(ctx, workspaceId);
  const ws = ctx.db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  const model = ws?.settings.llmModel ?? adapter.defaultModel;
  const promptChars = (MAX_KEY_PAGES + 1) * PAGE_CHARS + 6_000;
  const usd = estimateCallUsd(
    model,
    `${OFFER_SYSTEM}\n\n${UNTRUSTED_RULES}`,
    'x'.repeat(promptChars),
    6_000,
  );
  const budget = budgetStatus(ctx.db, workspaceId, ctx.now());
  return {
    usd: Number(usd.toFixed(4)),
    provider: adapter.name,
    model,
    remainingUsd: budget.remainingUsd,
    confirm: needsCostConfirm(usd, budget.remainingUsd),
  };
}
