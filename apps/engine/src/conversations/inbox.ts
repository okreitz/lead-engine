/**
 * The Conversations inbox (SPEC §5.3, §6; docs/ui.md §3.5): lists, actions and "Create account".
 * Replies are copied and posted by a person; the app never posts or DMs.
 */
import {
  INBOX_MIN_INTENT,
  THREAD_SIGNAL_WEIGHTS,
  THREAD_SOURCE_KEY,
  THREAD_SOURCE_LABELS,
  THREAD_SOURCE_SCHEDULE,
  THREAD_SOURCES,
  type InboxTab,
  type ThreadSource,
  type ThreadUpdate,
} from '@le/shared';
import { and, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { AppContext } from '../api/context.ts';
import { CrmError, createAccountForCompany } from '../crm/accounts.ts';
import { rescoreAccount } from '../crm/scoring.ts';
import type { Tx } from '../db/client.ts';
import { companies, providerKeys, signals, threads, type CompanyMention } from '../db/schema.ts';
import { newId } from '../ids.ts';
import { findSuppression, normalizeDomain } from '../suppression.ts';
import { nameKey } from '../universe/keys.ts';
import { conversationSettings, sourceRow } from './poll.ts';
import type { BlueskyStatus } from './sources/bluesky.ts';

const DAY = 86_400_000;
export type ThreadRow = typeof threads.$inferSelect;

function tabWhere(tab: InboxTab, now: number): SQL {
  const inbox = and(eq(threads.scoreStatus, 'scored'), gte(threads.intent, INBOX_MIN_INTENT))!;
  switch (tab) {
    case 'priority':
      return and(
        inbox,
        eq(threads.state, 'new'),
        eq(threads.selfPromo, false),
        or(isNull(threads.snoozedUntil), lte(threads.snoozedUntil, now)),
      )!;
    case 'all':
      return and(inbox, inArray(threads.state, ['new', 'replied', 'converted']))!;
    case 'replied':
      return inArray(threads.state, ['replied', 'converted']);
    case 'dismissed':
      return eq(threads.state, 'dismissed');
  }
}

export interface InboxQuery {
  tab: InboxTab;
  source?: ThreadSource[] | undefined;
  minIntent?: number | undefined;
  limit?: number;
}

export function inboxCounts(tx: Tx, workspaceId: string, now: number): Record<InboxTab, number> {
  const count = (tab: InboxTab) =>
    tx
      .select({ n: sql<number>`count(*)` })
      .from(threads)
      .where(and(eq(threads.workspaceId, workspaceId), tabWhere(tab, now)))
      .get()?.n ?? 0;
  return {
    priority: count('priority'),
    all: count('all'),
    replied: count('replied'),
    dismissed: count('dismissed'),
  };
}

export function listInbox(tx: Tx, workspaceId: string, q: InboxQuery, now: number) {
  const conds: SQL[] = [eq(threads.workspaceId, workspaceId), tabWhere(q.tab, now)];
  if (q.source?.length) conds.push(inArray(threads.source, q.source));
  if (q.minIntent !== undefined) conds.push(gte(threads.intent, q.minIntent));
  const rows = tx
    .select()
    .from(threads)
    .where(and(...conds))
    .orderBy(...(q.tab === 'priority' ? [desc(threads.intent)] : []), desc(threads.postedAt))
    .limit(q.limit ?? 200)
    .all();
  return rows.map((t) => threadView(tx, t, now));
}

/** Resolves a mention to an existing US company: by domain, else one unique name match. */
export function resolveMention(tx: Tx, mention: CompanyMention | null) {
  if (!mention) return null;
  if (mention.domain) {
    const byDomain = tx
      .select()
      .from(companies)
      .where(eq(companies.domain, normalizeDomain(mention.domain)))
      .get();
    if (byDomain) return byDomain;
  }
  const key = nameKey(mention.name);
  if (!key) return null;
  const byName = tx.select().from(companies).where(eq(companies.nameKey, key)).limit(2).all();
  return byName.length === 1 ? byName[0]! : null;
}

/**
 * SPEC §5.3: an account is created only when the poster named their company and it resolves to
 * a US `Company`. Returns whether "Create account" is allowed and why not.
 */
export function accountEligibility(
  tx: Tx,
  t: ThreadRow,
): {
  allowed: boolean;
  reason: string | null;
  company: { id: string; name: string; domain: string } | null;
} {
  if (t.accountId) return { allowed: false, reason: 'account already created', company: null };
  if (!t.companyMentioned)
    return { allowed: false, reason: 'the poster did not name their company', company: null };
  const c = resolveMention(tx, t.companyMentioned);
  if (!c)
    return {
      allowed: false,
      reason: `"${t.companyMentioned.name}" is not in the US company data`,
      company: null,
    };
  const company = { id: c.id, name: c.name, domain: c.domain };
  if (c.country !== 'US') return { allowed: false, reason: 'the company is not US-based', company };
  if (findSuppression(tx, t.workspaceId, { domains: [c.domain] }))
    return { allowed: false, reason: `${c.domain} is suppressed`, company };
  return { allowed: true, reason: null, company };
}

export function threadView(tx: Tx, t: ThreadRow, now: number) {
  const eligibility = accountEligibility(tx, t);
  return {
    id: t.id,
    source: t.source,
    sourceLabel: THREAD_SOURCE_LABELS[t.source].label,
    url: t.url,
    title: t.title,
    excerpt: t.excerpt,
    author: t.author,
    postedAt: t.postedAt,
    matchedPhrase: t.matchedPhrase,
    phraseKind: t.phraseKind,
    scoreStatus: t.scoreStatus,
    intent: t.intent,
    label: t.label,
    pain: t.pain,
    stage: t.stage,
    persona: t.persona,
    reason: t.scoreReason,
    suggestedReply: t.suggestedReply,
    replyDraft: t.replyDraft,
    companyMentioned: t.companyMentioned,
    selfPromo: t.selfPromo,
    state: t.state,
    feedback: t.feedback,
    snoozed: t.snoozedUntil !== null && t.snoozedUntil > now,
    snoozedUntil: t.snoozedUntil,
    accountId: t.accountId,
    meta: t.meta,
    expiresAt: t.expiresAt,
    canCreateAccount: eligibility.allowed,
    createAccountReason: eligibility.reason,
    company: eligibility.company,
  };
}

export function requireThread(tx: Tx, workspaceId: string, id: string): ThreadRow {
  const t = tx
    .select()
    .from(threads)
    .where(and(eq(threads.id, id), eq(threads.workspaceId, workspaceId)))
    .get();
  if (!t) throw new CrmError('not_found', 'thread not found', 404);
  return t;
}

/** Replied / dismissed / feedback / snooze / draft. Feedback feeds later scoring. */
export function updateThread(tx: Tx, t: ThreadRow, u: ThreadUpdate, now: number): ThreadRow {
  const set: Partial<ThreadRow> = { updatedAt: now };
  if (u.state !== undefined && t.state !== 'converted') set.state = u.state;
  if (u.feedback !== undefined) {
    set.feedback = u.feedback;
    set.feedbackAt = u.feedback ? now : null;
  }
  // X = "not relevant": dismiss and record the feedback in one step.
  if (u.state === 'dismissed' && u.feedback === undefined && !t.feedback) {
    set.feedback = 'not_relevant';
    set.feedbackAt = now;
  }
  // Replying to a thread means it was relevant, unless someone said otherwise.
  if (u.state === 'replied' && u.feedback === undefined && !t.feedback) {
    set.feedback = 'good';
    set.feedbackAt = now;
  }
  if (u.snoozeDays !== undefined) set.snoozedUntil = u.snoozeDays ? now + u.snoozeDays * DAY : null;
  if (u.replyDraft !== undefined) set.replyDraft = u.replyDraft;
  tx.update(threads).set(set).where(eq(threads.id, t.id)).run();
  return tx.select().from(threads).where(eq(threads.id, t.id)).get()!;
}

/** "Create account" (`A`): only for a named, resolvable US company. Adds a thread signal. */
export function createAccountFromThread(tx: Tx, t: ThreadRow, now: number) {
  const e = accountEligibility(tx, t);
  if (!e.allowed || !e.company) throw new CrmError('not_allowed', e.reason ?? 'not allowed', 409);
  const acc = createAccountForCompany(tx, t.workspaceId, e.company.id, 'conversations', now);
  tx.insert(signals)
    .values({
      id: newId('sig'),
      workspaceId: t.workspaceId,
      accountId: acc.id,
      stream: 'conversations',
      kind: 'thread',
      weight: THREAD_SIGNAL_WEIGHTS[t.intent ?? 2] ?? THREAD_SIGNAL_WEIGHTS[2]!,
      occurredAt: t.postedAt,
      payload: {
        threadId: t.id,
        source: t.source,
        title: t.title,
        intent: t.intent,
        label: t.label,
        phrase: t.matchedPhrase,
      },
      evidenceUrl: t.url,
      expiresAt: t.postedAt + 90 * DAY,
    })
    .run();
  tx.update(threads)
    .set({
      accountId: acc.id,
      state: 'converted',
      updatedAt: now,
      feedback: t.feedback ?? 'good',
      feedbackAt: t.feedbackAt ?? now,
    })
    .where(eq(threads.id, t.id))
    .run();
  rescoreAccount(tx, t.workspaceId, acc.id, now);
  return { accountId: acc.id, created: acc.created, company: e.company };
}

/** Source status for the inbox header and Settings: schedule, key, last run, errors. */
export function sourcesStatus(ctx: AppContext, workspaceId: string, bluesky: BlueskyStatus | null) {
  const now = ctx.now();
  const keys = new Set(
    ctx.db
      .select({ provider: providerKeys.provider })
      .from(providerKeys)
      .where(eq(providerKeys.workspaceId, workspaceId))
      .all()
      .map((r) => r.provider),
  );
  const sources = THREAD_SOURCES.map((source) => {
    const row = sourceRow(ctx.db, workspaceId, source, now);
    const key = THREAD_SOURCE_KEY[source];
    return {
      source,
      label: THREAD_SOURCE_LABELS[source].label,
      schedule: THREAD_SOURCE_SCHEDULE[source].text,
      enabled: row.enabled,
      key,
      keyConfigured: key ? keys.has(key) : null,
      lastRunAt: row.lastRunAt,
      nextRunAt: row.nextRunAt,
      lastStatus: row.lastStatus,
      lastError: row.lastError,
      lastFound: row.lastFound,
      lastNew: row.lastNew,
      ...(source === 'bluesky' ? { live: bluesky } : {}),
    };
  });
  return { sources, settings: conversationSettings(ctx.db, workspaceId) };
}

export { CrmError };
