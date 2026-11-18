'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import {
  BUYING_STAGE_TEXT,
  helpFor,
  INBOX_TABS,
  THREAD_LABEL_TEXT,
  THREAD_SOURCE_LABELS,
  THREAD_SOURCES,
  type InboxTab,
  type ThreadSource,
} from '@le/shared';
import { EmptyState, SkeletonRows } from '@/components/blocks/empty-state';
import { ExternalLink } from '@/components/blocks/key-help';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/card';
import { NativeSelect, Textarea } from '@/components/ui/input';
import { api, errorMessage, fmtDate } from '@/lib/api';
import {
  ago,
  createAccount,
  fetchInbox,
  fetchSources,
  updateThread,
  type SourceStatus,
  type Thread,
} from '@/lib/inbox';
import { useKeys } from '@/lib/keys';
import { useMe } from '@/lib/me';
import { offerLabel, useOffers } from '@/lib/offers';
import { useSheet } from '@/lib/sheet';
import { cn } from '@/lib/utils';

export default function InboxPage() {
  return (
    <Suspense fallback={null}>
      <Inbox />
    </Suspense>
  );
}

const TAB_LABELS: Record<InboxTab, string> = {
  priority: 'Priority',
  all: 'All',
  replied: 'Replied',
  dismissed: 'Dismissed',
};

