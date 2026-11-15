'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { helpFor } from '@le/shared';
import { KeyHelp } from '@/components/blocks/key-help';
import { ConfirmButton } from '@/components/confirm';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardTitle } from '@/components/ui/card';
import { Input, Label, NativeSelect } from '@/components/ui/input';
import { api, errorMessage, fmtDate } from '@/lib/api';

interface ImportRow {
  id: string;
  source: string;
  url: string | null;
  fileName: string;
  state: string;
  filter: { industries: string[]; states: string[]; employeeRange: string | null } | null;
  bytesTotal: number | null;
  bytesDone: number;
  rowsRead: number;
  rowsKept: number;
  rowsInserted: number;
  rowsUpdated: number;
  dropped: Record<string, number>;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}
interface Universe {
  companies: number;
  publicCompanies: number;
  hasIcp: boolean;
  sources: {
    id: string;
    label: string;
    licence: string;
    homepage: string;
    attribution: string;
    fixedUrl: string | null;
    icpFilter: boolean;
    unavailable: string | null;
  }[];
  files: { name: string; bytes: number }[];
  imports: ImportRow[];
}

const ACTIVE = ['queued', 'downloading', 'processing'];
const mb = (n: number) => `${(n / 1048576).toFixed(n > 1048576 * 10 ? 0 : 1)} MB`;
const int = (n: number) => n.toLocaleString();
const DROP_LABELS: Record<string, string> = {
  not_us: 'not US',
  no_website: 'no website',
  icp: 'outside ICP',
  invalid: 'unreadable',
  no_match: 'no name match',
  ambiguous: 'ambiguous name',
};

/**
 * Settings → Company data: the company universe import (SPEC §5.1 step 1). It runs on the
 * server as a resumable job; this tab starts it and shows progress.
 */
