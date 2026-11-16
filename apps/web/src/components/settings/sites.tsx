'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { helpFor } from '@le/shared';
import { KeyHelp } from '@/components/blocks/key-help';
import { EmptyState, SkeletonRows } from '@/components/blocks/empty-state';
import { ConfirmButton } from '@/components/confirm';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardTitle } from '@/components/ui/card';
import { Input, Label, Textarea } from '@/components/ui/input';
import { api, errorMessage, fmtDate } from '@/lib/api';
import { fetchSites, type CollectorStatus, type IntentPage, type Site } from '@/lib/visitors';

/** Settings → Sites & snippet (docs/ui.md §3.9): domain, snippet, install check, intent pages. */
export function SitesSettings({ owner }: { owner: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sites'], queryFn: fetchSites });
  const [domain, setDomain] = useState('');
  const add = useMutation({
    mutationFn: (d: string) => api<Site>('/sites', { method: 'POST', body: { domain: d } }),
    onSuccess: async () => {
      setDomain('');
      await qc.invalidateQueries({ queryKey: ['sites'] });
    },
  });

  return (
    <div className="flex flex-col gap-4">
      {q.data ? <CollectorNotes status={q.data.status} /> : null}
      {owner ? (
        <Card>
          <CardTitle>Add a site</CardTitle>
          <form
            className="flex items-end gap-2"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (domain.trim()) add.mutate(domain.trim());
            }}
          >
            <Label className="flex-1">
              <span>Domain</span>
              <Input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="andhuman.com"
                autoComplete="off"
              />
            </Label>
            <Button type="submit" disabled={add.isPending || !domain.trim()}>
              Add site
            </Button>
          </form>
          {add.error ? (
            <p className="text-destructive mt-2 text-sm">{errorMessage(add.error)}</p>
          ) : null}
          <p className="text-muted-foreground mt-2 text-xs">
            Subdomains (www., shop., …) are covered. Before installing, add the paragraph from
            docs/privacy-snippet.md to the site&apos;s privacy policy.
          </p>
        </Card>
      ) : null}
      {q.isLoading ? <SkeletonRows rows={3} /> : null}
      {q.data && q.data.sites.length === 0 ? (
        <EmptyState title="No sites yet">
          Add the domain of a website you own, then paste the snippet before &lt;/body&gt;.
        </EmptyState>
      ) : null}
      {q.data?.sites.map((s) => (
        <SiteCard key={s.id} site={s} owner={owner} />
      ))}
    </div>
  );
}

function CollectorNotes({ status }: { status: CollectorStatus }) {
  const ipapi = helpFor('ipapi');
  return (
    <Card>
      <CardTitle>Collector</CardTitle>
      <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Public URL</dt>
        <dd className="font-mono text-xs">{status.collectorUrl}</dd>
        <dt className="text-muted-foreground">Country/ASN database</dt>
        <dd>
          {status.geo.ready ? (
            <Badge tone="ok">
              {status.geo.source === 'ipinfo' ? 'IPinfo Lite' : 'DB-IP Lite'} · updated{' '}
              {fmtDate(status.geo.updatedAt)}
            </Badge>
          ) : (
            <Badge tone="warn">Not loaded: every visit is dropped until it is</Badge>
          )}
          {status.geo.error ? (
            <span className="text-muted-foreground block text-xs">{status.geo.error}</span>
          ) : null}
        </dd>
        <dt className="text-muted-foreground">ipapi.is key</dt>
        <dd>
          {status.ipapiKey ? (
            <Badge tone="ok">Saved</Badge>
          ) : (
            <span className="flex flex-col gap-1">
              <Badge tone="warn" className="w-fit">
                Missing: business visits stay unclassified
              </Badge>
              {ipapi ? <KeyHelp help={ipapi} /> : null}
              <a href="/settings?tab=keys" className="text-xs underline underline-offset-2">
                Add it under Provider keys
              </a>
            </span>
          )}
        </dd>
      </dl>
    </Card>
  );
}