/** Inbox (docs/ui.md §3.5): two panes, keyboard first. Replies are copied, never posted. */
function Inbox() {
  const qc = useQueryClient();
  const router = useRouter();
  const params = useSearchParams();
  const sheet = useSheet();
  const tab = (INBOX_TABS as readonly string[]).includes(params.get('tab') ?? '')
    ? (params.get('tab') as InboxTab)
    : 'priority';
  const source = params.get('source');
  const minIntent = params.get('intent') === '3' ? 3 : null;
  const offer = params.get('offer');
  const offers = useOffers();
  const list = useQuery({
    queryKey: ['inbox', tab, source, minIntent, offer],
    queryFn: () => fetchInbox(tab, source, minIntent, offer),
    refetchInterval: 60_000,
  });
  const sources = useQuery({ queryKey: ['conversation-sources'], queryFn: fetchSources });
  const today = useQuery({
    queryKey: ['today'],
    queryFn: () => api<{ offer: unknown }>('/today'),
  });
  const rows = list.data?.threads ?? [];
  const wanted = params.get('thread');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showSources, setShowSources] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);

  const index = Math.max(
    0,
    rows.findIndex((t) => t.id === (selectedId ?? wanted)),
  );
  const current: Thread | undefined = rows[index];

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value === null) next.delete(key);
    else next.set(key, value);
    next.delete('thread');
    router.replace(`/inbox?${next.toString()}`, { scroll: false });
  };
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['inbox'] });
    await qc.invalidateQueries({ queryKey: ['today'] });
  };
  const select = (i: number) =>
    setSelectedId(rows[Math.max(0, Math.min(rows.length - 1, i))]?.id ?? null);

  /** Acts on the current thread, then moves to the next one when it leaves the list. */
  async function act(fn: (t: Thread) => Promise<unknown>, message: (t: Thread) => string) {
    const t = current;
    if (!t) return;
    try {
      await fn(t);
      setNotice(message(t));
      setSelectedId(rows[index + 1]?.id ?? rows[index - 1]?.id ?? null);
    } catch (err) {
      setNotice(errorMessage(err));
    }
    await refresh();
  }
  const replied = () =>
    act(
      (t) => updateThread(t.id, { state: 'replied' }),
      (t) => `Marked replied: ${t.title}`,
    );
  const notRelevant = () =>
    act(
      (t) => updateThread(t.id, { state: 'dismissed', feedback: 'not_relevant' }),
      () => 'Dismissed as not relevant. Later scoring learns from it.',
    );
  const snooze = () =>
    act(
      (t) => updateThread(t.id, { snoozeDays: t.snoozed ? 0 : 3 }),
      (t) => (t.snoozed ? 'Snooze removed' : 'Snoozed for 3 days'),
    );
  const account = () => {
    if (!current?.canCreateAccount) {
      setNotice(`Can't create an account: ${current?.createAccountReason ?? 'no thread selected'}`);
      return;
    }
    void act(
      async (t) => {
        const r = await createAccount(t.id);
        sheet.open(r.accountId);
      },
      (t) => `Account created for ${t.company?.name ?? 'the company'}`,
    );
  };
  const open = () => current && window.open(current.url, '_blank', 'noopener,noreferrer');

  useKeys({
    j: () => select(index + 1),
    k: () => select(index - 1),
    o: open,
    r: () => void replied(),
    x: () => void notRelevant(),
    a: account,
    h: () => void snooze(),
  });

  if (today.data && !today.data.offer) {
    return (
      <div className="flex max-w-3xl flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
        <EmptyState
          title="Approve your offer profile first"
          next="Open the offer profile"
          href="/offer"
        >
          Its intent phrases are what the inbox searches for on Hacker News, Bluesky, Stack
          Exchange, GitHub and Reddit (via search). Threads are scored and come with a draft reply
          you copy and post yourself.
        </EmptyState>
      </div>
    );
  }

  const counts = list.data?.counts;
  const waiting = sources.data?.sources.filter(
    (s) => s.enabled && (s.lastStatus === 'waiting' || s.lastStatus === 'error'),
  );

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
        <div className="flex gap-1" role="tablist" aria-label="Tabs">
          {INBOX_TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setParam('tab', t === 'priority' ? null : t)}
              className={cn(
                'rounded px-2 py-1 text-xs',
                tab === t ? 'bg-foreground text-background' : 'bg-muted hover:bg-accent',
              )}
            >
              {TAB_LABELS[t]}
              {counts ? ` ${counts[t]}` : ''}
            </button>
          ))}
        </div>
        {offers.multiple ? (
          <NativeSelect
            aria-label="Offer"
            className="ml-auto w-44"
            value={offer ?? ''}
            onChange={(e) => setParam('offer', e.target.value || null)}
          >
            <option value="">All offers</option>
            {offers.all.map((o) => (
              <option key={o.id} value={o.id}>
                {offerLabel(o)}
              </option>
            ))}
          </NativeSelect>
        ) : null}
        <NativeSelect
          aria-label="Source"
          className={cn('w-44', !offers.multiple && 'ml-auto')}
          value={source ?? ''}
          onChange={(e) => setParam('source', e.target.value || null)}
        >
          <option value="">All sources</option>
          {THREAD_SOURCES.map((s) => (
            <option key={s} value={s}>
              {THREAD_SOURCE_LABELS[s].label}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Intent"
          className="w-36"
          value={minIntent ? '3' : ''}
          onChange={(e) => setParam('intent', e.target.value || null)}
        >
          <option value="">Intent 2–3</option>
          <option value="3">Intent 3 only</option>
        </NativeSelect>
        <Button size="sm" variant="outline" onClick={() => setShowSources((s) => !s)}>
          Sources{waiting?.length ? ` (${waiting.length} need attention)` : ''}
        </Button>
      </div>

      {showSources && sources.data ? <SourcesPanel data={sources.data.sources} /> : null}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
      {list.error ? <p className="text-destructive text-sm">{errorMessage(list.error)}</p> : null}

      <div className="flex min-h-0 flex-1 rounded-xl border">
        <ul
          className="w-[42%] min-w-72 shrink-0 overflow-y-auto border-r"
          aria-label="Threads"
          role="listbox"
        >
          {list.isLoading ? (
            <li className="p-3">
              <SkeletonRows rows={6} />
            </li>
          ) : null}
          {list.data && rows.length === 0 ? (
            <li className="text-muted-foreground p-4 text-sm">
              {tab === 'priority'
                ? 'Nothing waiting. New threads appear as the sources run (Hacker News every 15 minutes, Bluesky live).'
                : 'No threads here.'}
            </li>
          ) : null}
          {rows.map((t, i) => (
            <li
              key={t.id}
              role="option"
              aria-selected={i === index}
              onClick={() => setSelectedId(t.id)}
              className={cn(
                'flex cursor-pointer items-start gap-2 border-b px-3 py-2 text-sm',
                i === index ? 'bg-accent/70' : 'hover:bg-accent/30',
              )}
            >
              <span
                className="w-4 shrink-0 pt-0.5 text-center font-semibold tabular-nums"
                title={`Intent ${t.intent ?? '—'} of 3`}
              >
                {t.intent ?? '–'}
              </span>
              <span className="text-muted-foreground w-9 shrink-0 pt-0.5 text-[11px]">
                {THREAD_SOURCE_LABELS[t.source].short}
              </span>
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2">{t.title}</span>
                <span className="text-muted-foreground flex flex-wrap gap-1 text-[11px]">
                  {offers.multiple && offers.name(t.offerId) ? (
                    <span className="text-foreground/70 font-medium">{offers.name(t.offerId)}</span>
                  ) : null}
                  {t.label && t.label !== 'none' ? <span>{THREAD_LABEL_TEXT[t.label]}</span> : null}
                  {t.selfPromo ? <span>· self-promo</span> : null}
                  {t.snoozed ? <span>· snoozed</span> : null}
                  {t.state === 'converted' ? <span>· account created</span> : null}
                </span>
              </span>
              <span className="text-muted-foreground shrink-0 text-xs">{ago(t.postedAt)}</span>
            </li>
          ))}
        </ul>

        <div className="min-w-0 flex-1 overflow-y-auto p-4">
          {current ? (
            <ThreadDetail
              key={current.id}
              t={current}
              replyRef={replyRef}
              onReplied={() => void replied()}
              onNotRelevant={() => void notRelevant()}
              onSnooze={() => void snooze()}
              onAccount={account}
              onGood={() =>
                void act(
                  (t) => updateThread(t.id, { feedback: 'good' }),
                  () => 'Marked relevant. Later scoring learns from it.',
                )
              }
              onSaved={refresh}
            />
          ) : (
            <p className="text-muted-foreground text-sm">Select a thread.</p>
          )}
        </div>
      </div>

      <p className="text-muted-foreground text-xs">
        The thread is the lead: nobody is identified, and replies are written and posted by you.
        Keys: J/K move · O open · R replied · X not relevant · A create account · H snooze.{' '}
        <ExternalLink href="https://hn.algolia.com">
          Hacker News Search powered by Algolia
        </ExternalLink>
        . Stack Exchange content is CC BY-SA 4.0. Reddit threads are found through Google search and
        only linked.
      </p>
    </div>
  );
}

function ThreadDetail({
  t,
  replyRef,
  onReplied,
  onNotRelevant,
  onSnooze,
  onAccount,
  onGood,
  onSaved,
}: {
  t: Thread;
  replyRef: React.RefObject<HTMLTextAreaElement | null>;
  onReplied: () => void;
  onNotRelevant: () => void;
  onSnooze: () => void;
  onAccount: () => void;
  onGood: () => void;
  onSaved: () => Promise<void>;
}) {
  const offers = useOffers();
  const offerName = offers.multiple ? offers.name(t.offerId) : null;
  const [draft, setDraft] = useState(t.replyDraft ?? t.suggestedReply ?? '');
  const [copied, setCopied] = useState(false);
  const saved = t.replyDraft ?? t.suggestedReply ?? '';
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(id);
  }, [copied]);
  const save = async () => {
    if (draft === saved) return;
    await updateThread(t.id, { replyDraft: draft });
    await onSaved();
  };
  const site = typeof t.meta.site === 'string' ? t.meta.site : null;
  const repo = typeof t.meta.repo === 'string' ? t.meta.repo : null;
  const sub = typeof t.meta.subreddit === 'string' ? t.meta.subreddit : null;

  return (
    <article className="flex flex-col gap-3">
      <p className="text-muted-foreground text-xs">
        {t.sourceLabel}
        {site ? ` · ${site}` : ''}
        {repo ? ` · ${repo}` : ''}
        {sub ? ` · r/${sub}` : ''}
        {t.author && t.source !== 'bluesky' ? ` · ${t.author}` : ''} · {ago(t.postedAt)} ago ·
        matched “{t.matchedPhrase}”{offerName ? ` for ${offerName}` : ''}
      </p>
      <h2 className="text-lg font-semibold">
        <a href={t.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
          {t.title} ↗
        </a>
      </h2>
      <div className="flex flex-wrap gap-1.5">
        <Badge tone={t.intent === 3 ? 'ok' : 'default'}>Intent {t.intent ?? '—'}/3</Badge>
        {t.label && t.label !== 'none' ? <Badge>{THREAD_LABEL_TEXT[t.label]}</Badge> : null}
        {t.selfPromo ? <Badge tone="warn">Self-promotion</Badge> : null}
        {t.feedback ? (
          <Badge tone="muted">{t.feedback === 'good' ? 'Marked relevant' : 'Not relevant'}</Badge>
        ) : null}
        {t.snoozed ? <Badge tone="muted">Snoozed until {fmtDate(t.snoozedUntil)}</Badge> : null}
      </div>
      <p className="text-sm whitespace-pre-line">{t.excerpt || '(no text)'}</p>
      {t.source === 'stackexchange' ? (
        <p className="text-muted-foreground text-xs">
          From the Stack Exchange network
          {t.author ? `, asked by ${t.author}` : ''}, licensed{' '}
          {typeof t.meta.license === 'string' ? t.meta.license : 'CC BY-SA 4.0'}.
        </p>
      ) : null}
      {t.source === 'reddit' ? (
        <p className="text-muted-foreground text-xs">
          Search snippet only; read the thread on Reddit.
        </p>
      ) : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        {t.pain ? (
          <>
            <dt className="text-muted-foreground">Pain</dt>
            <dd>{t.pain}</dd>
          </>
        ) : null}
        {t.stage ? (
          <>
            <dt className="text-muted-foreground">Stage</dt>
            <dd>{BUYING_STAGE_TEXT[t.stage]}</dd>
          </>
        ) : null}
        {t.persona ? (
          <>
            <dt className="text-muted-foreground">Persona (guess)</dt>
            <dd>{t.persona}</dd>
          </>
        ) : null}
        {t.reason ? (
          <>
            <dt className="text-muted-foreground">Why</dt>
            <dd>{t.reason}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Company</dt>
        <dd>
          {t.companyMentioned
            ? `${t.companyMentioned.name}${t.company ? ` → ${t.company.domain}` : ''}`
            : 'not named by the poster'}
        </dd>
      </dl>

      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Suggested reply (draft, editable)
        <Textarea
          ref={replyRef}
          rows={6}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save()}
          className="font-normal"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={async () => {
            await navigator.clipboard.writeText(draft);
            setCopied(true);
            void save();
          }}
        >
          {copied ? 'Copied' : 'Copy reply'}
        </Button>
        <Button size="sm" variant="outline" asChild>
          <a href={t.url} target="_blank" rel="noopener noreferrer">
            Open thread ↗ <kbd className="text-[10px]">O</kbd>
          </a>
        </Button>
        <Button size="sm" variant="outline" onClick={onReplied} disabled={t.state !== 'new'}>
          Replied <kbd className="text-[10px]">R</kbd>
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onNotRelevant}
          disabled={t.state === 'dismissed'}
        >
          Not relevant <kbd className="text-[10px]">X</kbd>
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onAccount}
          disabled={!t.canCreateAccount}
          title={t.createAccountReason ?? undefined}
        >
          Create account <kbd className="text-[10px]">A</kbd>
        </Button>
        <Button size="sm" variant="ghost" onClick={onSnooze}>
          {t.snoozed ? 'Unsnooze' : 'Snooze 3 days'} <kbd className="text-[10px]">H</kbd>
        </Button>
        {t.feedback !== 'good' ? (
          <Button size="sm" variant="ghost" onClick={onGood}>
            Relevant
          </Button>
        ) : null}
      </div>
      {!t.canCreateAccount && t.createAccountReason && !t.accountId ? (
        <p className="text-muted-foreground text-xs">
          Create account: only when the poster names their company and it is a US company in your
          data ({t.createAccountReason}).
        </p>
      ) : null}
      {t.accountId ? (
        <Link href={`/accounts/${t.accountId}`} className="text-sm underline">
          Open the account
        </Link>
      ) : null}
      <p className="text-muted-foreground text-xs">
        Unactioned threads are deleted {fmtDate(t.expiresAt)} (90 days).
      </p>
    </article>
  );
}