export function CompanyData({ disabled }: { disabled: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['universe'],
    queryFn: () => api<Universe>('/universe'),
    refetchInterval: (query) =>
      query.state.data?.imports.some((i) => ACTIVE.includes(i.state)) ? 2_000 : false,
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'pause' | 'resume' }) =>
      api(`/universe/imports/${id}/${action}`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['universe'] }),
  });
  const u = q.data;
  if (!u) return <p className="text-muted-foreground text-sm">Loading…</p>;
  const running = u.imports.some((i) => ACTIVE.includes(i.state));
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle>Company universe</CardTitle>
        <p className="text-sm">
          <strong>{int(u.companies)}</strong> US companies with a website from public datasets
          {u.publicCompanies ? `, ${int(u.publicCompanies)} of them public (SEC EDGAR)` : ''}.
          &ldquo;Find matching companies&rdquo; searches these.
        </p>
        <p className="text-muted-foreground mt-2 text-xs">
          Imports run on the server, a slice at a time, so the app stays responsive. They resume
          after a restart. Non-US companies and rows without a website are dropped while reading;
          nothing LinkedIn-derived is stored.
        </p>
      </Card>
      {disabled ? null : <StartImport u={u} running={running} />}
      <Card>
        <CardTitle>Imports</CardTitle>
        {u.imports.length === 0 ? (
          <p className="text-muted-foreground text-sm">No imports yet.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {u.imports.map((i) => (
              <li key={i.id} className="flex flex-col gap-1 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {u.sources.find((s) => s.id === i.source)?.label ?? i.source}
                  </span>
                  <Badge>{i.state}</Badge>
                  <span className="text-muted-foreground text-xs">
                    {fmtDate(i.createdAt)} · {i.url ?? i.fileName} ·{' '}
                    {i.filter ? 'ICP subset' : 'all US companies'}
                  </span>
                </div>
                <Progress row={i} />
                <p className="text-muted-foreground text-xs">
                  {int(i.rowsRead)} rows read · {int(i.rowsInserted)} new · {int(i.rowsUpdated)}{' '}
                  updated
                  {Object.entries(i.dropped).map(([k, v]) => ` · ${int(v)} ${DROP_LABELS[k] ?? k}`)}
                </p>
                {i.error ? <p className="text-destructive text-xs">{i.error}</p> : null}
                {disabled ? null : (
                  <div className="flex gap-2">
                    {ACTIVE.includes(i.state) ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => act.mutate({ id: i.id, action: 'pause' })}
                      >
                        Pause
                      </Button>
                    ) : null}
                    {i.state === 'paused' || i.state === 'failed' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={running}
                        onClick={() => act.mutate({ id: i.id, action: 'resume' })}
                      >
                        Resume
                      </Button>
                    ) : null}
                    {i.state !== 'done' && i.state !== 'cancelled' ? (
                      <ConfirmButton
                        trigger={
                          <Button size="sm" variant="ghost">
                            Cancel
                          </Button>
                        }
                        title="Cancel this import?"
                        description="Companies already imported stay. A downloaded file is deleted; you would download it again to restart."
                        confirmLabel="Cancel import"
                        onConfirm={async () => {
                          await api(`/universe/imports/${i.id}`, { method: 'DELETE' });
                          await qc.invalidateQueries({ queryKey: ['universe'] });
                        }}
                      />
                    ) : null}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {act.error ? (
          <p className="text-destructive mt-2 text-sm">{errorMessage(act.error)}</p>
        ) : null}
      </Card>
      <Card>
        <CardTitle>Sources and licences</CardTitle>
        <ul className="flex flex-col gap-2 text-sm">
          {u.sources.map((s) => (
            <li key={s.id}>
              <a
                href={s.homepage}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-4 hover:underline"
              >
                {s.label}
              </a>{' '}
              <span className="text-muted-foreground">· {s.licence}</span>
              <p className="text-muted-foreground text-xs">{s.attribution}</p>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function Progress({ row }: { row: ImportRow }) {
  const downloading = row.state === 'downloading' || (row.state === 'queued' && row.url);
  if (downloading) {
    const share = row.bytesTotal ? row.bytesDone / row.bytesTotal : null;
    return (
      <div className="flex items-center gap-2">
        <progress
          className="h-2 w-64"
          max={1}
          {...(share !== null ? { value: share } : {})}
          aria-label="Download progress"
        />
        <span className="text-muted-foreground text-xs">
          Downloading {mb(row.bytesDone)}
          {row.bytesTotal ? ` of ${mb(row.bytesTotal)}` : ''}
        </span>
      </div>
    );
  }
  if (row.state === 'processing')
    return (
      <div className="flex items-center gap-2">
        <progress className="h-2 w-64" aria-label="Import progress" />
        <span className="text-muted-foreground text-xs">Reading rows…</span>
      </div>
    );
  return null;
}

function StartImport({ u, running }: { u: Universe; running: boolean }) {
  const qc = useQueryClient();
  const [source, setSource] = useState(u.sources[0]?.id ?? 'pdl');
  const [mode, setMode] = useState<'url' | 'file'>('url');
  const [filter, setFilter] = useState<'icp' | 'all'>(u.hasIcp ? 'icp' : 'all');
  const def = u.sources.find((s) => s.id === source);
  const start = useMutation({
    mutationFn: (body: unknown) => api('/universe/imports', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['universe'] }),
  });
  return (
    <Card>
      <CardTitle>Import companies</CardTitle>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          start.mutate({
            source,
            ...(def?.fixedUrl
              ? {}
              : mode === 'url'
                ? { url: String(f.get('url') ?? '') }
                : { file: String(f.get('file') ?? '') }),
            filter,
          });
        }}
      >
        <Label className="max-w-sm">
          Dataset
          <NativeSelect value={source} onChange={(e) => setSource(e.target.value)}>
            {u.sources.map((s) => (
              <option key={s.id} value={s.id} disabled={!!s.unavailable}>
                {s.label}
                {s.unavailable ? ' (not configured)' : ''}
              </option>
            ))}
          </NativeSelect>
        </Label>
        {def?.unavailable ? (
          <p className="text-muted-foreground text-sm">To enable: {def.unavailable}.</p>
        ) : null}
        {source === 'sec-edgar' && helpFor('sec-user-agent') ? (
          <KeyHelp help={helpFor('sec-user-agent')!} />
        ) : null}
        {source === 'pdl' && helpFor('pdl') ? <KeyHelp help={helpFor('pdl')!} /> : null}
        {def?.fixedUrl ? (
          <p className="text-muted-foreground text-sm">
            Downloads {def.fixedUrl} and tags matching companies with their SEC CIK and ticker
            (EDGAR has no websites, so it only adds to companies another dataset provided).
          </p>
        ) : (
          <>
            <p className="text-muted-foreground text-sm">
              PDL has no fixed download URL: request the US file on{' '}
              <a className="underline" href={def?.homepage} target="_blank" rel="noreferrer">
                their download page
              </a>{' '}
              and paste the link they send, or copy the file into the server&rsquo;s{' '}
              <code>/data/imports</code> folder. ZIP, gzip, CSV and JSON lines all work.
            </p>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-1">
                <input type="radio" checked={mode === 'url'} onChange={() => setMode('url')} />
                Download link
              </label>
              <label className="flex items-center gap-1">
                <input type="radio" checked={mode === 'file'} onChange={() => setMode('file')} />
                File on the server
              </label>
            </div>
            {mode === 'url' ? (
              <Label>
                Download link (https)
                <Input name="url" type="url" required placeholder="https://…" />
              </Label>
            ) : (
              <Label className="max-w-sm">
                File in /data/imports
                <NativeSelect name="file" required>
                  {u.files.length === 0 ? <option value="">No files found</option> : null}
                  {u.files.map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.name} ({mb(f.bytes)})
                    </option>
                  ))}
                </NativeSelect>
              </Label>
            )}
            <fieldset className="flex flex-col gap-1 text-sm">
              <legend className="mb-1 font-medium">Which companies</legend>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  disabled={!u.hasIcp}
                  checked={filter === 'icp'}
                  onChange={() => setFilter('icp')}
                />
                Only those that may fit the approved ICP (industry, size, state){' '}
                {u.hasIcp ? '(recommended: smaller database)' : '— approve an offer profile first'}
              </label>
              <label className="flex items-center gap-1">
                <input type="radio" checked={filter === 'all'} onChange={() => setFilter('all')} />
                All US companies with a website (several million rows; takes hours)
              </label>
            </fieldset>
          </>
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={running || !!def?.unavailable || start.isPending}>
            Start import
          </Button>
          <span className="text-muted-foreground text-xs">
            Free: public datasets, no paid calls.
          </span>
        </div>
        {running ? <p className="text-muted-foreground text-xs">An import is running.</p> : null}
        {start.error ? (
          <p className="text-destructive text-sm">{errorMessage(start.error)}</p>
        ) : null}
      </form>
    </Card>
  );
}
