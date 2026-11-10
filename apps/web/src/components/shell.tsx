'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronsLeft,
  ChevronsRight,
  CircleDollarSign,
  FileText,
  Inbox,
  KanbanSquare,
  LayoutList,
  LogOut,
  Radar,
  Search,
  Settings,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { BudgetBanner } from '@/components/budget';
import { CommandPalette } from '@/components/command-palette';
import { RecordSheet } from '@/components/record-sheet';
import { ShortcutSheet } from '@/components/shortcut-sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TooltipProvider } from '@/components/ui/tooltip';
import { api, errorMessage } from '@/lib/api';
import { GO_TO, isTyping } from '@/lib/keys';
import { useMe } from '@/lib/me';
import { useSheet } from '@/lib/sheet';
import { useSavedViews } from '@/lib/views';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown dimmed with a phase label until the stream exists. */
  comingIn?: string;
  badge?: string | null;
}

/** Stream presets pinned under Accounts (docs/ui.md §2, §3.2). */
export const PINNED_VIEWS = [
  { key: 'hot', label: 'Hot' },
  { key: 'visitors', label: 'Visitors' },
  { key: 'conversations', label: 'Conversations' },
  { key: 'personas', label: 'Persona fit' },
] as const;

// Sidebar collapse state, persisted per browser.
const sidebarListeners = new Set<() => void>();
function subscribeSidebar(listener: () => void) {
  sidebarListeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    sidebarListeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}
function readSidebar(): boolean {
  try {
    return localStorage.getItem('le:sidebar') === 'collapsed';
  } catch {
    return false;
  }
}

interface TodayLite {
  budget: { budgetUsd: number; spentUsd: number; state: string };
  offer: { version: number } | null;
}

export function AppShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const router = useRouter();

  useEffect(() => {
    if (me.error) router.replace('/login');
  }, [me.error, router]);

  if (me.isLoading || !me.data) {
    return <p className="text-muted-foreground p-8 text-sm">Loading…</p>;
  }
  return (
    <TooltipProvider>
      <Suspense fallback={null}>
        <ShellInner>{children}</ShellInner>
      </Suspense>
    </TooltipProvider>
  );
}

