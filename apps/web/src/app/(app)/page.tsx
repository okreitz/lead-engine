'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { BudgetCard } from '@/components/budget';
import { Card, CardTitle } from '@/components/ui/card';
import { api, usd } from '@/lib/api';
import { score } from '@/lib/crm';
import { useMe } from '@/lib/me';

interface Summary {
  newAccountsThisWeek: number;
  newThreadsThisWeek: number;
  top: {
    id: string;
    name: string;
    domain: string;
    stage: string;
    priority: number;
    fitScore: number | null;
    intentScore: number;
    reasons: string[];
  }[];
  roi: {
    stream: string;
    spendUsd: number;
    accounts: number;
    qualified: number;
    replies: number;
    meetings: number;
    dealsWon: number;
    wonValueUsd: number;
    costPerQualifiedUsd: number | null;
    costPerMeetingUsd: number | null;
  }[];
}

export default function Overview() {
  const me = useMe();
  const s = useQuery({ queryKey: ['summary'], queryFn: () => api<Summary>('/summary') });
  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{me.data?.workspace?.name}</h1>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardTitle>This week</CardTitle>
          <p className="text-3xl font-semibold">{s.data?.newAccountsThisWeek ?? '—'}</p>
          <p className="text-muted-foreground text-sm">new accounts</p>
          <p className="mt-2 text-3xl font-semibold">{s.data?.newThreadsThisWeek ?? '—'}</p>
          <p className="text-muted-foreground text-sm">new threads</p>
        </Card>
        <div className="md:col-span-2">
          <BudgetCard />
        </div>
      </div>
      <Card>
        <CardTitle>Top accounts by priority</CardTitle>
        <table className="w-full text-sm">
          <thead className="text-muted-foreground text-left">
            <tr>
              <th className="py-1">Account</th>
              <th>Stage</th>
              <th className="text-right">Priority</th>
              <th className="text-right">Fit</th>
              <th className="text-right">Intent</th>
              <th className="pl-4">Why</th>
            </tr>
          </thead>
          <tbody>
            {s.data?.top.map((a) => (
              <tr key={a.id} className="border-t align-top">
                <td className="py-2">
                  <Link href={`/accounts/${a.id}`} className="font-medium hover:underline">
                    {a.name}
                  </Link>
                  <div className="text-muted-foreground text-xs">{a.domain}</div>
                </td>
                <td>{a.stage}</td>
                <td className="text-right font-medium">{score(a.priority)}</td>
                <td className="text-right">{score(a.fitScore)}</td>
                <td className="text-right">{score(a.intentScore)}</td>
                <td className="text-muted-foreground pl-4 text-xs">{a.reasons.join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {s.data?.top.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No accounts yet.{' '}
            <Link href="/offer" className="underline">
              Draft your offer profile
            </Link>{' '}
            or{' '}
            <Link href="/accounts" className="underline">
              add accounts
            </Link>
            .
          </p>
        ) : null}
      </Card>
      <Card>
        <CardTitle>ROI this month</CardTitle>
        <table className="w-full text-sm">
          <thead className="text-muted-foreground text-left">
            <tr>
              <th className="py-1">Stream</th>
              <th className="text-right">Spend</th>
              <th className="text-right">Accounts</th>
              <th className="text-right">Qualified</th>
              <th className="text-right">Replies</th>
              <th className="text-right">Meetings</th>
              <th className="text-right">Won</th>
              <th className="text-right">$/qualified</th>
              <th className="text-right">$/meeting</th>
            </tr>
          </thead>
          <tbody>
            {s.data?.roi.map((r) => (
              <tr key={r.stream} className="border-t">
                <td className="py-1">{r.stream}</td>
                <td className="text-right">{usd(r.spendUsd)}</td>
                <td className="text-right">{r.accounts}</td>
                <td className="text-right">{r.qualified}</td>
                <td className="text-right">{r.replies}</td>
                <td className="text-right">{r.meetings}</td>
                <td className="text-right">
                  {r.dealsWon} ({usd(r.wonValueUsd)})
                </td>
                <td className="text-right">{usd(r.costPerQualifiedUsd)}</td>
                <td className="text-right">{usd(r.costPerMeetingUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
