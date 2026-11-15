'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Fragment, Suspense, useState } from 'react';
import { DROPPED_GROUPS, MATCH_SOURCE_LABELS } from '@le/shared';
import { EmptyState, SkeletonRows } from '@/components/blocks/empty-state';
import { ExternalLink } from '@/components/blocks/key-help';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/card';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { NativeSelect } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { useKeys } from '@/lib/keys';
import { useSheet } from '@/lib/sheet';
import { cn } from '@/lib/utils';
import {
  confidenceLabel,
  fetchSites,
  markWrongCompany,
  pct,
  type VisitorCompany,
  type VisitorsReport,
} from '@/lib/visitors';

export default function VisitorsPage() {
  return (
    <Suspense fallback={null}>
      <Visitors />
    </Suspense>
  );
}

function ago(ms: number): string {
  const m = (Date.now() - ms) / 60_000;
  if (m < 1) return 'now';
  if (m < 60) return `${Math.floor(m)}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

const DROP_LABELS: [keyof typeof DROPPED_GROUPS, string][] = [
  ['nonUs', 'non-US'],
  ['bot', 'bot'],
  ['network', 'ISP/mobile/hosting/VPN'],
  ['unmatched', 'no company found'],
  ['unclassified', 'unclassified'],
];

/** Visitors (docs/ui.md §3.6): which US companies visit each site, with match rate and drops. */
function Visitors() {
  const qc = useQueryClient();
  const router = useRouter();
  const params = useSearchParams();
  const sheet = useSheet();
  const sites = useQuery({ queryKey: ['sites'], queryFn: fetchSites });
  const siteId = params.get('site') ?? sites.data?.sites[0]?.id ?? null;
  const days = Number(params.get('days') ?? 30);
  const show = params.get('show') === 'all' ? 'all' : 'engaged';
  const report = useQuery({
    queryKey: ['visitors', siteId, days, show],
    queryFn: () =>
      api<VisitorsReport>(
        `/visitors?siteId=${encodeURIComponent(siteId!)}&days=${days}&show=${show}`,
      ),
    enabled: !!siteId,
    refetchInterval: 60_000,
  });
  const [selected, setSelected] = useState(0);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [wrong, setWrong] = useState<VisitorCompany | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value === null) next.delete(key);
    else next.set(key, value);
    router.replace(`/visitors?${next.toString()}`, { scroll: false });
  };

  const rows = report.data?.companies ?? [];
  // Keep the selection inside the list when it shrinks.
  const sel = Math.min(selected, Math.max(0, rows.length - 1));
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const current = rows[sel];
  useKeys(
    {
      j: () => setSelected(Math.min(rows.length - 1, sel + 1)),
      k: () => setSelected(Math.max(0, sel - 1)),
      Enter: () => current && toggle(current.accountId),
      ' ': () => current && sheet.open(current.accountId),
      w: () => current && setWrong(current),
      W: () => current && setWrong(current),
    },
    !wrong,
  );

  if (sites.isLoading) return <SkeletonRows rows={6} />;
  if (sites.data && sites.data.sites.length === 0) {
    return (
      <div className="flex max-w-3xl flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Visitors</h1>
        <EmptyState
          title="Install the snippet"
          next="Add a site in Settings → Sites & snippet"
          href="/settings?tab=sites"
        >
          See which US companies visit your sites, with match rate and dropped traffic per site.
          Company level only: no cookies, no individual visitors.
        </EmptyState>
      </div>
    );
  }

  const r = report.data;
  const sessions = r?.kpi.sessions ?? 0;
  const groupShare = (keys: readonly string[]) =>
    sessions ? keys.reduce((s, k) => s + (r?.outcomes[k]?.sessions ?? 0), 0) / sessions : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Visitors</h1>
        <NativeSelect
          aria-label="Site"
          value={siteId ?? ''}
          onChange={(e) => setParam('site', e.target.value)}
          className="w-56"
        >
          {sites.data?.sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.domain}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Range"
          value={String(days)}
          onChange={(e) => setParam('days', e.target.value)}
          className="w-36"
        >
          <option value="7">last 7 days</option>
          <option value="30">last 30 days</option>
          <option value="90">last 90 days</option>
        </NativeSelect>
        <div className="flex gap-1" role="tablist" aria-label="Filter">
          {(
            [
              ['engaged', 'More than 2 pages or an intent page'],
              ['all', 'All companies'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={show === key}
              onClick={() => setParam('show', key === 'engaged' ? null : key)}
              className={cn(
                'rounded px-2 py-1 text-xs',
                show === key ? 'bg-foreground text-background' : 'bg-muted hover:bg-accent',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {r ? (
        <div className="flex flex-col gap-1 text-sm">
          <p>
            <span className="text-lg font-semibold">Match rate {pct(r.kpi.matchRate)}</span>{' '}
            <span className="text-muted-foreground">
              (identified {r.kpi.identified} / sessions {r.kpi.sessions}) · {r.kpi.newAccounts} new
              accounts from visits
            </span>
          </p>
          <p className="text-muted-foreground">
            dropped:{' '}
            {DROP_LABELS.map(([k, label], i) => (
              <span key={k}>
                {i ? ' · ' : ''}
                {label} {pct(groupShare(DROPPED_GROUPS[k]))}
              </span>
            ))}
            {r.outcomes.rate_limited
              ? ` · rate-limited ${r.outcomes.rate_limited.pageviews} requests`
              : ''}
          </p>
          {!r.status.ipapiKey ? (
            <p className="text-amber-700">
              No ipapi.is key: business visits stay unclassified.{' '}
              <Link href="/settings?tab=keys#key-ipapi" className="underline">
                Add the key
              </Link>
            </p>
          ) : null}
          {!r.status.geo.ready ? (
            <p className="text-amber-700">
              The country database isn&apos;t loaded yet, so every visit is dropped.{' '}
              {r.status.geo.error ?? ''}
            </p>
          ) : null}
          {!r.site.receiving && !r.site.lastEventAt ? (
            <p className="text-muted-foreground">
              No events from {r.site.domain} yet.{' '}
              <Link href="/settings?tab=sites" className="underline">
                Check the install
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}

      {report.isLoading ? <SkeletonRows rows={6} /> : null}
      {report.error ? (
        <p className="text-destructive text-sm">{errorMessage(report.error)}</p>
      ) : null}
      {r && rows.length === 0 ? (
        <EmptyState title="No companies yet">
          {r.hidden
            ? `${r.hidden} companies visited without reaching 3 pages or an intent page. Show all companies to see them.`
            : 'Matched US companies appear here as they visit.'}
        </EmptyState>
      ) : null}
      {rows.length ? (
        <table className="w-full text-sm">
          <thead className="text-muted-foreground text-left">
            <tr>
              <th className="py-2">Company</th>
              <th className="text-right">Visits</th>
              <th className="text-right">Pages</th>
              <th className="pl-4">Last</th>
              <th>Intent pages</th>
              <th>Match</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => (
              <Fragment key={c.accountId}>
                <tr
                  className={cn('border-t', i === sel && 'bg-accent/60')}
                  onClick={() => setSelected(i)}
                  aria-selected={i === sel}
                >
                  <td className="py-2">
                    <button
                      type="button"
                      className="mr-1 w-4 text-left"
                      aria-label={open.has(c.accountId) ? 'Hide path' : 'Show path'}
                      aria-expanded={open.has(c.accountId)}
                      onClick={() => toggle(c.accountId)}
                    >
                      {open.has(c.accountId) ? '▾' : '▸'}
                    </button>
                    <button
                      type="button"
                      className="font-medium hover:underline"
                      onClick={() => sheet.open(c.accountId)}
                    >
                      {c.name}
                    </button>
                    <span className="text-muted-foreground"> · {c.domain}</span>
                  </td>
                  <td className="text-right tabular-nums">{c.visits}</td>
                  <td className="text-right tabular-nums">{c.pages}</td>
                  <td className="pl-4 tabular-nums">{ago(c.lastAt)}</td>
                  <td>
                    {c.intentPages.length
                      ? c.intentPages
                          .map((p) => `${p.path}${p.count > 1 ? ` ×${p.count}` : ''}`)
                          .join(' · ')
                      : '—'}
                  </td>
                  <td>
                    <Badge
                      tone={c.confidence >= 0.9 ? 'ok' : c.confidence >= 0.6 ? 'default' : 'warn'}
                    >
                      {MATCH_SOURCE_LABELS[c.matchSource] ?? c.matchSource} ·{' '}
                      {confidenceLabel(c.confidence)}
                    </Badge>
                  </td>
                  <td className="text-right">
                    <Button size="xs" variant="ghost" onClick={() => setWrong(c)}>
                      Wrong company <kbd className="ml-1 text-[10px]">W</kbd>
                    </Button>
                  </td>
                </tr>
                {open.has(c.accountId) ? (
                  <tr>
                    <td colSpan={7} className="text-muted-foreground pb-2 pl-6 text-xs">
                      path (latest visit): {c.path.join(' → ')}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      ) : null}

      <p className="text-muted-foreground text-xs">
        Company level only: no cookies, no individual visitors. Non-US, bot, ISP, mobile, hosting
        and VPN traffic is dropped before anything is stored.{' '}
        {r?.status.geo.source === 'ipinfo' ? (
          <ExternalLink href="https://ipinfo.io">IP address data is powered by IPinfo</ExternalLink>
        ) : (
          <ExternalLink href="https://db-ip.com">IP Geolocation by DB-IP</ExternalLink>
        )}
        . Company data from ipapi.is.
      </p>

      <Dialog open={!!wrong} onOpenChange={(o) => !o && setWrong(null)}>
        {wrong ? (
          <DialogContent
            title={`Wrong company: ${wrong.name}?`}
            description={`The IP ranges that matched ${wrong.domain} are marked wrong, so they never match it again, and its ${wrong.pages} matched page views and their signals are removed. The account itself stays. This is logged.`}
          >
            <div className="mt-4 flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <Button
                variant="destructive"
                onClick={async () => {
                  const target = wrong;
                  setWrong(null);
                  try {
                    const res = await markWrongCompany(target.accountId);
                    setNotice(
                      `Marked ${res.prefixes.length} IP range${res.prefixes.length === 1 ? '' : 's'} as not ${res.domain}; removed ${res.removedVisits} page views.`,
                    );
                  } catch (err) {
                    setNotice(errorMessage(err));
                  }
                  await qc.invalidateQueries({ queryKey: ['visitors'] });
                }}
              >
                Mark wrong
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
