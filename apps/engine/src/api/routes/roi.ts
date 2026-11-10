import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Tx } from '../../db/client.ts';
import {
  accounts,
  companies,
  contacts,
  costLedger,
  offers,
  offerVersions,
  workspaces,
} from '../../db/schema.ts';
import {
  budgetStatus,
  DEFAULT_SUB_CAPS,
  LLM_PROVIDERS,
  monthStart,
  nextMonthStart,
  spentSince,
} from '../../providers/budget.ts';
import type { AppContext } from '../context.ts';
import { parse, workspaceOf } from '../http.ts';
import { roi } from './summary.ts';

const DAY = 86_400_000;

/** Linear month-end forecast; at least one day counts as elapsed so day one doesn't explode. */
export function forecast(spentUsd: number, now: number): number {
  const start = monthStart(now);
  const length = nextMonthStart(now) - start;
  const elapsed = Math.max(DAY, now - start);
  return elapsed >= length ? spentUsd : (spentUsd * length) / elapsed;
}

const SUB_CAP_KEYS = ['personas', 'conversations', 'visits', 'llm'] as const;

/** Spend per stream against its sub-cap (docs/ui.md §3.8). LLM spend also counts in its stream. */
export function streamBudgets(tx: Tx, workspaceId: string, now: number) {
  const ws = tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get()!;
  const caps = { ...DEFAULT_SUB_CAPS, ...ws.settings.subCaps };
  const since = monthStart(now);
  return SUB_CAP_KEYS.map((key) => {
    const spentUsd =
      key === 'llm'
        ? spentSince(tx, workspaceId, since, { providers: LLM_PROVIDERS })
        : spentSince(tx, workspaceId, since, { stream: key });
    return {
      key,
      spentUsd,
      forecastUsd: forecast(spentUsd, now),
      capShare: caps[key],
      capUsd: caps[key] * ws.monthlyBudgetUsd,
      enforced: Boolean(ws.settings.enforceSubCaps),
    };
  });
}

export type LedgerCharge = 'paid' | 'free_quota' | 'not_charged';

/** Labels a ledger row: misses and cache-free calls never read as charges (docs/ui.md §1.3). */
export function chargeOf(row: { usd: number; free: boolean }): LedgerCharge {
  if (row.free) return 'free_quota';
  return row.usd > 0 ? 'paid' : 'not_charged';
}

/** Resolves ledger entity links to a label and a page in this workspace. */
function entityLinks(
  tx: Tx,
  workspaceId: string,
  rows: { entityType: string | null; entityId: string | null }[],
) {
  const ids = (type: string) => [
    ...new Set(rows.filter((r) => r.entityType === type && r.entityId).map((r) => r.entityId!)),
  ];
  const out = new Map<string, { label: string; href: string | null }>();
  const acc = ids('account');
  if (acc.length)
    for (const r of tx
      .select({ id: accounts.id, name: companies.name })
      .from(accounts)
      .innerJoin(companies, eq(companies.id, accounts.companyId))
      .where(and(eq(accounts.workspaceId, workspaceId), inArray(accounts.id, acc)))
      .all())
      out.set(`account:${r.id}`, { label: r.name, href: `/accounts/${r.id}` });
  const comp = ids('company');
  if (comp.length)
    for (const r of tx
      .select({ companyId: companies.id, name: companies.name, accountId: accounts.id })
      .from(companies)
      .leftJoin(
        accounts,
        and(eq(accounts.companyId, companies.id), eq(accounts.workspaceId, workspaceId)),
      )
      .where(inArray(companies.id, comp))
      .all())
      out.set(`company:${r.companyId}`, {
        label: r.name,
        href: r.accountId ? `/accounts/${r.accountId}` : null,
      });
  const con = ids('contact');
  if (con.length)
    for (const r of tx
      .select({ id: contacts.id, name: contacts.fullName, accountId: contacts.accountId })
      .from(contacts)
      .where(and(eq(contacts.workspaceId, workspaceId), inArray(contacts.id, con)))
      .all())
      out.set(`contact:${r.id}`, {
        label: r.name,
        href: r.accountId ? `/accounts/${r.accountId}` : null,
      });
  const ofv = ids('offer_version');
  if (ofv.length)
    for (const r of tx
      .select({
        id: offerVersions.id,
        version: offerVersions.version,
        offerId: offers.id,
        name: offers.name,
        url: offers.websiteUrl,
      })
      .from(offerVersions)
      .innerJoin(offers, eq(offers.id, offerVersions.offerId))
      .where(and(eq(offerVersions.workspaceId, workspaceId), inArray(offerVersions.id, ofv)))
      .all())
      out.set(`offer_version:${r.id}`, {
        label: `Offer ${r.name || r.url} v${r.version}`,
        href: `/offer/${r.offerId}`,
      });
  return out;
}

