/**
 * The Today landing page (docs/ui.md §3.1) and ⌘K search. Today is a short work list:
 * top accounts with new signals, next steps due, the budget and the offer status. No charts.
 */
import { and, asc, desc, eq, gte, inArray, isNull, like, lte, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listAccounts } from '../../crm/accounts.ts';
import { domainNotSuppressed } from '../../crm/filters.ts';
import { listContacts } from '../../crm/records.ts';
import type { Tx } from '../../db/client.ts';
import { accounts, companies, nextSteps, offers, offerVersions, signals } from '../../db/schema.ts';
import { budgetStatus } from '../../providers/budget.ts';
import type { AppContext } from '../context.ts';
import { parse, workspaceOf } from '../http.ts';

const DAY = 86_400_000;
export const TODAY_SIGNAL_WINDOW_DAYS = 7;

export function today(tx: Tx, workspaceId: string, now: number) {
  const since = now - TODAY_SIGNAL_WINDOW_DAYS * DAY;
  const visible = domainNotSuppressed(workspaceId, companies.domain);

  // Accounts with signals in the window, ranked by priority.
  const recent = tx
    .select({
      accountId: signals.accountId,
      kind: signals.kind,
      stream: signals.stream,
      n: sql<number>`count(*)`,
      last: sql<number>`max(${signals.occurredAt})`,
    })
    .from(signals)
    .where(
      and(
        eq(signals.workspaceId, workspaceId),
        gte(signals.occurredAt, since),
        sql`${signals.accountId} IS NOT NULL`,
      ),
    )
    .groupBy(signals.accountId, signals.kind, signals.stream)
    .all();
  const ids = [...new Set(recent.map((r) => r.accountId!))];
  const rows = ids.length
    ? tx
        .select({
          id: accounts.id,
          name: companies.name,
          domain: companies.domain,
          stage: accounts.stage,
          priority: accounts.priority,
          fitScore: accounts.fitScore,
          intentScore: accounts.intentScore,
          scoreReasons: accounts.scoreReasons,
        })
        .from(accounts)
        .innerJoin(companies, eq(companies.id, accounts.companyId))
        .where(and(inArray(accounts.id, ids), eq(accounts.status, 'active'), visible))
        .orderBy(desc(accounts.priority))
        .limit(10)
        .all()
    : [];
  const topSignals = rows.map((a) => {
    const own = recent.filter((r) => r.accountId === a.id);
    return {
      ...a,
      lastSignalAt: Math.max(...own.map((r) => r.last)),
      signals: own
        .sort((x, y) => y.last - x.last)
        .map((r) => ({ kind: r.kind, stream: r.stream, count: r.n })),
    };
  });

  const endOfDay = Math.ceil((now + 1) / DAY) * DAY;
  const due = tx
    .select({
      id: nextSteps.id,
      text: nextSteps.text,
      dueAt: nextSteps.dueAt,
      accountId: accounts.id,
      account: companies.name,
    })
    .from(nextSteps)
    .innerJoin(accounts, eq(accounts.id, nextSteps.accountId))
    .innerJoin(companies, eq(companies.id, accounts.companyId))
    .where(
      and(
        eq(nextSteps.workspaceId, workspaceId),
        isNull(nextSteps.doneAt),
        lte(nextSteps.dueAt, endOfDay),
        visible,
      ),
    )
    .orderBy(asc(nextSteps.dueAt))
    .limit(20)
    .all();

  const approved = tx
    .select({
      offerId: offerVersions.offerId,
      version: offerVersions.version,
      approvedAt: offerVersions.approvedAt,
    })
    .from(offerVersions)
    .where(and(eq(offerVersions.workspaceId, workspaceId), eq(offerVersions.status, 'approved')))
    .orderBy(desc(offerVersions.approvedAt))
    .get();
  const accountCount =
    tx
      .select({ n: sql<number>`count(*)` })
      .from(accounts)
      .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.status, 'active')))
      .get()?.n ?? 0;

  const budget = budgetStatus(tx, workspaceId, now);
  return {
    now,
    signalWindowDays: TODAY_SIGNAL_WINDOW_DAYS,
    topSignals,
    nextStepsDue: due.map((d) => ({
      ...d,
      overdue: d.dueAt !== null && d.dueAt < now - (now % DAY),
    })),
    budget: {
      budgetUsd: budget.budgetUsd,
      spentUsd: budget.spentUsd,
      state: budget.state,
      share: budget.share,
    },
    offer: approved ?? null,
    accountCount,
    /** Conversations arrive in Phase 4. */
    inbox: null,
  };
}

export function registerTodayRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/today', async (request) => {
    const { workspaceId } = workspaceOf(request);
    return today(ctx.db, workspaceId, ctx.now());
  });

  /** ⌘K: accounts (FTS), contacts and offers. Suppressed records never appear. */
  app.get('/api/v1/search', async (request) => {
    const { workspaceId } = workspaceOf(request);
    const { q } = parse(z.object({ q: z.string().trim().min(1).max(200) }), request.query);
    const accs = listAccounts(ctx.db, workspaceId, { q, limit: 8 });
    const cons = listContacts(ctx.db, workspaceId, { q, limit: 8 });
    const offs = ctx.db
      .select({ id: offers.id, name: offers.name, websiteUrl: offers.websiteUrl })
      .from(offers)
      .where(
        and(
          eq(offers.workspaceId, workspaceId),
          or(like(offers.name, `%${q}%`), like(offers.websiteUrl, `%${q}%`)),
        ),
      )
      .limit(5)
      .all();
    return {
      accounts: accs.map((a) => ({
        id: a.id,
        name: a.name,
        domain: a.domain,
        priority: a.priority,
        stage: a.stage,
      })),
      contacts: cons.map((c) => ({
        id: c.id,
        fullName: c.fullName,
        title: c.title,
        accountId: c.accountId,
        company: c.company,
      })),
      offers: offs,
    };
  });
}
