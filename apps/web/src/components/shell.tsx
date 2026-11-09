'use client';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { BudgetBanner } from '@/components/budget';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { useMe } from '@/lib/me';
import { cn } from '@/lib/utils';

export const NAV: { href: string; label: string }[] = [
  { href: '/', label: 'Overview' },
  { href: '/settings', label: 'Settings' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();

  useEffect(() => {
    if (me.error) router.replace('/login');
  }, [me.error, router]);

  if (me.isLoading || !me.data) {
    return <p className="text-muted-foreground p-8 text-sm">Loading…</p>;
  }
  const data = me.data;

  async function switchTo(workspaceId: string) {
    await api('/auth/switch', { method: 'POST', body: { workspaceId } });
    await qc.invalidateQueries();
  }

  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    qc.clear();
    router.replace('/login');
  }

  return (
    <div className="flex min-h-screen">
      <aside className="bg-muted/40 flex w-56 shrink-0 flex-col gap-4 border-r p-4">
        <div className="text-lg font-semibold tracking-tight">Lead Engine</div>
        {data.workspaces.length > 0 ? (
          <select
            className="border-input h-9 rounded-md border bg-transparent px-2 text-sm"
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
        ) : null}
        <nav className="flex flex-col gap-1">
          {NAV.map((item) => {
            const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'rounded-md px-2 py-1.5 text-sm',
                  active ? 'bg-accent font-medium' : 'hover:bg-accent/60',
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto flex flex-col gap-2 text-xs">
          <span className="text-muted-foreground truncate">{data.user.email}</span>
          <Button variant="outline" size="sm" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-6">
        {data.workspace ? (
          <>
            <BudgetBanner />
            {children}
          </>
        ) : (
          <CreateWorkspace />
        )}
      </main>
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