export function registerRoiRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** ROI for the current month: budget with forecast, stream sub-caps and per-stream results. */
  app.get('/api/v1/roi', async (request) => {
    const { workspaceId } = workspaceOf(request);
    const now = ctx.now();
    const budget = budgetStatus(ctx.db, workspaceId, now);
    return {
      monthStart: budget.monthStart,
      budget: {
        budgetUsd: budget.budgetUsd,
        spentUsd: budget.spentUsd,
        remainingUsd: budget.remainingUsd,
        state: budget.state,
        forecastUsd: forecast(budget.spentUsd, now),
      },
      streams: streamBudgets(ctx.db, workspaceId, now),
      llmUsd: spentSince(ctx.db, workspaceId, budget.monthStart, { providers: LLM_PROVIDERS }),
      roi: roi(ctx.db, workspaceId, now),
    };
  });

  /** Every metered call, newest first, linked to the record it was for (docs/ui.md §3.8). */
  app.get('/api/v1/ledger', async (request) => {
    const { workspaceId } = workspaceOf(request);
    const q = parse(
      z.object({
        provider: z.string().max(64).optional(),
        stream: z.string().max(32).optional(),
        before: z.coerce.number().int().optional(),
        since: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      request.query,
    );
    const where = and(
      eq(costLedger.workspaceId, workspaceId),
      q.provider ? eq(costLedger.provider, q.provider) : undefined,
      q.stream ? eq(costLedger.stream, q.stream) : undefined,
      q.before !== undefined ? lt(costLedger.at, q.before) : undefined,
      q.since !== undefined ? gte(costLedger.at, q.since) : undefined,
    );
    const rows = ctx.db
      .select()
      .from(costLedger)
      .where(where)
      .orderBy(desc(costLedger.at), desc(costLedger.id))
      .limit(q.limit)
      .all();
    const links = entityLinks(ctx.db, workspaceId, rows);
    const providers = ctx.db
      .selectDistinct({ provider: costLedger.provider })
      .from(costLedger)
      .where(eq(costLedger.workspaceId, workspaceId))
      .all()
      .map((r) => r.provider)
      .sort();
    const totals = ctx.db
      .select({
        usd: sql<number>`coalesce(sum(${costLedger.usd}), 0)`,
        calls: sql<number>`count(*)`,
      })
      .from(costLedger)
      .where(where)
      .get();
    return {
      providers,
      totals: totals ?? { usd: 0, calls: 0 },
      rows: rows.map((r) => ({
        id: r.id,
        at: r.at,
        provider: r.provider,
        operation: r.operation,
        stream: r.stream,
        units: r.units,
        usd: r.usd,
        estimated: r.estimated,
        charge: chargeOf(r),
        jobId: r.jobId,
        entity:
          r.entityType && r.entityId
            ? {
                type: r.entityType,
                id: r.entityId,
                ...(links.get(`${r.entityType}:${r.entityId}`) ?? {
                  label: r.entityId,
                  href: null,
                }),
              }
            : null,
      })),
    };
  });
}