function SiteCard({ site, owner }: { site: Site; owner: boolean }) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const check = useMutation({
    mutationFn: () => api<Site>(`/sites/${site.id}/check`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sites'] }),
  });

  return (
    <Card>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{site.domain}</h2>
          <p className="text-muted-foreground text-xs">
            Site key <span className="font-mono">{site.siteKey}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {site.receiving ? (
            <Badge tone="ok">Receiving events</Badge>
          ) : site.lastEventAt ? (
            <Badge tone="warn">Last event {fmtDate(site.lastEventAt)}</Badge>
          ) : (
            <Badge tone="muted">No events yet</Badge>
          )}
        </div>
      </div>

      <Label>
        <span>Snippet: paste before &lt;/body&gt; on every page</span>
        <Textarea readOnly value={site.snippet} rows={3} className="font-mono text-xs" />
      </Label>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await navigator.clipboard.writeText(site.snippet);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied' : 'Copy snippet'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={check.isPending}
          onClick={() => check.mutate()}
        >
          {check.isPending ? 'Checking…' : 'Check install'}
        </Button>
        {site.check ? (
          <span className="text-sm">
            <Badge tone={site.check.ok ? 'ok' : 'warn'}>
              {site.check.ok ? 'Installed' : 'Not found'}
            </Badge>{' '}
            <span className="text-muted-foreground text-xs">
              {site.check.note} ({fmtDate(site.check.at)})
            </span>
          </span>
        ) : null}
        {check.error ? (
          <span className="text-destructive text-sm">{errorMessage(check.error)}</span>
        ) : null}
      </div>
      <p className="text-muted-foreground mt-2 text-xs">
        Form identification: call <code>window.leIdentify(email)</code> in the browser when a form
        is submitted. Only the email&apos;s domain is sent; free-mail domains are ignored.
      </p>

      <IntentPages site={site} owner={owner} />

      {owner ? (
        <div className="mt-4 flex justify-end">
          <ConfirmButton
            trigger={
              <Button size="sm" variant="ghost">
                Delete site
              </Button>
            }
            title={`Delete ${site.domain}?`}
            description="Deletes the site with its visits and daily counters. Accounts and their other signals stay. Remove the snippet from the site too."
            typeToConfirm={site.domain}
            onConfirm={async () => {
              await api(`/sites/${site.id}`, { method: 'DELETE' });
              await qc.invalidateQueries({ queryKey: ['sites'] });
            }}
          />
        </div>
      ) : null}
    </Card>
  );
}

function IntentPages({ site, owner }: { site: Site; owner: boolean }) {
  const qc = useQueryClient();
  const [pages, setPages] = useState<IntentPage[]>(site.intentPages);
  const [path, setPath] = useState('');
  const [label, setLabel] = useState('');
  const save = useMutation({
    mutationFn: (next: IntentPage[]) =>
      api<Site>(`/sites/${site.id}`, { method: 'PATCH', body: { intentPages: next } }),
    onSuccess: async (s) => {
      setPages(s.intentPages);
      await qc.invalidateQueries({ queryKey: ['sites'] });
    },
  });
  const commit = (next: IntentPage[]) => {
    setPages(next);
    save.mutate(next);
  };
  return (
    <div className="mt-4">
      <h3 className="mb-1 text-sm font-semibold">Intent pages</h3>
      <p className="text-muted-foreground mb-2 text-xs">
        Visits to these paths (and pages under them) weigh 3× a normal visit and are tagged on the
        Visitors page.
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {pages.map((p) => (
          <li key={p.path} className="bg-muted flex items-center gap-1 rounded px-2 py-0.5 text-xs">
            <span className="font-mono">{p.path}</span>
            <span className="text-muted-foreground">· {p.label}</span>
            {owner ? (
              <button
                type="button"
                className="hover:text-destructive ml-1"
                aria-label={`Remove ${p.path}`}
                onClick={() => commit(pages.filter((x) => x.path !== p.path))}
              >
                ×
              </button>
            ) : null}
          </li>
        ))}
        {pages.length === 0 ? <li className="text-muted-foreground text-xs">None</li> : null}
      </ul>
      {owner ? (
        <form
          className="mt-2 flex items-end gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            const p = path.trim().startsWith('/') ? path.trim() : `/${path.trim()}`;
            if (!path.trim() || !label.trim()) return;
            commit([...pages, { path: p, label: label.trim().toLowerCase() }]);
            setPath('');
            setLabel('');
          }}
        >
          <Input
            className="w-48"
            placeholder="/book-a-call"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            aria-label="Intent page path"
          />
          <Input
            className="w-32"
            placeholder="demo"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-label="Intent page label"
          />
          <Button size="sm" variant="outline" type="submit" disabled={save.isPending}>
            Add
          </Button>
        </form>
      ) : null}
      {save.error ? (
        <p className="text-destructive mt-1 text-xs">{errorMessage(save.error)}</p>
      ) : null}
    </div>
  );
}
