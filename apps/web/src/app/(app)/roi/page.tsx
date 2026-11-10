'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { BudgetMeter } from '@/components/blocks/budget-meter';
import { EmptyState, SkeletonRows } from '@/components/blocks/empty-state';
import { Card, CardTitle } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/input';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Roi {
  monthStart: number;
  budget: {
    budgetUsd: number;
    spentUsd: number;
    remainingUsd: number;
    state: 'ok' | 'warning' | 'reached';
    forecastUsd: number;
  };
  streams: {
    key: 'personas' | 'conversations' | 'visits' | 'llm';
    spentUsd: number;
    forecastUsd: number;
    capShare: number;
    capUsd: number;
    enforced: boolean;
  }[];
  llmUsd: number;
  roi: {
    stream: string;
    spendUsd: number;
    accounts: number;
    qualified: number;
    replies: number;
    meetings: number;
    costPerQualifiedUsd: number | null;
    costPerMeetingUsd: number | null;
  }[];
}

interface Ledger {
  providers: string[];
  totals: { usd: number; calls: number };
  rows: {
    id: string;
    at: number;
    provider: string;
    operation: string;
    stream: string;
    units: number;
    usd: number;
    estimated: boolean;
    charge: 'paid' | 'free_quota' | 'not_charged';
    entity: { type: string; id: string; label: string; href: string | null } | null;
  }[];
}

const money = (n: number | null) => (n == null ? '—' : `$${n.toFixed(2)}`);
/** Full stream names; the short STREAM_LABEL forms are for table cells elsewhere. */
const STREAM_NAME: Record<string, string> = {
  personas: 'Persona fit',
  visits: 'Visits',
  conversations: 'Conversations',
  manual: 'Manual',
};
const BAR_LABEL: Record<string, string> = { ...STREAM_NAME, llm: 'LLM (all streams)' };
const CHARGE_TEXT = { paid: 'charged', free_quota: 'free quota', not_charged: 'not charged' };

export default function RoiPage() {
  return (
    <Suspense fallback={<SkeletonRows rows={6} />}>
      <RoiView />
    </Suspense>
  );
}

/**
 * ROI (docs/ui.md §3.8): budget with a month-end forecast, a bar per stream against its
 * sub-cap, per-stream results with cost per qualified account and per meeting, and the ledger
 * where every call links to its record. Ledger filters live in the URL.
 */
