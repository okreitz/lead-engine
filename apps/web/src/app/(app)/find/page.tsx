'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { EmptyState } from '@/components/blocks/empty-state';
import { WaitReason } from '@/components/blocks/key-help';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardTitle } from '@/components/ui/card';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { Input, Label, NativeSelect } from '@/components/ui/input';
import { api, ApiError, errorMessage, fmtDate } from '@/lib/api';
import { offerLabel, useOffers } from '@/lib/offers';

interface Filters {
  industries: string[];
  naics: string[];
  sizeMin: number | null;
  sizeMax: number | null;
  states: string[];
  foundedFrom: number | null;
  foundedTo: number | null;
  exclude: string[];
}
interface Estimate {
  filters: Filters;
  matches: number;
  candidates: number;
  sample: {
    name: string;
    domain: string;
    state: string | null;
    industry: string | null;
    ruleFit: number;
  }[];
  usd: number;
  perCandidateUsd: number;
  provider: string;
  model: string;
  remainingUsd: number;
  confirm: boolean;
  peoplePerAccountUsd: number;
}
interface Counts {
  candidates: number;
  scored: number;
  accounts: number;
  skipped: number;
  errors: number;
  techChecked: number;
}
interface Run {
  id: string;
  state: string;
  limit: number;
  threshold: number;
  counts: Counts;
  estimateUsd: number;
  techNote: string | null;
  error: string | null;
  createdAt: number;
  offerName: string | null;
  finishedAt: number | null;
  job: { state: string; waitReason: string | null; lastError: string | null } | null;
}
interface Candidate {
  id: string;
  state: string;
  ruleFit: number;
  llmFit: number | null;
  fit: number | null;
  reasons: string[] | null;
  evidence: string | null;
  evidenceUrl: string | null;
  note: string | null;
  accountId: string | null;
  name: string;
  domain: string;
  state_: string | null;
  industry: string | null;
  sizeRange: string | null;
  tech: string[];
}

const money = (n: number) => (n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);
const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const num = (s: string) => (s.trim() === '' ? null : Number(s));

export default function FindPage() {
  return (
    <Suspense fallback={null}>
      <Find />
    </Suspense>
  );
}

/**
 * "Find matching companies" (SPEC §5.1 steps 2–4, docs/ui.md §1.3): candidates from the
 * approved ICP over the company universe, a dry-run count and cost first, then a run whose
 * progress and results show here.
 */
function Find() {
  const params = useSearchParams();
  const router = useRouter();
  const runId = params.get('run');
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Find matching companies</h1>
        <Link href="/settings?tab=data" className="text-sm underline-offset-4 hover:underline">
          Company data
        </Link>
      </div>
      <NewRun onStarted={(id) => router.replace(`/find?run=${id}`, { scroll: false })} />
      <Runs
        selected={runId}
        onSelect={(id) => router.replace(`/find?run=${id}`, { scroll: false })}
      />
      {runId ? <RunDetail id={runId} /> : null}
    </div>
  );
}

