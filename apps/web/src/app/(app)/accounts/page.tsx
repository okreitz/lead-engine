'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/card';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { Input, Label, NativeSelect } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { score, type AccountRow } from '@/lib/crm';
import { useMe } from '@/lib/me';

export default function AccountsPage() {
  const stages = useMe().data?.workspace?.settings.stages ?? [];
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('');
  const [stream, setStream] = useState('');
  const [minFit, setMinFit] = useState('');
  const [sort, setSort] = useState('priority');
  const params = new URLSearchParams({ sort });
  if (q) params.set('q', q);
  if (stage) params.set('stage', stage);
  if (stream) params.set('stream', stream);
  if (minFit) params.set('minFit', minFit);
  const list = useQuery({
    queryKey: ['accounts', params.toString()],
    queryFn: () => api<AccountRow[]>(`/accounts?${params}`),
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link href="/data">Import / export</Link>
          </Button>
          <NewAccount />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input
          placeholder="Search name or domain"
          className="w-64"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <NativeSelect value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Stage">
          <option value="">All stages</option>
          {stages.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </NativeSelect>
        <NativeSelect
          value={stream}
          onChange={(e) => setStream(e.target.value)}
          aria-label="Stream"
        >
          <option value="">All streams</option>
          <option value="personas">Persona fit</option>
          <option value="visits">Website visits</option>
          <option value="conversations">Conversations</option>
          <option value="manual">Manual</option>
        </NativeSelect>
        <Input
          type="number"
          min={0}
          max={100}
          placeholder="Min fit"
          className="w-28"
          value={minFit}
          onChange={(e) => setMinFit(e.target.value)}
        />
        <NativeSelect value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
          <option value="priority">Priority</option>
          <option value="fit">Fit</option>
          <option value="intent">Intent</option>
          <option value="updated">Recently updated</option>
          <option value="name">Name</option>
        </NativeSelect>
      </div>
      <table className="w-full text-sm">
        <thead className="text-muted-foreground text-left">
          <tr>
            <th className="py-2">Company</th>
            <th>Stage</th>
            <th className="text-right">Priority</th>
            <th className="text-right">Fit</th>
            <th className="text-right">Intent</th>
            <th>Source</th>
            <th>Industry</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {list.data?.map((a) => (
            <tr key={a.id} className="hover:bg-muted/40 border-t">
              <td className="py-2">
                <Link href={`/accounts/${a.id}`} className="font-medium hover:underline">
                  {a.name}
                </Link>
                <div className="text-muted-foreground text-xs">{a.domain}</div>
              </td>
              <td>
                <Badge tone="muted">{a.stage}</Badge>
              </td>
              <td className="text-right font-medium">{score(a.priority)}</td>
              <td className="text-right">{score(a.fitScore)}</td>
              <td className="text-right">{score(a.intentScore)}</td>
              <td>{a.firstSource}</td>
              <td className="max-w-48 truncate">{a.industry ?? '—'}</td>
              <td>{a.state ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.data?.length === 0 ? (
        <p className="text-muted-foreground text-sm">No accounts match.</p>
      ) : null}
    </div>
  );
}

function NewAccount() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Add account</Button>
      </DialogTrigger>
      <DialogContent title="Add account" description="US companies only.">
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const get = (k: string) => String(f.get(k) ?? '').trim() || undefined;
            try {
              setError(null);
              await api('/accounts', {
                method: 'POST',
                body: {
                  domain: get('domain'),
                  name: get('name'),
                  country: 'US',
                  state: get('state'),
                  city: get('city'),
                  industry: get('industry'),
                  sizeRange: get('sizeRange'),
                },
              });
              await qc.invalidateQueries({ queryKey: ['accounts'] });
              setOpen(false);
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        >
          <Label>
            Domain
            <Input name="domain" placeholder="acme.com" required />
          </Label>
          <Label>
            Name
            <Input name="name" required />
          </Label>
          <div className="grid grid-cols-2 gap-3">
            <Label>
              State
              <Input name="state" placeholder="CA" />
            </Label>
            <Label>
              City
              <Input name="city" />
            </Label>
            <Label>
              Industry
              <Input name="industry" />
            </Label>
            <Label>
              Size
              <Input name="sizeRange" placeholder="11-50" />
            </Label>
          </div>
          <p className="text-muted-foreground text-xs">Country: United States</p>
          {error ? <p className="text-destructive text-sm">{error}</p> : null}
          <Button type="submit">Add</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
