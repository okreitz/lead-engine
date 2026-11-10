'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { AccountsTable } from '@/components/accounts-table';
import { EmptyState, SkeletonRows } from '@/components/blocks/empty-state';
import { ConfirmButton } from '@/components/confirm';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Popover } from '@/components/ui/popover';
import { ViewBar } from '@/components/view-bar';
import { api, errorMessage } from '@/lib/api';
import type { AccountRow } from '@/lib/crm';
import { useKeys } from '@/lib/keys';
import { useMe } from '@/lib/me';
import { useSheet } from '@/lib/sheet';
import { apiQuery, useViewState } from '@/lib/views';

export default function AccountsPage() {
  return (
    <Suspense fallback={<SkeletonRows rows={8} />}>
      <Accounts />
    </Suspense>
  );
}

/**
 * Accounts (docs/ui.md §3.2): saved-view tabs, filter chips, a virtualized table with the
 * priority cell, a bulk bar on selection, and J/K/X/Space/Enter/S keys. View state is in the URL.
 */
function Accounts() {
  const qc = useQueryClient();
  const router = useRouter();
  const sheet = useSheet();
  const stages = useMe().data?.workspace?.settings.stages ?? [];
  const { state, set, views } = useViewState();
  const query = apiQuery(state);
  const list = useQuery({
    queryKey: ['accounts', query],
    queryFn: () => api<AccountRow[]>(`/accounts?limit=5000&${query}`),
    placeholderData: (prev) => prev,
  });
  const rows = useMemo(() => list.data ?? [], [list.data]);
  const [rawSelected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(-1);
  const [stageMenu, setStageMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only selections still in the list count (filters can hide selected rows).
  const rowIds = new Set(rows.map((r) => r.id));
  const selected = new Set([...rawSelected].filter((id) => rowIds.has(id)));

  const targetIds = () =>
    selected.size ? [...selected] : cursor >= 0 && rows[cursor] ? [rows[cursor]!.id] : [];

  async function bulk(action: 'stage' | 'archive' | 'suppress', stage?: string) {
    const ids = targetIds();
    if (!ids.length) return;
    try {
      setError(null);
      await api('/accounts/bulk', {
        method: 'POST',
        body: { ids, action, ...(stage ? { stage } : {}) },
      });
      setSelected(new Set());
      await qc.invalidateQueries({ queryKey: ['accounts'] });
      await qc.invalidateQueries({ queryKey: ['pipeline'] });
      await qc.invalidateQueries({ queryKey: ['today'] });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  useKeys({
    j: () => setCursor((c) => Math.min(rows.length - 1, c + 1)),
    k: () => setCursor((c) => Math.max(0, c - 1)),
    x: () => {
      const r = rows[cursor];
      if (!r) return;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(r.id)) next.delete(r.id);
        else next.add(r.id);
        return next;
      });
    },
    ' ': () => {
      const r = rows[cursor];
      if (r) sheet.open(r.id);
    },
    Enter: () => {
      const r = rows[cursor];
      if (r) router.push(`/accounts/${r.id}`);
    },
    s: () => {
      if (targetIds().length) setStageMenu(true);
    },
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href="/data">Import / export</Link>
          </Button>
          <NewAccount />
        </div>
      </div>
      <ViewBar state={state} set={set} views={views.data ?? []} />

      {selected.size || stageMenu ? (
        <div
          className="bg-foreground text-background flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-sm"
          role="toolbar"
          aria-label="Bulk actions"
        >
          <span className="font-medium">{selected.size || 1} selected</span>
          <Popover
            open={stageMenu}
            onOpenChange={setStageMenu}
            trigger={
              <Button size="sm" variant="secondary">
                Set stage ▾ <kbd className="text-xs opacity-60">S</kbd>
              </Button>
            }
          >
            <div className="flex flex-col">
              {stages.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="hover:bg-accent rounded px-2 py-1 text-left"
                  onClick={() => {
                    setStageMenu(false);
                    void bulk('stage', s);
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </Popover>
          <Button size="sm" variant="secondary" onClick={() => void bulk('archive')}>
            Archive
          </Button>
          <ConfirmButton
            trigger={
              <Button size="sm" variant="secondary">
                Suppress
              </Button>
            }
            title={`Suppress ${selected.size || 1} account domain${selected.size === 1 ? '' : 's'}?`}
            description="Adds each company's domain to the suppression list. The accounts, their contacts and deals disappear from every view and export, and are never enriched again."
            confirmLabel="Suppress"
            onConfirm={() => bulk('suppress')}
          />
          <Button size="sm" variant="secondary" asChild>
            <a href={`/api/v1/export/accounts.csv?ids=${targetIds().join(',')}`} download>
              Export CSV
            </a>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-background ml-auto"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
        </div>
      ) : null}
      {error ? <p className="text-destructive text-sm">{error}</p> : null}

      {!list.data ? (
        <SkeletonRows rows={10} />
      ) : rows.length === 0 ? (
        state.view !== 'all' ||
        state.q ||
        state.stage.length ||
        state.stream.length ||
        state.fit ||
        state.intent ? (
          <EmptyState
            title="No accounts match these filters"
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  set({ view: 'all', q: '', stage: [], stream: [], fit: '', intent: '' })
                }
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState title="No accounts yet" next="Import accounts from CSV" href="/data">
            Or add one with &ldquo;Add account&rdquo;. Persona fit (Phase 2) will create accounts
            from your approved offer profile.
          </EmptyState>
        )
      ) : (
        <AccountsTable
          rows={rows}
          columns={state.cols}
          selected={selected}
          onToggle={(id) =>
            setSelected((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onToggleAll={(all) => setSelected(all ? new Set(rows.map((r) => r.id)) : new Set())}
          cursor={cursor}
          onCursor={setCursor}
          onPreview={(id) => sheet.open(id)}
          onOpen={(id) => router.push(`/accounts/${id}`)}
        />
      )}
      <p className="text-muted-foreground text-xs">
        <kbd>J</kbd>/<kbd>K</kbd> move · <kbd>X</kbd> select · <kbd>Space</kbd> preview ·{' '}
        <kbd>Enter</kbd> open · <kbd>S</kbd> set stage
      </p>
    </div>
  );
}

/** Inline (non-modal) add-account form; US companies only. */
function NewAccount() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      className="w-80"
      trigger={<Button size="sm">Add account</Button>}
    >
      <form
        className="flex flex-col gap-2"
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
          <Input name="domain" placeholder="acme.com" required autoFocus />
        </Label>
        <Label>
          Name
          <Input name="name" required />
        </Label>
        <div className="grid grid-cols-3 gap-2">
          <Label>
            State
            <Input name="state" placeholder="TX" maxLength={2} />
          </Label>
          <Label className="col-span-2">
            Industry
            <Input name="industry" />
          </Label>
        </div>
        <Label>
          Size
          <Input name="sizeRange" placeholder="51-200" />
        </Label>
        <p className="text-muted-foreground text-xs">US companies only.</p>
        {error ? <p className="text-destructive text-xs">{error}</p> : null}
        <Button type="submit" size="sm">
          Add
        </Button>
      </form>
    </Popover>
  );
}