function NewRun({ onStarted }: { onStarted: (id: string) => void }) {
  const qc = useQueryClient();
  const [limit, setLimit] = useState(500);
  const [overrides, setOverrides] = useState<Partial<Filters>>({});
  const [tech, setTech] = useState(true);
  const [people, setPeople] = useState(false);
  const [open, setOpen] = useState(false);
  const offers = useOffers();
  const [picked, setPicked] = useState<string | null>(null);
  // Several approved offers: the run is for one of them (its ICP fills the filters).
  const offerId = offers.approved.length > 1 ? (picked ?? offers.approved[0]!.id) : null;
  const body = { limit, filters: overrides, tech, people, ...(offerId ? { offerId } : {}) };
  const est = useQuery({
    queryKey: ['persona-estimate', body],
    queryFn: () => api<Estimate>('/persona/estimate', { method: 'POST', body }),
    retry: false,
    enabled: offers.query.isSuccess,
  });
  const start = useMutation({
    mutationFn: () => api<{ id: string }>('/persona/runs', { method: 'POST', body }),
    onSuccess: (r) => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['persona-runs'] });
      onStarted(r.id);
    },
  });
  if (est.error instanceof ApiError && est.error.code === 'no_offer')
    return (
      <EmptyState
        title="Approve an offer profile first"
        next="Open the offer profile"
        href="/offer"
      >
        The ideal customer profile (industries, size, states) drives the search.
      </EmptyState>
    );
  const f = est.data?.filters;
  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <CardTitle>Search the company universe</CardTitle>
        {offerId ? (
          <Label className="flex-row items-center gap-2">
            For offer
            <NativeSelect
              aria-label="Offer to find companies for"
              className="w-auto"
              value={offerId}
              onChange={(e) => {
                setPicked(e.target.value);
                // The new offer's ICP fills the filters again.
                setOverrides({});
              }}
            >
              {offers.approved.map((o) => (
                <option key={o.id} value={o.id}>
                  {offerLabel(o)}
                </option>
              ))}
            </NativeSelect>
          </Label>
        ) : null}
      </div>
      {f ? (
        <form
          key={JSON.stringify(f)}
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            const d = new FormData(e.currentTarget);
            setOverrides({
              industries: list(String(d.get('industries'))),
              naics: list(String(d.get('naics'))),
              states: list(String(d.get('states'))).map((s) => s.toUpperCase()),
              sizeMin: num(String(d.get('sizeMin'))),
              sizeMax: num(String(d.get('sizeMax'))),
              foundedFrom: num(String(d.get('foundedFrom'))),
              foundedTo: num(String(d.get('foundedTo'))),
              exclude: list(String(d.get('exclude'))),
            });
            setLimit(Number(d.get('limit')) || 500);
          }}
        >
          <Label>
            Industries (any of, comma-separated)
            <Input name="industries" defaultValue={f.industries.join(', ')} />
          </Label>
          <Label>
            NAICS prefixes
            <Input name="naics" defaultValue={f.naics.join(', ')} />
          </Label>
          <Label>
            States (two-letter, empty = all)
            <Input name="states" defaultValue={f.states.join(', ')} />
          </Label>
          <div className="grid grid-cols-2 gap-2">
            <Label>
              Employees from
              <Input name="sizeMin" type="number" min={0} defaultValue={f.sizeMin ?? ''} />
            </Label>
            <Label>
              to
              <Input name="sizeMax" type="number" min={0} defaultValue={f.sizeMax ?? ''} />
            </Label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Label>
              Founded from
              <Input
                name="foundedFrom"
                type="number"
                min={1600}
                max={2100}
                defaultValue={f.foundedFrom ?? ''}
              />
            </Label>
            <Label>
              to
              <Input
                name="foundedTo"
                type="number"
                min={1600}
                max={2100}
                defaultValue={f.foundedTo ?? ''}
              />
            </Label>
          </div>
          <Label>
            Exclude (name or industry contains)
            <Input name="exclude" defaultValue={f.exclude.join(', ')} />
          </Label>
          <Label>
            Candidates per run
            <Input name="limit" type="number" min={1} max={2000} defaultValue={limit} />
          </Label>
          <label className="flex items-center gap-2 self-end text-sm">
            <input type="checkbox" checked={tech} onChange={(e) => setTech(e.target.checked)} />
            Detect technologies (httpx, free, when installed)
          </label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={people} onChange={(e) => setPeople(e.target.checked)} />
            Then find people and emails for each new account
            {est.data
              ? ` (up to ${money(est.data.peoplePerAccountUsd)} per account, charged as each runs)`
              : ''}
          </label>
          <div className="sm:col-span-2">
            <Button type="submit" variant="outline" size="sm">
              Update preview
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-muted-foreground text-sm">Loading the ICP…</p>
      )}
      {est.data ? (
        <div className="mt-4 flex flex-col gap-2 border-t pt-4 text-sm">
          <p>
            <strong>{est.data.matches.toLocaleString()}</strong> companies match;{' '}
            <strong>{est.data.candidates}</strong> best by rule fit will be scored.
          </p>
          {est.data.sample.length ? (
            <p className="text-muted-foreground">
              Sample: {est.data.sample.map((s) => `${s.name} (${s.state ?? '?'})`).join(', ')}
            </p>
          ) : (
            <p className="text-muted-foreground">
              No matches. Import companies in{' '}
              <Link className="underline" href="/settings?tab=data">
                Settings → Company data
              </Link>{' '}
              or widen the filter.
            </p>
          )}
          <div className="flex items-center gap-3">
            <Button
              disabled={!est.data.candidates || start.isPending}
              onClick={() => (est.data!.confirm ? setOpen(true) : start.mutate())}
            >
              Find {est.data.candidates} companies
            </Button>
            <span className="text-muted-foreground text-xs">
              est. up to {money(est.data.usd)} ({est.data.provider} · {est.data.model});{' '}
              {money(est.data.remainingUsd)} left this month
            </span>
          </div>
          <p className="text-muted-foreground text-xs">
            Each candidate&rsquo;s homepage is fetched (robots.txt respected) and scored by the LLM
            with reasons and a quote. Candidates at or above the fit threshold become accounts.
            Skipped homepages and cached scores cost nothing.
          </p>
          {start.error ? <p className="text-destructive">{errorMessage(start.error)}</p> : null}
        </div>
      ) : est.error ? (
        <p className="text-destructive mt-2 text-sm">{errorMessage(est.error)}</p>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Run this paid search?"
          description={
            est.data
              ? `Score ${est.data.candidates} companies with the LLM. Estimated cost up to ${money(est.data.usd)}; ${money(est.data.remainingUsd)} of this month's budget is left.`
              : ''
          }
        >
          <p className="text-muted-foreground text-xs">
            Every call is recorded in the ledger. The run stops and waits if the budget runs out.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button disabled={start.isPending} onClick={() => start.mutate()}>
              Run for up to {est.data ? money(est.data.usd) : '…'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

const ACTIVE = ['queued', 'running'];

function Runs({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const offers = useOffers();
  const runs = useQuery({
    queryKey: ['persona-runs'],
    queryFn: () => api<Run[]>('/persona/runs'),
    refetchInterval: (q) => (q.state.data?.some((r) => ACTIVE.includes(r.state)) ? 3_000 : false),
  });
  if (!runs.data?.length) return null;
  return (
    <Card>
      <CardTitle>Runs</CardTitle>
      <ul className="flex flex-col divide-y text-sm">
        {runs.data.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => onSelect(r.id)}
              className={`flex w-full flex-wrap items-center gap-3 py-2 text-left ${selected === r.id ? 'font-medium' : ''}`}
            >
              <span>{fmtDate(r.createdAt)}</span>
              {offers.multiple && r.offerName ? (
                <span className="text-muted-foreground">{r.offerName}</span>
              ) : null}
              <RunState run={r} />
              <progress
                className="h-2 w-40"
                max={r.counts.candidates || 1}
                value={r.counts.scored + r.counts.skipped + r.counts.errors}
                aria-label="Run progress"
              />
              <span className="text-muted-foreground">
                {r.counts.scored + r.counts.skipped + r.counts.errors}/{r.counts.candidates} checked
                · {r.counts.accounts} accounts
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function RunState({ run }: { run: Run }) {
  if (run.job?.state === 'waiting')
    return (
      <span className="text-xs text-amber-800">
        waiting: {run.job.waitReason ? <WaitReason text={run.job.waitReason} /> : 'paused'}
      </span>
    );
  return <Badge tone={run.state === 'done' ? 'ok' : 'muted'}>{run.state}</Badge>;
}

function RunDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['persona-run', id],
    queryFn: () => api<Run & { candidates: Candidate[] }>(`/persona/runs/${id}`),
    refetchInterval: (q) => (q.state.data && ACTIVE.includes(q.state.data.state) ? 3_000 : false),
  });
  const [show, setShow] = useState<'accounts' | 'all'>('accounts');
  const cancel = useMutation({
    mutationFn: () => api(`/persona/runs/${id}/cancel`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries(),
  });
  const r = q.data;
  if (!r) return null;
  const rows = r.candidates.filter((c) => (show === 'accounts' ? c.accountId : true));
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3">
        <CardTitle>Results</CardTitle>
        <RunState run={r} />
        <span className="text-muted-foreground text-sm">
          {r.counts.accounts} accounts (fit ≥ {r.threshold}) · {r.counts.scored} scored ·{' '}
          {r.counts.skipped} skipped
          {r.counts.errors ? ` · ${r.counts.errors} errors` : ''}
          {r.counts.techChecked ? ` · tech on ${r.counts.techChecked}` : ''}
        </span>
        {ACTIVE.includes(r.state) ? (
          <Button size="sm" variant="ghost" onClick={() => cancel.mutate()}>
            Stop
          </Button>
        ) : null}
        <span className="ml-auto flex gap-1 text-sm">
          <Button
            size="xs"
            variant={show === 'accounts' ? 'secondary' : 'ghost'}
            onClick={() => setShow('accounts')}
          >
            Accounts
          </Button>
          <Button
            size="xs"
            variant={show === 'all' ? 'secondary' : 'ghost'}
            onClick={() => setShow('all')}
          >
            All candidates
          </Button>
        </span>
      </div>
      {r.techNote ? <p className="text-muted-foreground text-xs">{r.techNote}</p> : null}
      {r.job?.lastError && r.job.state !== 'done' ? (
        <p className="text-muted-foreground text-xs">Last error (retrying): {r.job.lastError}</p>
      ) : null}
      <table className="mt-3 w-full text-sm">
        <thead className="text-muted-foreground text-left text-xs">
          <tr>
            <th className="py-1 pr-2 font-normal">Company</th>
            <th className="py-1 pr-2 font-normal">Fit</th>
            <th className="py-1 font-normal">Why</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className="border-t align-top">
              <td className="py-2 pr-2">
                {c.accountId ? (
                  <Link
                    className="font-medium underline-offset-4 hover:underline"
                    href={`/accounts/${c.accountId}`}
                  >
                    {c.name}
                  </Link>
                ) : (
                  <span className="font-medium">{c.name}</span>
                )}
                <div className="text-muted-foreground text-xs">
                  {c.domain} · {c.state_ ?? '—'} · {c.sizeRange ?? '—'}
                </div>
              </td>
              <td className="py-2 pr-2 whitespace-nowrap">
                {c.state === 'scored' ? (
                  <span title={`rules ${c.ruleFit}, homepage ${c.llmFit}`}>
                    {c.fit} <span className="text-muted-foreground text-xs">(site {c.llmFit})</span>
                  </span>
                ) : (
                  <Badge tone="muted">{c.state}</Badge>
                )}
              </td>
              <td className="py-2">
                {c.reasons?.length ? (
                  <ul className="list-disc pl-4">
                    {c.reasons.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                ) : null}
                {c.evidence ? (
                  <blockquote className="text-muted-foreground mt-1 border-l-2 pl-2 text-xs">
                    &ldquo;{c.evidence}&rdquo;{' '}
                    {c.evidenceUrl ? (
                      <a
                        className="underline"
                        href={c.evidenceUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        source
                      </a>
                    ) : null}
                  </blockquote>
                ) : null}
                {c.note ? <p className="text-muted-foreground text-xs">{c.note}</p> : null}
                {c.tech.length ? (
                  <p className="text-muted-foreground text-xs">
                    Tech: {c.tech.slice(0, 6).join(', ')}
                  </p>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 ? (
        <p className="text-muted-foreground mt-2 text-sm">
          {ACTIVE.includes(r.state) ? 'Scoring…' : 'No candidates reached the fit threshold.'}
        </p>
      ) : null}
    </Card>
  );
}
