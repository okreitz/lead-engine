'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Badge, Card, CardTitle } from '@/components/ui/card';
import { api, fmtDate, usd } from '@/lib/api';

export interface Budget {
  budgetUsd: number;
  spentUsd: number;
  remainingUsd: number;
  share: number;
  state: 'ok' | 'warning' | 'reached';
  byProvider: { provider: string; usd: number; calls: number; freeCalls: number }[];
  byStream: { stream: string; usd: number }[];
  waitingJobs: { id: string; type: string; waitReason: string | null; runAt: number }[];
}

export function useBudget() {
  return useQuery({
    queryKey: ['budget'],
    queryFn: () => api<Budget>('/budget'),
    refetchInterval: 60_000,
  });
}

/** Shown on every page at 80% (warning) and 100% (paid calls stopped), SPEC §8.1. */
export function BudgetBanner() {
  const budget = useBudget().data;
  if (!budget || budget.state === 'ok') return null;
  const reached = budget.state === 'reached';
  return (
    <div
      role="status"
      className={
        reached
          ? 'mb-4 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-900'
          : 'mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900'
      }
    >
      {reached ? 'Budget reached: paid calls are stopped' : 'Budget warning'} —{' '}
      {usd(budget.spentUsd)} of {usd(budget.budgetUsd)} spent this month (
      {Math.round(budget.share * 100)}%).
      {budget.waitingJobs.length ? ` ${budget.waitingJobs.length} job(s) waiting.` : ''}{' '}
      <Link href="/settings" className="underline">
        Change the budget
      </Link>
    </div>
  );
}

export function BudgetCard() {
  const { data: b } = useBudget();
  if (!b) return null;
  const pct = Math.min(100, Math.round(b.share * 100));
  return (
    <Card>
      <CardTitle>Spend this month</CardTitle>
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-2xl font-semibold">{usd(b.spentUsd)}</span>
        <span className="text-muted-foreground text-sm">of {usd(b.budgetUsd)}</span>
        <Badge tone={b.state === 'ok' ? 'ok' : b.state === 'warning' ? 'warn' : 'danger'}>
          {b.state === 'reached' ? 'budget reached' : b.state}
        </Badge>
      </div>
      <div className="bg-muted h-2 w-full overflow-hidden rounded">
        <div
          className={
            b.state === 'reached'
              ? 'h-full bg-red-500'
              : b.state === 'warning'
                ? 'h-full bg-amber-500'
                : 'h-full bg-emerald-500'
          }
          style={{ width: `${pct}%` }}
        />
      </div>
      {b.byProvider.length ? (
        <table className="mt-4 w-full text-sm">
          <thead className="text-muted-foreground text-left">
            <tr>
              <th>Provider</th>
              <th>Calls</th>
              <th>Free</th>
              <th className="text-right">USD</th>
            </tr>
          </thead>
          <tbody>
            {b.byProvider.map((p) => (
              <tr key={p.provider} className="border-t">
                <td className="py-1 font-mono">{p.provider}</td>
                <td>{p.calls}</td>
                <td>{p.freeCalls}</td>
                <td className="text-right">{usd(p.usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-muted-foreground mt-3 text-sm">No paid calls yet this month.</p>
      )}
      {b.waitingJobs.length ? (
        <div className="mt-4">
          <h3 className="mb-1 text-sm font-medium">Waiting jobs</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {b.waitingJobs.map((j) => (
              <li key={j.id}>
                <span className="font-mono">{j.type}</span>:{' '}
                <span className="text-amber-800">{j.waitReason}</span>
                <span className="text-muted-foreground"> · retries {fmtDate(j.runAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