function RoiView() {
  const params = useSearchParams();
  const router = useRouter();
  const provider = params.get('provider') ?? '';
  const stream = params.get('stream') ?? '';
  const roi = useQuery({ queryKey: ['roi'], queryFn: () => api<Roi>('/roi') });
  const ledgerQuery = new URLSearchParams({
    ...(provider ? { provider } : {}),
    ...(stream ? { stream } : {}),
    ...(roi.data ? { since: String(roi.data.monthStart) } : {}),
    limit: '200',
  }).toString();
  const ledger = useQuery({
    queryKey: ['ledger', ledgerQuery],
    queryFn: () => api<Ledger>(`/ledger?${ledgerQuery}`),
    enabled: Boolean(roi.data),
    placeholderData: (prev) => prev,
  });
  const setFilter = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    router.replace(`/roi?${next}`, { scroll: false });
  };

  if (!roi.data) return <SkeletonRows rows={6} />;
  const r = roi.data;
  const month = new Date(r.monthStart).toLocaleDateString(undefined, {
    month: 'long',
    timeZone: 'UTC',
  });

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">ROI · {month}</h1>
        <BudgetMeter
          spentUsd={r.budget.spentUsd}
          budgetUsd={r.budget.budgetUsd}
          forecastUsd={r.budget.forecastUsd}
          label="Budget"
        />
        <span className="text-muted-foreground text-sm">
          {money(r.budget.remainingUsd)} left · forecast is linear to month end
        </span>
      </div>

      <Card>
        <CardTitle>Spend by stream</CardTitle>
        <div className="flex flex-col gap-2">
          {r.streams.map((s) => {
            const share = s.capUsd > 0 ? s.spentUsd / s.capUsd : s.spentUsd > 0 ? 1 : 0;
            const fShare = s.capUsd > 0 ? Math.min(1, s.forecastUsd / s.capUsd) : 0;
            const over = s.forecastUsd > s.capUsd;
            return (
              <div key={s.key} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="w-36 shrink-0">{BAR_LABEL[s.key] ?? s.key}</span>
                <span
                  className="bg-muted relative h-2 w-48 overflow-hidden rounded"
                  role="meter"
                  aria-label={`${BAR_LABEL[s.key] ?? s.key} spend against its sub-cap`}
                  aria-valuemin={0}
                  aria-valuemax={s.capUsd}
                  aria-valuenow={s.spentUsd}
                >
                  <span
                    className="bg-foreground/15 absolute inset-y-0 left-0"
                    style={{ width: `${fShare * 100}%` }}
                  />
                  <span
                    className={cn(
                      'absolute inset-y-0 left-0',
                      share >= 1 ? 'bg-red-600' : share >= 0.8 ? 'bg-amber-500' : 'bg-emerald-600',
                    )}
                    style={{ width: `${Math.min(1, share) * 100}%` }}
                  />
                </span>
                <span className="tabular-nums">
                  {money(s.spentUsd)} / {money(s.capUsd)}
                </span>
                <span className="text-muted-foreground text-xs">
                  {Math.round(s.capShare * 100)}% sub-cap{s.enforced ? '' : ' (not enforced)'} ·
                  forecast {money(s.forecastUsd)}
                </span>
                {share >= 1 ? (
                  <span className="text-xs font-medium text-red-700">sub-cap reached</span>
                ) : over ? (
                  <span className="text-xs font-medium text-amber-800">
                    on track to pass the sub-cap
                  </span>
                ) : null}
              </div>
            );
          })}
          <p className="text-muted-foreground text-xs">
            LLM spend also counts in the stream it ran for. Change caps in{' '}
            <Link href="/settings?tab=budget" className="underline">
              Settings → Budget
            </Link>
            .
          </p>
        </div>
      </Card>

      <Card>
        <CardTitle>Results by stream</CardTitle>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground text-left text-xs">
              <tr>
                {[
                  'Stream',
                  'Spend',
                  'Accounts',
                  'Qualified',
                  'Replies',
                  'Meetings',
                  '$/qualified',
                  '$/meeting',
                ].map((h, i) => (
                  <th key={h} className={cn('py-1 font-medium', i > 0 && 'text-right')}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {r.roi.map((row) => (
                <tr key={row.stream} className="border-t">
                  <td className="py-1.5">{STREAM_NAME[row.stream] ?? row.stream}</td>
                  <td className="text-right">{money(row.spendUsd)}</td>
                  <td className="text-right">{row.accounts}</td>
                  <td className="text-right">{row.qualified}</td>
                  <td className="text-right">{row.replies}</td>
                  <td className="text-right">{row.meetings}</td>
                  <td className="text-right">{money(row.costPerQualifiedUsd)}</td>
                  <td className="text-right">{money(row.costPerMeetingUsd)}</td>
                </tr>
              ))}
              <tr className="text-muted-foreground border-t">
                <td className="py-1.5">of which LLM</td>
                <td className="text-right">{money(r.llmUsd)}</td>
                <td colSpan={6} />
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-muted-foreground mt-2 text-xs">
          This month, attributed by each account&apos;s first source. Qualified = fit at or above
          the threshold and stage Contacted or later. &ldquo;—&rdquo; = nothing to divide by yet.
        </p>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>Ledger</CardTitle>
          <NativeSelect
            aria-label="Provider"
            value={provider}
            onChange={(e) => setFilter('provider', e.target.value)}
            className="h-8 w-auto"
          >
            <option value="">All providers</option>
            {ledger.data?.providers.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </NativeSelect>
          <NativeSelect
            aria-label="Stream"
            value={stream}
            onChange={(e) => setFilter('stream', e.target.value)}
            className="h-8 w-auto"
          >
            <option value="">All streams</option>
            {Object.entries(STREAM_NAME).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </NativeSelect>
          <span className="text-muted-foreground ml-auto text-xs">
            Every paid call this month, linked to the record it was for
          </span>
        </div>
        {!ledger.data ? (
          <SkeletonRows rows={4} />
        ) : ledger.data.rows.length === 0 ? (
          <EmptyState title="No calls in this view">
            Calls appear here as soon as a stream, enrichment or LLM draft runs.
          </EmptyState>
        ) : (
          <div className="max-h-[28rem] overflow-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground bg-background sticky top-0 text-left text-xs">
                <tr>
                  <th className="py-1 font-medium">When</th>
                  <th className="font-medium">Provider</th>
                  <th className="font-medium">Operation</th>
                  <th className="font-medium">Stream</th>
                  <th className="font-medium">Record</th>
                  <th className="text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {ledger.data.rows.map((row) => (
                  <tr key={row.id} className="border-t">
                    <td className="text-muted-foreground py-1.5 whitespace-nowrap">
                      {new Date(row.at).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td>{row.provider}</td>
                    <td>{row.operation}</td>
                    <td>{STREAM_NAME[row.stream] ?? row.stream}</td>
                    <td className="max-w-56 truncate">
                      {row.entity?.href ? (
                        <Link
                          href={row.entity.href}
                          className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
                        >
                          {row.entity.label}
                        </Link>
                      ) : row.entity ? (
                        <span className="text-muted-foreground">{row.entity.label}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="text-right whitespace-nowrap tabular-nums">
                      {row.charge === 'paid' ? (
                        <>
                          {row.usd < 0.01 ? `$${row.usd.toFixed(4)}` : money(row.usd)}
                          {row.estimated ? (
                            <span className="text-muted-foreground text-xs"> est.</span>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-muted-foreground">{CHARGE_TEXT[row.charge]}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t font-medium">
                  <td className="py-1.5" colSpan={5}>
                    {ledger.data.totals.calls} call{ledger.data.totals.calls === 1 ? '' : 's'}
                  </td>
                  <td className="text-right tabular-nums">{money(ledger.data.totals.usd)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
