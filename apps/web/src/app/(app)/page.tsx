'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BudgetMeter } from '@/components/blocks/budget-meter';
import { EmptyState, SkeletonRows } from '@/components/blocks/empty-state';
import { ScoreCell } from '@/components/blocks/score';
import { api } from '@/lib/api';
import { useSheet } from '@/lib/sheet';
import { cn } from '@/lib/utils';

interface Today {
  now: number;
  signalWindowDays: number;
  topSignals: {
    id: string;
    name: string;
    domain: string;
    stage: string;
    priority: number;
    fitScore: number | null;
    intentScore: number;
    scoreReasons: { fit: string[]; intent: string[] } | null;
    lastSignalAt: number;
    signals: { kind: string; stream: string; count: number }[];
  }[];
  nextStepsDue: {
    id: string;
    text: string;
    dueAt: number | null;
    accountId: string;
    account: string;
    overdue: boolean;
  }[];
  budget: { budgetUsd: number; spentUsd: number; state: string };
  offer: { offerId: string; version: number; approvedAt: number } | null;
  accountCount: number;
}

function ago(ms: number, now: number): string {
  const h = (now - ms) / 3_600_000;
  return h < 24 ? `${Math.max(1, Math.floor(h))}h ago` : `${Math.floor(h / 24)}d ago`;
}

/**
 * Today (docs/ui.md §3.1): the landing page. New signals on top accounts, the inbox and next
 * steps due, and the budget. A short work list, no charts.
 */
export default function TodayPage() {
  const qc = useQueryClient();
  const sheet = useSheet();
  const q = useQuery({ queryKey: ['today'], queryFn: () => api<Today>('/today') });
  const done = useMutation({
    mutationFn: (id: string) => api(`/next-steps/${id}`, { method: 'PATCH', body: { done: true } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['today'] }),
  });
  const t = q.data;
  const date = t
    ? new Date(t.now).toLocaleDateString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      })
    : '';

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Today · {date}</h1>
        {t ? (
          <BudgetMeter spentUsd={t.budget.spentUsd} budgetUsd={t.budget.budgetUsd} label="Budget" />
        ) : null}
      </div>

      {!t ? (
        <SkeletonRows rows={6} />
      ) : (
        <>
          {!t.offer ? (
            <EmptyState
              title="No approved offer profile yet"
              next="Draft and approve your offer profile"
              href="/offer"
            >
              Fit scores and streams 2 and 3 start once an offer profile version is approved.
            </EmptyState>
          ) : null}

          <section aria-labelledby="sig-h" className="rounded-xl border">
            <h2 id="sig-h" className="border-b px-4 py-2 text-sm font-semibold">
              New signals on top accounts{' '}
              <span className="text-muted-foreground font-normal">
                · last {t.signalWindowDays} days
              </span>
            </h2>
            {t.topSignals.length ? (
              <ul>
                {t.topSignals.map((a) => (
                  <li
                    key={a.id}
                    className="hover:bg-muted/40 flex flex-wrap items-center gap-3 border-b px-4 py-2 last:border-0"
                  >
                    <ScoreCell score={a} chips={false} />
                    <button
                      type="button"
                      className="font-medium hover:underline"
                      onClick={() => sheet.open(a.id)}
                    >
                      {a.name}
                    </button>
                    <span className="text-muted-foreground text-xs">{a.domain}</span>
                    <span className="flex flex-wrap gap-1">
                      {a.signals.slice(0, 3).map((s) => (
                        <span
                          key={s.kind + s.stream}
                          className="bg-muted rounded px-1.5 py-0.5 text-[11px]"
                        >
                          {s.kind.replace(/_/g, ' ')}
                          {s.count > 1 ? ` ×${s.count}` : ''}
                        </span>
                      ))}
                    </span>
                    <span className="text-muted-foreground ml-auto text-xs">
                      {ago(a.lastSignalAt, t.now)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground px-4 py-3 text-sm">
                No new signals. They arrive from persona fit (Phase 2), website visits (Phase 3) and
                conversations (Phase 4).
                {t.accountCount === 0 ? ' Start by adding or importing accounts.' : ''}
              </p>
            )}
          </section>

          <div className="grid gap-4 md:grid-cols-2">
            <section aria-labelledby="inbox-h" className="rounded-xl border">
              <h2 id="inbox-h" className="border-b px-4 py-2 text-sm font-semibold">
                Inbox
              </h2>
              <p className="text-muted-foreground px-4 py-3 text-sm">
                Conversations from Hacker News, Bluesky, Stack Exchange, GitHub and Reddit arrive in
                Phase 4.
              </p>
            </section>
            <section aria-labelledby="ns-h" className="rounded-xl border">
              <h2 id="ns-h" className="border-b px-4 py-2 text-sm font-semibold">
                Next steps due
              </h2>
              {t.nextStepsDue.length ? (
                <ul>
                  {t.nextStepsDue.map((n) => (
                    <li
                      key={n.id}
                      className="flex items-center gap-2 border-b px-4 py-2 text-sm last:border-0"
                    >
                      <input
                        type="checkbox"
                        aria-label={`Done: ${n.text}`}
                        onChange={() => done.mutate(n.id)}
                      />
                      <button
                        type="button"
                        className="shrink-0 font-medium whitespace-nowrap hover:underline"
                        onClick={() => sheet.open(n.accountId)}
                      >
                        {n.account}
                      </button>
                      <span className="min-w-0 truncate">{n.text}</span>
                      <span
                        className={cn(
                          'ml-auto shrink-0 text-xs',
                          n.overdue ? 'font-medium text-red-700' : 'text-muted-foreground',
                        )}
                      >
                        {n.overdue
                          ? `overdue ${Math.max(1, Math.floor((t.now - (n.dueAt ?? t.now)) / 86_400_000))}d`
                          : 'today'}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground px-4 py-3 text-sm">
                  Nothing due. Add next steps on an account.
                </p>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