function SourcesPanel({ data }: { data: SourceStatus[] }) {
  const qc = useQueryClient();
  const me = useMe();
  const owner = me.data?.role === 'owner';
  const toggle = async (s: ThreadSource, enabled: boolean) => {
    await api(`/conversations/sources/${s}`, { method: 'PATCH', body: { enabled } });
    await qc.invalidateQueries({ queryKey: ['conversation-sources'] });
  };
  const run = async (s: ThreadSource) => {
    await api(`/conversations/sources/${s}/run`, { method: 'POST' });
    await qc.invalidateQueries({ queryKey: ['conversation-sources'] });
  };
  return (
    <section aria-label="Sources" className="rounded-xl border text-sm">
      <table className="w-full">
        <thead className="text-muted-foreground text-left text-xs">
          <tr>
            <th className="px-3 py-2">Source</th>
            <th>Runs</th>
            <th>Last run</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.map((s) => {
            const help = s.key ? helpFor(s.key) : undefined;
            return (
              <tr key={s.source} className="border-t align-top">
                <td className="px-3 py-2 font-medium">{s.label}</td>
                <td className="py-2">{s.schedule}</td>
                <td className="py-2">
                  {s.source === 'bluesky'
                    ? s.live?.connected
                      ? `connected · ${s.live.events.toLocaleString()} posts read, ${s.live.matched} matched`
                      : 'not connected'
                    : s.lastRunAt
                      ? `${ago(s.lastRunAt)} ago · ${s.lastFound ?? 0} seen, ${s.lastNew ?? 0} new`
                      : 'not yet'}
                </td>
                <td className="py-2">
                  {!s.enabled ? (
                    <span className="text-muted-foreground">off</span>
                  ) : s.key && !s.keyConfigured ? (
                    <span className="text-amber-700">
                      needs a {help?.label ?? s.key} key ·{' '}
                      <Link href={`/settings?tab=keys#key-${s.key}`} className="underline">
                        add it
                      </Link>
                      {help ? (
                        <>
                          {' · '}
                          <ExternalLink href={help.createUrl}>create one ↗</ExternalLink>
                        </>
                      ) : null}
                    </span>
                  ) : s.lastStatus === 'error' || s.lastStatus === 'waiting' ? (
                    <span className="text-amber-700">{s.lastError}</span>
                  ) : s.source === 'bluesky' && s.live?.lastError ? (
                    <span className="text-amber-700">{s.live.lastError}</span>
                  ) : (
                    'ok'
                  )}
                </td>
                <td className="py-2 pr-3 text-right whitespace-nowrap">
                  {s.source !== 'bluesky' && s.enabled ? (
                    <Button size="xs" variant="ghost" onClick={() => void run(s.source)}>
                      Run now
                    </Button>
                  ) : null}
                  {owner ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void toggle(s.source, !s.enabled)}
                    >
                      {s.enabled ? 'Turn off' : 'Turn on'}
                    </Button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
