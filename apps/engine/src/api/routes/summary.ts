import { DEFAULT_FIT_THRESHOLD, QUALIFIED_STAGE_INDEX } from '@le/shared';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { domainNotSuppressed } from '../../crm/filters.ts';
import { listAccounts } from '../../crm/accounts.ts';
import type { Tx } from '../../db/client.ts';
import { accounts, activities, companies, costLedger, deals, signals } from '../../db/schema.ts';
import { budgetStatus, monthStart } from '../../providers/budget.ts';
import { stagesOf, getWorkspace } from '../../workspaces.ts';
import type { AppContext } from '../context.ts';
import { workspaceOf } from '../http.ts';

/** Monday 00:00 UTC of the current week. */
export function weekStart(now: number): number {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

const STREAMS = ['personas', 'visits', 'conversations', 'manual'] as const;

/**
 * Per-stream ROI for the current month (SPEC §8.3), attributed by `Account.firstSource`:
 * spend, accounts created, qualified (fit ≥ threshold and stage ≥ Contacted), replies,
 * meetings, deals won and their value, cost per qualified account and per meeting.
 */
export function roi(tx: Tx, workspaceId: string, now: number) {
  const ws = getWorkspace(tx, workspaceId);
  const stages = stagesOf(ws.settings);
  const threshold = ws.settings.fitThreshold ?? DEFAULT_FIT_THRESHOLD;
  const qualifiedStages = stages.slice(QUALIFIED_STAGE_INDEX).filter((s) => s !== 'Lost');
  const since = monthStart(now);
  const visible = domainNotSuppressed(workspaceId, companies.domain);
  const base = and(eq(accounts.workspaceId, workspaceId), visible);

  const spend = tx
    .select({ stream: costLedger.stream, usd: sql<number>`sum(${costLedger.usd})` })
    .from(costLedger)
    .where(and(eq(costLedger.workspaceId, workspaceId), gte(costLedger.at, since)))
    .groupBy(costLedger.stream)
    .all();
  const created = tx
    .select({ stream: accounts.firstSource, n: sql<number>`count(*)` })
    .from(accounts)
    .innerJoin(companies, eq(companies.id, accounts.companyId))
    .where(and(base, gte(accounts.createdAt, since)))
    .groupBy(accounts.firstSource)
    .all();
  const qualified = tx
    .select({ stream: accounts.firstSource, n: sql<number>`count(*)` })
    .from(accounts)
    .innerJoin(companies, eq(companies.id, accounts.companyId))
    .where(
      and(
        base,
        gte(accounts.fitScore, threshold),
        qualifiedStages.length ? inArray(accounts.stage, qualifiedStages) : sql`0`,
      ),
    )
    .groupBy(accounts.firstSource)
    .all();
  const acts = (kind: 'reply' | 'meeting') =>
    tx
      .select({ stream: accounts.firstSource, n: sql<number>`count(*)` })
      .from(activities)
      .innerJoin(accounts, eq(accounts.id, activities.accountId))
      .innerJoin(companies, eq(companies.id, accounts.companyId))
      .where(and(base, eq(activities.kind, kind), gte(activities.at, since)))
      .groupBy(accounts.firstSource)
      .all();
  const replies = acts('reply');
  const meetings = acts('meeting');
  const won = tx
    .select({
      stream: accounts.firstSource,
      n: sql<number>`count(*)`,
      usd: sql<number>`coalesce(sum(${deals.valueUsd}), 0)`,
    })
    .from(deals)
    .innerJoin(accounts, eq(accounts.id, deals.accountId))
    .innerJoin(companies, eq(companies.id, accounts.companyId))
    .where(and(base, eq(deals.outcome, 'won'), gte(deals.closedAt, since)))
    .groupBy(accounts.firstSource)
    .all();

  const pick = (rows: { stream: string; n: number }[], s: string) =>
    rows.find((r) => r.stream === s)?.n ?? 0;
  return STREAMS.map((stream) => {
    const usd = spend.find((r) => r.stream === stream)?.usd ?? 0;
    const q = pick(qualified, stream);
    const m = pick(meetings, stream);
    return {
      stream,
      spendUsd: usd,
      accounts: pick(created, stream),
      qualified: q,
      replies: pick(replies, stream),
      meetings: m,
      dealsWon: pick(won, stream),
      wonValueUsd: won.find((r) => r.stream === stream)?.usd ?? 0,
      costPerQualifiedUsd: q ? usd / q : null,
      costPerMeetingUsd: m ? usd / m : null,
    };
  });
}

export function summary(tx: Tx, workspaceId: string, now: number) {
  const ws = getWorkspace(tx, workspaceId);
  const since = weekStart(now);
  const visible = domainNotSuppressed(workspaceId, companies.domain);
  const newAccounts =
    tx
      .select({ n: sql<number>`count(*)` })
      .from(accounts)
      .innerJoin(companies, eq(companies.id, accounts.companyId))
      .where(and(eq(accounts.workspaceId, workspaceId), gte(accounts.createdAt, since), visible))
      .get()?.n ?? 0;
  // Threads arrive with stream 2 (Phase 4); they are counted from conversation signals.
  const newThreads =
    tx
      .select({ n: sql<number>`count(*)` })
      .from(signals)
      .where(
        and(
          eq(signals.workspaceId, workspaceId),
          eq(signals.stream, 'conversations'),
          eq(signals.kind, 'thread'),
          gte(signals.occurredAt, since),
        ),
      )
      .get()?.n ?? 0;
  const budget = budgetStatus(tx, workspaceId, now);
  const top = listAccounts(tx, workspaceId, { sort: 'priority', limit: 10 });
  const reasons = new Map(
    top.length
      ? tx
          .select({ id: accounts.id, scoreReasons: accounts.scoreReasons })
          .from(accounts)
          .where(
            inArray(
              accounts.id,
              top.map((a) => a.id),
            ),
          )
          .all()
          .map((r) => [r.id, r.scoreReasons])
      : [],
  );
  return {
    workspace: { id: ws.id, name: ws.name },
    generatedAt: now,
    weekStart: since,
    newAccountsThisWeek: newAccounts,
    newThreadsThisWeek: newThreads,
    top: top.map((a) => ({
      id: a.id,
      name: a.name,
      domain: a.domain,
      stage: a.stage,
      priority: a.priority,
      fitScore: a.fitScore,
      intentScore: a.intentScore,
      reasons: [...(reasons.get(a.id)?.fit ?? []), ...(reasons.get(a.id)?.intent ?? [])].slice(
        0,
        3,
      ),
    })),
    spend: {
      monthStart: budget.monthStart,
      budgetUsd: budget.budgetUsd,
      spentUsd: budget.spentUsd,
      state: budget.state,
    },
    roi: roi(tx, workspaceId, now),
  };
}

export function registerSummaryRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Ground Control's Leads card reads this with a read-only token (SPEC §7). */
  app.get('/api/v1/summary', { config: { token: 'read' } }, async (request) => {
    const { workspaceId } = workspaceOf(request);
    return summary(ctx.db, workspaceId, ctx.now());
  });
}
