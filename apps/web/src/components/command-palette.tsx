'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface SearchResult {
  accounts: { id: string; name: string; domain: string; priority: number; stage: string }[];
  contacts: {
    id: string;
    fullName: string;
    title: string | null;
    accountId: string;
    company: string;
  }[];
  offers: { id: string; name: string; websiteUrl: string }[];
}

const COMMANDS: { label: string; href: string; keys?: string }[] = [
  { label: 'Go to Today', href: '/', keys: 'G T' },
  { label: 'Go to Accounts', href: '/accounts', keys: 'G A' },
  { label: 'Go to Pipeline', href: '/pipeline', keys: 'G P' },
  { label: 'Go to Offer profile', href: '/offer', keys: 'G O' },
  { label: 'Go to ROI', href: '/roi', keys: 'G R' },
  { label: 'Go to Settings', href: '/settings', keys: 'G S' },
  { label: 'Contacts', href: '/contacts' },
  { label: 'Import or export CSV', href: '/data' },
  { label: 'Suppression list', href: '/settings?tab=suppression' },
  { label: 'Provider keys', href: '/settings?tab=keys' },
  { label: 'Budget settings', href: '/settings?tab=budget' },
  { label: 'API tokens', href: '/settings?tab=tokens' },
  { label: 'Audit log', href: '/settings/audit' },
];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** ⌘K: search records and run commands (docs/ui.md §2, CommandPalette). */
export function CommandPalette({
  open,
  onOpenChange,
  onOpenAccount,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenAccount: (id: string) => void;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.trim(), 150);
  const results = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api<SearchResult>(`/search?q=${encodeURIComponent(debounced)}`),
    enabled: open && debounced.length > 0,
  });
  const go = (fn: () => void) => {
    onOpenChange(false);
    setQ('');
    fn();
  };
  const commands = COMMANDS.filter((c) => !q || c.label.toLowerCase().includes(q.toLowerCase()));

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setQ('');
      }}
      label="Command palette"
      shouldFilter={false}
      overlayClassName="fixed inset-0 z-50 bg-black/30"
      contentClassName="bg-popover fixed top-[15%] left-1/2 z-50 w-full max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border shadow-2xl"
    >
      <Command.Input
        value={q}
        onValueChange={setQ}
        placeholder="Search accounts, contacts, offers… or type a command"
        className="w-full border-b bg-transparent px-4 py-3 text-sm outline-none"
      />
      <Command.List className="max-h-96 overflow-y-auto p-2 text-sm">
        <Command.Empty className="text-muted-foreground px-2 py-3">
          {results.isFetching ? 'Searching…' : 'No results.'}
        </Command.Empty>
        {results.data?.accounts.length ? (
          <Command.Group
            heading="Accounts"
            className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:text-xs"
          >
            {results.data.accounts.map((a) => (
              <Command.Item
                key={a.id}
                value={`acc-${a.id}`}
                onSelect={() => go(() => onOpenAccount(a.id))}
                className="data-[selected=true]:bg-accent flex cursor-pointer items-center gap-2 rounded px-2 py-1.5"
              >
                <span className="w-7 text-right tabular-nums">{Math.round(a.priority)}</span>
                <span className="font-medium">{a.name}</span>
                <span className="text-muted-foreground">{a.domain}</span>
                <span className="text-muted-foreground ml-auto text-xs">{a.stage}</span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
        {results.data?.contacts.length ? (
          <Command.Group
            heading="Contacts"
            className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:text-xs"
          >
            {results.data.contacts.map((c) => (
              <Command.Item
                key={c.id}
                value={`con-${c.id}`}
                onSelect={() => go(() => onOpenAccount(c.accountId))}
                className="data-[selected=true]:bg-accent flex cursor-pointer gap-2 rounded px-2 py-1.5"
              >
                <span className="font-medium">{c.fullName}</span>
                <span className="text-muted-foreground">
                  {[c.title, c.company].filter(Boolean).join(' · ')}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
        {results.data?.offers.length ? (
          <Command.Group
            heading="Offers"
            className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:text-xs"
          >
            {results.data.offers.map((o) => (
              <Command.Item
                key={o.id}
                value={`off-${o.id}`}
                onSelect={() => go(() => router.push(`/offer/${o.id}`))}
                className="data-[selected=true]:bg-accent flex cursor-pointer gap-2 rounded px-2 py-1.5"
              >
                <span className="font-medium">{o.name || o.websiteUrl}</span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
        {commands.length ? (
          <Command.Group
            heading="Commands"
            className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:text-xs"
          >
            {commands.map((c) => (
              <Command.Item
                key={c.href}
                value={`cmd-${c.href}`}
                onSelect={() => go(() => router.push(c.href))}
                className="data-[selected=true]:bg-accent flex cursor-pointer items-center rounded px-2 py-1.5"
              >
                {c.label}
                {c.keys ? (
                  <kbd className="text-muted-foreground ml-auto text-xs">{c.keys}</kbd>
                ) : null}
              </Command.Item>
            ))}
            <Command.Item
              value="cmd-signout"
              onSelect={() =>
                go(async () => {
                  await api('/auth/logout', { method: 'POST' });
                  qc.clear();
                  router.replace('/login');
                })
              }
              className="data-[selected=true]:bg-accent flex cursor-pointer rounded px-2 py-1.5"
            >
              Sign out
            </Command.Item>
          </Command.Group>
        ) : null}
      </Command.List>
    </Command.Dialog>
  );
}