function ShellInner({ children }: { children: ReactNode }) {
  const me = useMe();
  const data = me.data!;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const qc = useQueryClient();
  const sheet = useSheet();
  const savedViews = useSavedViews();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const collapsed = useSyncExternalStore(subscribeSidebar, readSidebar, () => false);
  const gPending = useRef<number | null>(null);

  const today = useQuery({
    queryKey: ['today'],
    queryFn: () => api<TodayLite>('/today'),
    enabled: !!data.workspace,
    refetchInterval: 60_000,
  });

  // Global keys: ⌘K / Ctrl K, '/', '?', and G-then-letter jumps (docs/ui.md §2).
  useEffect(() => {
    const w = window as { __leGPending?: boolean };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (gPending.current !== null) {
        window.clearTimeout(gPending.current);
        gPending.current = null;
        w.__leGPending = false;
        const href = GO_TO[e.key.toLowerCase()];
        if (href) {
          e.preventDefault();
          router.push(href);
        }
        return;
      }
      if (e.key === 'g' || e.key === 'G') {
        w.__leGPending = true;
        gPending.current = window.setTimeout(() => {
          gPending.current = null;
          w.__leGPending = false;
        }, 1200);
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        setHelpOpen(true);
      } else if (e.key === '/') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  function toggleCollapsed() {
    try {
      localStorage.setItem('le:sidebar', collapsed ? 'open' : 'collapsed');
    } catch {
      // storage unavailable: the toggle just doesn't persist
    }
    sidebarListeners.forEach((l) => l());
  }

  async function switchTo(workspaceId: string) {
    await api('/auth/switch', { method: 'POST', body: { workspaceId } });
    await qc.invalidateQueries();
  }

  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    qc.clear();
    router.replace('/login');
  }

  const t = today.data;
  const nav: NavItem[] = [
    { href: '/', label: 'Today', icon: Sun },
    { href: '/inbox', label: 'Inbox', icon: Inbox, comingIn: 'Phase 4' },
    { href: '/accounts', label: 'Accounts', icon: LayoutList },
    { href: '/pipeline', label: 'Pipeline', icon: KanbanSquare },
    { href: '/visitors', label: 'Visitors', icon: Radar, comingIn: 'Phase 3' },
    {
      href: '/offer',
      label: 'Offer profile',
      icon: FileText,
      badge: t?.offer ? `v${t.offer.version}` : 'draft',
    },
    {
      href: '/roi',
      label: 'ROI',
      icon: CircleDollarSign,
      badge: t ? `$${Math.round(t.budget.spentUsd)}/${Math.round(t.budget.budgetUsd)}` : null,
    },
  ];
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
  const currentView = pathname === '/accounts' ? params.get('view') : null;

  return (
    <div className="flex min-h-screen">
      <aside
        className={cn(
          'bg-muted/40 sticky top-0 flex h-screen shrink-0 flex-col gap-3 border-r p-3 transition-[width]',
          collapsed ? 'w-14' : 'w-60',
        )}
      >
        <div className="flex items-center gap-2">
          {!collapsed ? (
            data.workspaces.length > 1 ? (
              <select
                className="border-input h-8 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-sm font-medium"
                value={data.workspace?.id ?? ''}
                onChange={(e) => void switchTo(e.target.value)}
                aria-label="Workspace"
              >
                {!data.workspace ? <option value="">Select a workspace</option> : null}
                {data.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="min-w-0 flex-1 truncate px-1 text-sm font-semibold">
                ◆ {data.workspace?.name ?? 'Lead Engine'}
              </span>
            )
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronsRight /> : <ChevronsLeft />}
          </Button>
        </div>
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="text-muted-foreground hover:bg-accent flex h-8 items-center gap-2 rounded-md border px-2 text-sm"
          aria-label="Search (⌘K)"
        >
          <Search className="size-4 shrink-0" />
          {!collapsed ? (
            <>
              Search…
              <kbd className="ml-auto text-xs">⌘K</kbd>
            </>
          ) : null}
        </button>
        <nav className="flex flex-col gap-0.5" aria-label="Main">
          {nav.map((item) => (
            <div key={item.href}>
              <Link
                href={item.href}
                aria-current={isActive(item.href) ? 'page' : undefined}
                title={collapsed ? item.label : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                  isActive(item.href) && !currentView
                    ? 'bg-accent font-medium'
                    : 'hover:bg-accent/60',
                  item.comingIn && 'text-muted-foreground',
                )}
              >
                <item.icon className="size-4 shrink-0" aria-hidden />
                {!collapsed ? (
                  <>
                    <span className="truncate">{item.label}</span>
                    {item.comingIn ? (
                      <span className="ml-auto text-[10px] uppercase">{item.comingIn}</span>
                    ) : item.badge ? (
                      <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                        {item.badge}
                      </span>
                    ) : null}
                  </>
                ) : null}
              </Link>
              {item.href === '/accounts' && !collapsed ? (
                <div className="mt-0.5 mb-1 ml-6 flex flex-col">
                  {[
                    ...PINNED_VIEWS,
                    ...(savedViews.data ?? [])
                      .filter((v) => v.pinned)
                      .map((v) => ({ key: v.id, label: v.name })),
                  ].map((v) => (
                    <Link
                      key={v.key}
                      href={`/accounts?view=${v.key}`}
                      aria-current={currentView === v.key ? 'page' : undefined}
                      className={cn(
                        'rounded px-2 py-1 text-xs',
                        currentView === v.key
                          ? 'bg-accent font-medium'
                          : 'text-muted-foreground hover:bg-accent/60',
                      )}
                    >
                      {v.label}
                    </Link>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-1">
          <Link
            href="/settings"
            aria-current={isActive('/settings') ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
              isActive('/settings') ? 'bg-accent font-medium' : 'hover:bg-accent/60',
            )}
            title={collapsed ? 'Settings' : undefined}
          >
            <Settings className="size-4 shrink-0" aria-hidden />
            {!collapsed ? 'Settings' : null}
          </Link>
          <button
            type="button"
            onClick={() => void logout()}
            className="text-muted-foreground hover:bg-accent/60 flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs"
            title={collapsed ? 'Sign out' : undefined}
          >
            <LogOut className="size-4 shrink-0" aria-hidden />
            {!collapsed ? <span className="truncate">Sign out {data.user.email}</span> : null}
          </button>
        </div>
      </aside>
      <main className={cn('min-w-0 flex-1 p-6', sheet.current && 'xl:pr-[36rem]')}>
        {data.workspace ? (
          <>
            <BudgetBanner />
            {children}
          </>
        ) : (
          <CreateWorkspace />
        )}
      </main>
      <RecordSheet />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onOpenAccount={(id) => sheet.open(id)}
      />
      <ShortcutSheet open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}

function CreateWorkspace() {
  const qc = useQueryClient();
  return (
    <form
      className="flex max-w-sm flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const name = String(new FormData(e.currentTarget).get('name'));
        try {
          await api('/workspaces', { method: 'POST', body: { name } });
          await qc.invalidateQueries();
        } catch (err) {
          alert(errorMessage(err));
        }
      }}
    >
      <h1 className="text-xl font-semibold">Create a workspace</h1>
      <Input name="name" placeholder="Workspace name" required maxLength={80} />
      <Button type="submit">Create</Button>
    </form>
  );
}
