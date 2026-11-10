'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { ConfirmButton } from '@/components/confirm';
import { CopyEmail } from '@/components/copy-email';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardTitle } from '@/components/ui/card';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { api, errorMessage, fmtDate, usd } from '@/lib/api';
import { EMAIL_STATUS_TONE, score, type AccountDetail, type FieldSource } from '@/lib/crm';
import { useMe } from '@/lib/me';

export default function AccountPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const router = useRouter();
  const stages = useMe().data?.workspace?.settings.stages ?? [];
  const q = useQuery({
    queryKey: ['account', id],
    queryFn: () => api<AccountDetail>(`/accounts/${id}`),
  });
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['account', id] });
  const run = async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (q.error) return <p className="text-destructive text-sm">{errorMessage(q.error)}</p>;
  if (!q.data) return <p className="text-muted-foreground text-sm">Loading…</p>;
  const { account, company, contacts, deals, activities, nextSteps, signals, fieldSources } =
    q.data;

  const timeline = [
    ...signals.map((s) => ({
      id: s.id,
      at: s.occurredAt,
      label: `${s.stream} · ${s.kind}`,
      body: describeSignal(s.payload),
      url: s.evidenceUrl,
      tone: 'default' as const,
    })),
    ...activities.map((a) => ({
      id: a.id,
      at: a.at,
      label: a.kind.replace('_', ' '),
      body: a.body,
      url: null,
      tone: 'muted' as const,
    })),
  ].sort((a, b) => b.at - a.at);

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{company.name}</h1>
          <a
            href={`https://${company.domain}`}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-muted-foreground text-sm hover:underline"
          >
            {company.domain}
          </a>
          {account.status === 'archived' ? (
            <Badge tone="muted" className="ml-2">
              archived
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <NativeSelect
            aria-label="Stage"
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
          <Button
            variant="outline"
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
            trigger={<Button variant="destructive">Delete</Button>}
            title={`Delete ${company.name}?`}
            description="Deletes the account with its contacts, deals, activities and signals."
            onConfirm={async () => {
              await api(`/accounts/${id}`, { method: 'DELETE' });
              await qc.invalidateQueries({ queryKey: ['accounts'] });
              router.replace('/accounts');
            }}
          />
        </div>
      </div>
      {error ? <p className="text-destructive text-sm">{error}</p> : null}

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardTitle>Scores</CardTitle>
          <div className="mb-3 grid grid-cols-3 gap-2 text-center">
            <Stat label="Priority" value={score(account.priority)} />
            <Stat label="Fit" value={score(account.fitScore)} />
            <Stat label="Intent" value={score(account.intentScore)} />
          </div>
          <Reasons title="Fit" items={account.scoreReasons?.fit} />
          <Reasons title="Intent" items={account.scoreReasons?.intent} />
          <p className="text-muted-foreground mt-2 text-xs">
            Scored {fmtDate(account.scoredAt)} · first source {account.firstSource}
          </p>
        </Card>
        <Card>
          <CardTitle>Firmographics</CardTitle>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <Row
              k="Location"
              v={[company.city, company.state, company.country].filter(Boolean).join(', ')}
            />
            <Row k="Industry" v={company.industry} />
            <Row k="NAICS" v={company.naics} />
            <Row k="Size" v={company.sizeRange} />
            <Row k="Founded" v={company.foundedYear} />
            <Row k="Tech" v={company.tech.join(', ')} />
          </dl>
          <Sources sources={fieldSources.filter((f) => f.entity !== 'contact')} />
        </Card>
        <Card>
          <CardTitle>Next steps</CardTitle>
          <ul className="mb-3 flex flex-col gap-1 text-sm">
            {nextSteps.map((n) => (
              <li key={n.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={n.doneAt !== null}
                  onChange={(e) =>
                    void run(() =>
                      api(`/next-steps/${n.id}`, {
                        method: 'PATCH',
                        body: { done: e.target.checked },
                      }),
                    )
                  }
                  aria-label={`Done: ${n.text}`}
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
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const f = new FormData(form);
              const due = String(f.get('due') ?? '');
              void run(async () => {
                await api(`/accounts/${id}/next-steps`, {
                  method: 'POST',
                  body: {
                    text: String(f.get('text')),
                    ...(due ? { dueAt: new Date(due).getTime() } : {}),
                  },
                });
                form.reset();
              });
            }}
          >
            <Input name="text" placeholder="Next step" required />
            <Input name="due" type="date" className="w-36" />
            <Button type="submit" size="sm" className="h-9">
              Add
            </Button>
          </form>
        </Card>
      </div>

      <Card>
        <div className="flex items-center justify-between">
          <CardTitle>Contacts</CardTitle>
        </div>
        <table className="w-full text-sm">
          <thead className="text-muted-foreground text-left">
            <tr>
              <th className="py-1">Name</th>
              <th>Title</th>
              <th>Email</th>
              <th>Sources</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {contacts.map((c) => (
              <tr key={c.id} className="border-t align-top">
                <td className="py-2">
                  {c.fullName}
                  {c.personaMatch ? (
                    <div className="text-muted-foreground text-xs">persona: {c.personaMatch}</div>
                  ) : null}
                </td>
                <td>{c.title ?? '—'}</td>
                <td>
                  {c.email ? (
                    <div className="flex items-center gap-2">
                      <CopyEmail email={c.email} />
                      {c.emailStatus ? (
                        <Badge tone={EMAIL_STATUS_TONE[c.emailStatus] ?? 'muted'}>
                          {c.emailStatus}
                        </Badge>
                      ) : null}
                    </div>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  <Sources sources={fieldSources.filter((f) => f.entityId === c.id)} compact />
                </td>
                <td className="text-right">
                  {c.email ? (
                    <ConfirmButton
                      trigger={
                        <Button size="xs" variant="ghost">
                          Suppress
                        </Button>
                      }
                      title={`Suppress ${c.email}?`}
                      description="Adds the email to this workspace's suppression list. It disappears from every view and export, and is never enriched again."
                      confirmLabel="Suppress"
                      onConfirm={() =>
                        run(() => api(`/contacts/${c.id}/suppress`, { method: 'POST' }))
                      }
                    />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <AddContact
          onAdd={(body) => run(() => api(`/accounts/${id}/contacts`, { method: 'POST', body }))}
        />
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardTitle>Timeline</CardTitle>
          <LogActivity
            contacts={contacts}
            onLog={(body) => run(() => api(`/accounts/${id}/activities`, { method: 'POST', body }))}
          />
          <ol className="mt-4 flex flex-col gap-3">
            {timeline.map((t) => (
              <li key={t.id} className="border-l-2 pl-3 text-sm">
                <div className="flex items-center gap-2">
                  <Badge tone={t.tone}>{t.label}</Badge>
                  <span className="text-muted-foreground text-xs">{fmtDate(t.at)}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap">{t.body}</p>
                {t.url ? (
                  <a
                    href={t.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-xs underline"
                  >
                    evidence
                  </a>
                ) : null}
              </li>
            ))}
            {timeline.length === 0 ? (
              <li className="text-muted-foreground text-sm">No signals or activities yet.</li>
            ) : null}
          </ol>
        </Card>
        <Card>
          <CardTitle>Deals</CardTitle>
          <ul className="mb-3 flex flex-col gap-2 text-sm">
            {deals.map((d) => (
              <li key={d.id} className="flex items-center gap-2">
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
              </li>
            ))}
          </ul>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const f = new FormData(form);
              const value = String(f.get('value') ?? '');
              void run(async () => {
                await api(`/accounts/${id}/deals`, {
                  method: 'POST',
                  body: {
                    name: String(f.get('name')),
                    ...(value ? { valueUsd: Number(value) } : {}),
                  },
                });
                form.reset();
              });
            }}
          >
            <Input name="name" placeholder="Deal name" required />
            <Input name="value" type="number" min={0} placeholder="USD" className="w-28" />
            <Button type="submit" size="sm" className="h-9">
              Add
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}

function describeSignal(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ['title', 'path', 'reason', 'summary', 'score']) {
    const v = payload[key];
    if (typeof v === 'string' || typeof v === 'number') parts.push(String(v));
  }
  if (Array.isArray(payload.reasons)) parts.push(payload.reasons.join('; '));
  return parts.join(' · ');
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-muted-foreground text-xs">{label}</div>
    </div>
  );
}

function Reasons({ title, items }: { title: string; items: string[] | undefined }) {
  if (!items?.length) return null;
  return (
    <div className="mb-2 text-sm">
      <div className="text-muted-foreground text-xs font-medium">{title} reasons</div>
      <ul className="list-disc pl-5">
        {items.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd>{v === null || v === undefined || v === '' ? '—' : v}</dd>
    </>
  );
}

/** Provenance per field (SPEC §9). */
function Sources({ sources, compact = false }: { sources: FieldSource[]; compact?: boolean }) {
  if (!sources.length) return compact ? <span className="text-muted-foreground">—</span> : null;
  return (
    <ul className={compact ? 'flex flex-col text-xs' : 'mt-3 flex flex-col text-xs'}>
      {sources.map((s) => (
        <li key={s.id} className="text-muted-foreground">
          <span className="font-mono">{s.field}</span> ←{' '}
          {s.url ? (
            <a
              href={s.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="underline"
            >
              {s.source}
            </a>
          ) : (
            s.source
          )}{' '}
          ({Math.round(s.confidence * 100)}%, {new Date(s.fetchedAt).toLocaleDateString()})
        </li>
      ))}
    </ul>
  );
}

function AddContact({ onAdd }: { onAdd: (body: Record<string, string>) => Promise<unknown> }) {
  return (
    <form
      className="mt-3 flex flex-wrap gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const f = new FormData(form);
        const body: Record<string, string> = {};
        for (const k of ['fullName', 'title', 'email', 'phone']) {
          const v = String(f.get(k) ?? '').trim();
          if (v) body[k] = v;
        }
        void onAdd(body).then(() => form.reset());
      }}
    >
      <Input name="fullName" placeholder="Full name" required className="w-48" />
      <Input name="title" placeholder="Title" className="w-48" />
      <Input name="email" type="email" placeholder="Email" className="w-56" />
      <Input name="phone" placeholder="Phone" className="w-36" />
      <Button type="submit" size="sm" className="h-9">
        Add contact
      </Button>
    </form>
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
        <NativeSelect name="kind" defaultValue="note" aria-label="Activity kind">
          <option value="note">Note</option>
          <option value="email">Email</option>
          <option value="call">Call</option>
          <option value="meeting">Meeting</option>
          <option value="reply">Reply</option>
        </NativeSelect>
        <NativeSelect name="contactId" defaultValue="" aria-label="Contact">
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
        Log activity
      </Button>
    </form>
  );
}
