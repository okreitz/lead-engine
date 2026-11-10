'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Maximize2, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { EmailStatusBadge } from '@/components/blocks/email-status';
import { EmptyState, SkeletonRows } from '@/components/blocks/empty-state';
import { MiniBar, ScoreBreakdown } from '@/components/blocks/score';
import { SourceDot } from '@/components/blocks/source-dot';
import { ConfirmButton } from '@/components/confirm';
import { CopyEmail } from '@/components/copy-email';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { HoverCard } from '@/components/ui/tooltip';
import { api, errorMessage, fmtDate, usd } from '@/lib/api';
import type { AccountDetail, FieldSource, Signal } from '@/lib/crm';
import { useMe } from '@/lib/me';
import { cn } from '@/lib/utils';

type SignalFilter = 'all' | 'visits' | 'threads' | 'fit' | 'hiring' | 'activity';
const FILTERS: { key: SignalFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'visits', label: 'Visits' },
  { key: 'threads', label: 'Threads' },
  { key: 'fit', label: 'Fit' },
  { key: 'hiring', label: 'Hiring' },
  { key: 'activity', label: 'Activity' },
];

function signalType(s: Signal): Exclude<SignalFilter, 'all' | 'activity'> | 'other' {
  if (s.kind === 'fit') return 'fit';
  if (s.kind === 'hiring') return 'hiring';
  if (s.stream === 'visits') return 'visits';
  if (s.stream === 'conversations') return 'threads';
  return 'other';
}

const SIGNAL_ICON: Record<string, string> = {
  visits: '◉',
  threads: '✉',
  fit: '★',
  hiring: '⚑',
  other: '•',
  activity: '✎',
};

/** Reason strings that count against fit get a cross; the rest a tick. */
function negativeReason(r: string): boolean {
  return /outside|not a target|excluded|avoids|no target|unknown/i.test(r);
}

function ago(ms: number): string {
  const d = (Date.now() - ms) / 86_400_000;
  if (d < 1 / 24) return 'now';
  if (d < 1) return `${Math.floor(d * 24)}h`;
  return `${Math.floor(d)}d`;
}

/**
 * Account page and side sheet (docs/ui.md §3.3): header with KPIs, then fit and
 * firmographics, the signal timeline with a type filter, and people, deals and activity.
 * The sheet (`compact`) shows the header and the first two sections.
 */
export function AccountView({
  id,
  compact = false,
  onClose,
}: {
  id: string;
  compact?: boolean;
  onClose?: () => void;
}) {
  const qc = useQueryClient();
  const router = useRouter();
  const stages = useMe().data?.workspace?.settings.stages ?? [];
  const q = useQuery({
    queryKey: ['account', id],
    queryFn: () => api<AccountDetail>(`/accounts/${id}`),
  });
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<SignalFilter>('all');

  const run = async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
      await qc.invalidateQueries({ queryKey: ['account', id] });
      await qc.invalidateQueries({ queryKey: ['accounts'] });
      await qc.invalidateQueries({ queryKey: ['pipeline'] });
      await qc.invalidateQueries({ queryKey: ['today'] });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (q.error) return <p className="text-destructive p-4 text-sm">{errorMessage(q.error)}</p>;
  if (!q.data)
    return (
      <div className="p-4">
        <SkeletonRows rows={6} />
      </div>
    );
  const { account, company, contacts, deals, activities, nextSteps, signals, fieldSources } =
    q.data;
  const companySources = (field: string) =>
    fieldSources.filter((f) => f.entity !== 'contact' && f.field === field);
  const openStep = nextSteps.find((n) => !n.doneAt);

  const timeline = [
    ...signals.map((s) => ({
      id: s.id,
      type: signalType(s) as string,
      at: s.occurredAt,
      title: s.kind.replace(/_/g, ' '),
      body: describeSignal(s.payload),
      url: s.evidenceUrl,
    })),
    ...activities.map((a) => ({
      id: a.id,
      type: 'activity',
      at: a.at,
      title: a.kind.replace('_', ' '),
      body: a.body,
      url: null,
    })),
  ]
    .filter((t) => filter === 'all' || t.type === filter)
    .sort((a, b) => b.at - a.at);

  const header = (
    <header className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className={cn('font-semibold tracking-tight', compact ? 'text-lg' : 'text-2xl')}>
            {company.name}
          </h1>
          <p className="text-muted-foreground text-sm">
            <a
              href={`https://${company.domain}`}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="hover:underline"
            >
              {company.domain}
            </a>
            {[
              [company.city, company.state].filter(Boolean).join(', '),
              company.sizeRange,
              company.industry,
            ]
              .filter(Boolean)
              .map((x) => ` · ${x}`)}
            {account.status === 'archived' ? ' · archived' : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {compact ? (
            <>
              <Button variant="ghost" size="icon-sm" asChild aria-label="Open full page">
                <Link href={`/accounts/${id}`}>
                  <Maximize2 />
                </Link>
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close (Esc)">
                <X />
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void run(() =>
                    api(`/accounts/${id}`, {
                      method: 'PATCH',
                      body: { status: account.status === 'archived' ? 'active' : 'archived' },
                    }),
                  )
                }
              >
                {account.status === 'archived' ? 'Unarchive' : 'Archive'}
              </Button>
              <ConfirmButton
                trigger={
                  <Button variant="destructive" size="sm">
                    Delete
                  </Button>
                }
                title={`Delete ${company.name}?`}
                description="Deletes the account with its contacts, deals, activities and signals."
                onConfirm={async () => {
                  await api(`/accounts/${id}`, { method: 'DELETE' });
                  await qc.invalidateQueries({ queryKey: ['accounts'] });
                  router.replace('/accounts');
                }}
              />
            </>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <HoverCard
          trigger={
            <span className="cursor-default" tabIndex={0}>
              Priority <strong className="tabular-nums">{Math.round(account.priority)}</strong>
            </span>
          }
        >
          <ScoreBreakdown score={account} />
        </HoverCard>
        <span className="inline-flex items-center gap-1.5">
          Fit{' '}
          <strong className="tabular-nums">
            {account.fitScore == null ? '—' : Math.round(account.fitScore)}
          </strong>
          <MiniBar value={account.fitScore} label="" />
        </span>
        <span className="inline-flex items-center gap-1.5">
          Intent <strong className="tabular-nums">{Math.round(account.intentScore)}</strong>
          <MiniBar value={account.intentScore} label="" />
        </span>
        <label className="inline-flex items-center gap-1.5">
          Stage
          <NativeSelect
            className="h-8"
            value={account.stage}
            onChange={(e) =>
              void run(() =>
                api(`/accounts/${id}/stage`, { method: 'PATCH', body: { stage: e.target.value } }),
              )
            }
          >
            {stages.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </NativeSelect>
        </label>
        <NextStepInline
          step={openStep}
          onAdd={(text, dueAt) =>
            run(() =>
              api(`/accounts/${id}/next-steps`, {
                method: 'POST',
                body: { text, ...(dueAt ? { dueAt } : {}) },
              }),
            )
          }
          onDone={(sid) =>
            run(() => api(`/next-steps/${sid}`, { method: 'PATCH', body: { done: true } }))
          }
        />
      </div>
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
    </header>
  );

  const fitColumn = (
    <section aria-labelledby="fit-h" className="flex flex-col gap-3">
      <h2 id="fit-h" className="text-sm font-semibold">
        Fit
      </h2>
      {account.scoreReasons?.fit?.length && account.fitScore != null ? (
        <ul className="flex flex-col gap-1 text-sm">
          {account.scoreReasons.fit.map((r, i) => (
            <li key={i} className="flex gap-2">
              <span aria-hidden className={negativeReason(r) ? 'text-red-700' : 'text-emerald-700'}>
                {negativeReason(r) ? '✗' : '✓'}
              </span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">
          {account.scoreReasons?.fit?.[0] ?? 'Not scored yet.'}{' '}
          <Link href="/offer" className="underline">
            Offer profile
          </Link>
        </p>
      )}
      <h3 className="text-sm font-semibold">Firmographics</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <Fact
          k="Location"
          v={[company.city, company.state, company.country].filter(Boolean).join(', ')}
          sources={[...companySources('state'), ...companySources('city')]}
        />
        <Fact k="Industry" v={company.industry} sources={companySources('industry')} />
        <Fact k="NAICS" v={company.naics} sources={companySources('naics')} />
        <Fact k="Size" v={company.sizeRange} sources={companySources('sizeRange')} />
        <Fact k="Founded" v={company.foundedYear} sources={companySources('foundedYear')} />
        <Fact k="Tech" v={company.tech.join(', ')} sources={companySources('tech')} />
      </dl>
      <p className="text-muted-foreground text-xs">
        First source {account.firstSource}, {fmtDate(account.firstSourceAt)} · scored{' '}
        {fmtDate(account.scoredAt)}
      </p>
    </section>
  );

  const signalColumn = (
    <section aria-labelledby="sig-h" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="sig-h" className="text-sm font-semibold">
          Signals
        </h2>
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Signal type">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                'rounded px-2 py-0.5 text-xs',
                filter === f.key ? 'bg-foreground text-background' : 'bg-muted hover:bg-accent',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <ol className="flex flex-col gap-2">
        {timeline.map((t) => (
          <li key={t.id} className="flex gap-2 text-sm">
            <span aria-hidden className="w-4 text-center">
              {SIGNAL_ICON[t.type] ?? '•'}
            </span>
            <span className="text-muted-foreground w-8 shrink-0 tabular-nums">{ago(t.at)}</span>
            <span className="min-w-0">
              <span className="font-medium capitalize">{t.title}</span>
              {t.body ? <span className="text-muted-foreground"> · {t.body}</span> : null}
              {t.url ? (
                <a
                  href={t.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="ml-1 inline-flex items-center gap-0.5 underline"
                >
                  open <ExternalLink className="size-3" />
                </a>
              ) : null}
            </span>
          </li>
        ))}
        {timeline.length === 0 ? (
          <li className="text-muted-foreground text-sm">Nothing here yet.</li>
        ) : null}
      </ol>
    </section>
  );

  if (compact) {
    return (
      <div className="flex flex-col gap-5 p-5">
        {header}
        {fitColumn}
        {signalColumn}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {header}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1.2fr)]">
        <div className="order-3 lg:order-1">{fitColumn}</div>
        <div className="order-1 lg:order-2">{signalColumn}</div>
        <div className="order-2 flex flex-col gap-6 lg:order-3">
          <section aria-labelledby="con-h" className="flex flex-col gap-2">
            <h2 id="con-h" className="text-sm font-semibold">
              Contacts ({contacts.length})
            </h2>
            <ul className="flex flex-col gap-2">
              {contacts.map((c) => {
                const src = (field: string) =>
                  fieldSources.filter((f) => f.entityId === c.id && f.field === field);
                return (
                  <li key={c.id} className="text-sm">
                    <div>
                      <span className="font-medium">{c.fullName}</span>
                      <SourceDot sources={toSources(src('fullName'))} />
                      {c.title ? <span className="text-muted-foreground"> · {c.title}</span> : null}
                      <SourceDot sources={toSources(src('title'))} />
                    </div>
                    {c.email ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <CopyEmail email={c.email} />
                        <EmailStatusBadge status={c.emailStatus} />
                        <SourceDot sources={toSources(src('email'))} />
                        <ConfirmButton
                          trigger={
                            <Button size="xs" variant="ghost">
                              Suppress
                            </Button>
                          }
                          title={`Suppress ${c.email}?`}
                          description="Adds the email to the suppression list. It disappears from every view and export and is never enriched again."
                          confirmLabel="Suppress"
                          onConfirm={() =>
                            run(() => api(`/contacts/${c.id}/suppress`, { method: 'POST' }))
                          }
                        />
                      </div>
                    ) : null}
                  </li>
                );
              })}
              {contacts.length === 0 ? (
                <li className="text-muted-foreground text-sm">No contacts yet.</li>
              ) : null}
            </ul>
            <AddContact
              onAdd={(body) => run(() => api(`/accounts/${id}/contacts`, { method: 'POST', body }))}
            />
          </section>

          <section aria-labelledby="deal-h" className="flex flex-col gap-2">
            <h2 id="deal-h" className="text-sm font-semibold">
              Deals
            </h2>
            {deals.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{d.name}</span>
                <span className="text-muted-foreground">{usd(d.valueUsd)}</span>
                <NativeSelect
                  className="ml-auto h-8"
                  value={d.stage}
                  aria-label={`Stage of ${d.name}`}
                  onChange={(e) =>
                    void run(() =>
                      api(`/deals/${d.id}`, { method: 'PATCH', body: { stage: e.target.value } }),
                    )
                  }
                >
                  {stages.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </NativeSelect>
                <NativeSelect
                  className="h-8"
                  value={d.outcome ?? ''}
                  aria-label={`Outcome of ${d.name}`}
                  onChange={(e) =>
                    void run(() =>
                      api(`/deals/${d.id}`, {
                        method: 'PATCH',
                        body: { outcome: e.target.value || null },
                      }),
                    )
                  }
                >
                  <option value="">open</option>
                  <option value="won">won</option>
                  <option value="lost">lost</option>
                </NativeSelect>
              </div>
            ))}
            <InlineForm
              fields={[
                { name: 'name', placeholder: 'Deal name', required: true },
                { name: 'value', placeholder: 'USD', type: 'number', className: 'w-24' },
              ]}
              submit="Add deal"
              onSubmit={(v) =>
                run(() =>
                  api(`/accounts/${id}/deals`, {
                    method: 'POST',
                    body: { name: v.name, ...(v.value ? { valueUsd: Number(v.value) } : {}) },
                  }),
                )
              }
            />
          </section>

          <section aria-labelledby="act-h" className="flex flex-col gap-2">
            <h2 id="act-h" className="text-sm font-semibold">
              Log activity
            </h2>
            <LogActivity
              contacts={contacts}
              onLog={(body) =>
                run(() => api(`/accounts/${id}/activities`, { method: 'POST', body }))
              }
            />
            {nextSteps.length ? (
              <>
                <h3 className="mt-2 text-sm font-semibold">Next steps</h3>
                <ul className="flex flex-col gap-1 text-sm">
                  {nextSteps.map((n) => (
                    <li key={n.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={n.doneAt !== null}
                        aria-label={`Done: ${n.text}`}
                        onChange={(e) =>
                          void run(() =>
                            api(`/next-steps/${n.id}`, {
                              method: 'PATCH',
                              body: { done: e.target.checked },
                            }),
                          )
                        }
                      />
                      <span className={n.doneAt ? 'text-muted-foreground line-through' : ''}>
                        {n.text}
                      </span>
                      {n.dueAt ? (
                        <span className="text-muted-foreground ml-auto text-xs">
                          {new Date(n.dueAt).toLocaleDateString()}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}

function toSources(list: FieldSource[]) {
  return list.map((f) => ({
    source: f.source,
    url: f.url,
    fetchedAt: f.fetchedAt,
    confidence: f.confidence,
  }));
}

function Fact({ k, v, sources }: { k: string; v: ReactNode; sources: FieldSource[] }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd>
        {v === null || v === undefined || v === '' ? '—' : v}
        <SourceDot sources={toSources(sources)} />
      </dd>
    </>
  );
}

export function describeSignal(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ['title', 'path', 'reason', 'summary']) {
    const v = payload[key];
    if (typeof v === 'string') parts.push(v);
  }
  if (typeof payload.score === 'number') parts.push(`score ${payload.score}`);
  if (Array.isArray(payload.reasons)) parts.push(payload.reasons.slice(0, 2).join('; '));
  return parts.join(' · ');
}

function NextStepInline({
  step,
  onAdd,
  onDone,
}: {
  step: { id: string; text: string; dueAt: number | null } | undefined;
  onAdd: (text: string, dueAt: number | null) => Promise<unknown>;
  onDone: (id: string) => Promise<unknown>;
}) {
  const [adding, setAdding] = useState(false);
  if (step) {
    return (
      <span className="inline-flex items-center gap-1.5">
        Next step
        <span className="bg-muted rounded px-1.5 py-0.5">
          {step.text}
          {step.dueAt ? ` · ${new Date(step.dueAt).toLocaleDateString()}` : ''}
        </span>
        <Button size="xs" variant="ghost" onClick={() => void onDone(step.id)}>
          Done
        </Button>
      </span>
    );
  }
  if (!adding) {
    return (
      <span className="inline-flex items-center gap-1.5">
        Next step
        <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
          + add
        </Button>
      </span>
    );
  }
  return (
    <form
      className="inline-flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const due = String(f.get('due') ?? '');
        void onAdd(String(f.get('text')), due ? new Date(due).getTime() : null).then(() =>
          setAdding(false),
        );
      }}
    >
      <Input name="text" placeholder="Next step" className="h-8 w-48" required autoFocus />
      <Input name="due" type="date" className="h-8 w-36" aria-label="Due date" />
      <Button size="sm" type="submit">
        Add
      </Button>
    </form>
  );
}

function InlineForm({
  fields,
  submit,
  onSubmit,
}: {
  fields: {
    name: string;
    placeholder: string;
    required?: boolean;
    type?: string;
    className?: string;
  }[];
  submit: string;
  onSubmit: (values: Record<string, string>) => Promise<unknown>;
}) {
  return (
    <form
      className="flex flex-wrap gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const f = new FormData(form);
        const v = Object.fromEntries(
          fields.map((x) => [x.name, String(f.get(x.name) ?? '').trim()]),
        );
        void onSubmit(v).then(() => form.reset());
      }}
    >
      {fields.map((x) => (
        <Input
          key={x.name}
          name={x.name}
          placeholder={x.placeholder}
          required={x.required}
          type={x.type}
          className={cn('h-8 min-w-0 flex-1', x.className)}
          aria-label={x.placeholder}
        />
      ))}
      <Button type="submit" size="sm">
        {submit}
      </Button>
    </form>
  );
}

function AddContact({ onAdd }: { onAdd: (body: Record<string, string>) => Promise<unknown> }) {
  return (
    <InlineForm
      fields={[
        { name: 'fullName', placeholder: 'Full name', required: true },
        { name: 'title', placeholder: 'Title' },
        { name: 'email', placeholder: 'Email', type: 'email' },
      ]}
      submit="Add contact"
      onSubmit={(v) => onAdd(Object.fromEntries(Object.entries(v).filter(([, x]) => x)))}
    />
  );
}

function LogActivity({
  contacts,
  onLog,
}: {
  contacts: AccountDetail['contacts'];
  onLog: (body: Record<string, string>) => Promise<unknown>;
}) {
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const f = new FormData(form);
        const body: Record<string, string> = {
          kind: String(f.get('kind')),
          body: String(f.get('body')),
        };
        const contactId = String(f.get('contactId') ?? '');
        if (contactId) body.contactId = contactId;
        void onLog(body).then(() => form.reset());
      }}
    >
      <div className="flex gap-2">
        <NativeSelect name="kind" defaultValue="note" aria-label="Activity kind" className="h-8">
          <option value="note">Note</option>
          <option value="email">Email</option>
          <option value="call">Call</option>
          <option value="meeting">Meeting</option>
          <option value="reply">Reply</option>
        </NativeSelect>
        <NativeSelect name="contactId" defaultValue="" aria-label="Contact" className="h-8">
          <option value="">No contact</option>
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.fullName}
            </option>
          ))}
        </NativeSelect>
      </div>
      <Textarea name="body" placeholder="What happened?" required />
      <Button type="submit" size="sm" className="self-start">
        Log
      </Button>
    </form>
  );
}

export function EmptyAccounts() {
  return <EmptyState title="No accounts yet" next="Approve your offer profile" href="/offer" />;
}
