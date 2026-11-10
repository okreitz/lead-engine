'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ConfirmButton } from '@/components/confirm';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardTitle } from '@/components/ui/card';
import { Input, Label, NativeSelect } from '@/components/ui/input';
import { api, errorMessage, fmtDate } from '@/lib/api';
import { useMe } from '@/lib/me';

export default function SettingsPage() {
  const me = useMe();
  const ws = me.data?.workspace;
  const owner = me.data?.role === 'owner';
  if (!ws) return null;
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        {owner ? (
          <Link href="/settings/audit" className="text-sm underline-offset-4 hover:underline">
            Audit log
          </Link>
        ) : null}
      </div>
      <WorkspaceForm disabled={!owner} />
      <ProviderKeys disabled={!owner} />
      <Members disabled={!owner} />
      {owner ? <Tokens /> : null}
      <Password />
      {owner ? <DangerZone name={ws.name} /> : null}
    </div>
  );
}

function useSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) => api('/workspace', { method: 'PATCH', body }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

function WorkspaceForm({ disabled }: { disabled: boolean }) {
  const ws = useMe().data!.workspace!;
  const save = useSave();
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    save.mutate({
      name: String(f.get('name')),
      monthlyBudgetUsd: Number(f.get('budget')),
      timezone: String(f.get('timezone')),
      settings: {
        llmAdapter: String(f.get('llmAdapter')),
        fitThreshold: Number(f.get('fitThreshold')),
      },
    });
  }
  return (
    <Card>
      <CardTitle>Workspace</CardTitle>
      <form className="grid grid-cols-2 gap-4" onSubmit={submit}>
        <Label>
          Name
          <Input name="name" defaultValue={ws.name} disabled={disabled} required />
        </Label>
        <Label>
          Monthly budget (USD)
          <Input
            name="budget"
            type="number"
            min={0}
            step="1"
            defaultValue={ws.monthlyBudgetUsd}
            disabled={disabled}
          />
        </Label>
        <Label>
          Timezone
          <Input name="timezone" defaultValue={ws.timezone} disabled={disabled} />
        </Label>
        <Label>
          Fit threshold
          <Input
            name="fitThreshold"
            type="number"
            min={0}
            max={100}
            defaultValue={ws.settings.fitThreshold ?? 60}
            disabled={disabled}
          />
        </Label>
        <Label>
          LLM adapter
          <NativeSelect
            name="llmAdapter"
            defaultValue={ws.settings.llmAdapter ?? 'anthropic-api'}
            disabled={disabled}
          >
            <option value="anthropic-api">Anthropic API (API key)</option>
            <option value="claude-cli">claude CLI (local mode)</option>
          </NativeSelect>
        </Label>
        <div className="col-span-2 flex items-center gap-3">
          <Button type="submit" disabled={disabled || save.isPending}>
            Save
          </Button>
          {save.error ? (
            <span className="text-destructive text-sm">{errorMessage(save.error)}</span>
          ) : null}
          {save.isSuccess ? <span className="text-muted-foreground text-sm">Saved</span> : null}
        </div>
      </form>
    </Card>
  );
}

interface ProviderKeyList {
  masterKeyConfigured: boolean;
  providers: { provider: string; configured: boolean; createdAt: number | null }[];
}

function ProviderKeys({ disabled }: { disabled: boolean }) {
  const qc = useQueryClient();
  const keys = useQuery({
    queryKey: ['provider-keys'],
    queryFn: () => api<ProviderKeyList>('/provider-keys'),
  });
  const [error, setError] = useState<string | null>(null);
  return (
    <Card>
      <CardTitle>Provider keys</CardTitle>
      <p className="text-muted-foreground mb-3 text-sm">
        Bring your own keys. They are encrypted with LE_MASTER_KEY and never shown again.
      </p>
      {keys.data && !keys.data.masterKeyConfigured ? (
        <p className="mb-3 text-sm text-amber-700">
          LE_MASTER_KEY is not set on the engine, so keys can&apos;t be saved.
        </p>
      ) : null}
      <ul className="flex flex-col gap-3">
        {keys.data?.providers.map((p) => (
          <li key={p.provider} className="flex items-center gap-3">
            <span className="w-24 font-mono text-sm">{p.provider}</span>
            {p.configured ? (
              <Badge tone="ok">set {fmtDate(p.createdAt)}</Badge>
            ) : (
              <Badge tone="muted">not set</Badge>
            )}
            {!disabled ? (
              <form
                className="ml-auto flex gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const form = e.currentTarget;
                  const key = String(new FormData(form).get('key'));
                  try {
                    setError(null);
                    await api(`/provider-keys/${p.provider}`, { method: 'PUT', body: { key } });
                    form.reset();
                    await qc.invalidateQueries({ queryKey: ['provider-keys'] });
                  } catch (err) {
                    setError(errorMessage(err));
                  }
                }}
              >
                <Input
                  name="key"
                  type="password"
                  placeholder="New key"
                  className="w-56"
                  required
                  autoComplete="off"
                />
                <Button size="sm" type="submit">
                  Save
                </Button>
                {p.configured ? (
                  <ConfirmButton
                    trigger={
                      <Button size="sm" variant="outline" type="button">
                        Remove
                      </Button>
                    }
                    title={`Remove the ${p.provider} key?`}
                    confirmLabel="Remove"
                    onConfirm={async () => {
                      await api(`/provider-keys/${p.provider}`, { method: 'DELETE' });
                      await qc.invalidateQueries({ queryKey: ['provider-keys'] });
                    }}
                  />
                ) : null}
              </form>
            ) : null}
          </li>
        ))}
      </ul>
      {error ? <p className="text-destructive mt-2 text-sm">{error}</p> : null}
    </Card>
  );
}

function Members({ disabled }: { disabled: boolean }) {
  const qc = useQueryClient();
  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => api<{ userId: string; email: string; role: string }[]>('/workspace/members'),
  });
  const [error, setError] = useState<string | null>(null);
  return (
    <Card>
      <CardTitle>Members</CardTitle>
      <ul className="mb-3 flex flex-col gap-2 text-sm">
        {members.data?.map((m) => (
          <li key={m.userId} className="flex items-center gap-2">
            {m.email} <Badge tone="muted">{m.role}</Badge>
            {!disabled ? (
              <ConfirmButton
                trigger={
                  <Button size="xs" variant="ghost" className="ml-auto">
                    Remove
                  </Button>
                }
                title={`Remove ${m.email} from this workspace?`}
                confirmLabel="Remove"
                onConfirm={async () => {
                  try {
                    await api(`/workspace/members/${m.userId}`, { method: 'DELETE' });
                    await qc.invalidateQueries({ queryKey: ['members'] });
                  } catch (err) {
                    setError(errorMessage(err));
                  }
                }}
              />
            ) : null}
          </li>
        ))}
      </ul>
      {!disabled ? (
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            const password = String(f.get('password') ?? '');
            try {
              setError(null);
              await api('/workspace/members', {
                method: 'POST',
                body: {
                  email: String(f.get('email')),
                  role: String(f.get('role')),
                  ...(password ? { password } : {}),
                },
              });
              form.reset();
              await qc.invalidateQueries({ queryKey: ['members'] });
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        >
          <Input name="email" type="email" placeholder="Email" required />
          <Input
            name="password"
            type="password"
            placeholder="Initial password (new users)"
            autoComplete="new-password"
          />
          <NativeSelect name="role" defaultValue="member">
            <option value="member">member</option>
            <option value="owner">owner</option>
          </NativeSelect>
          <Button type="submit">Add</Button>
        </form>
      ) : null}
      {error ? <p className="text-destructive mt-2 text-sm">{error}</p> : null}
    </Card>
  );
}

function Tokens() {
  const qc = useQueryClient();
  const tokens = useQuery({
    queryKey: ['tokens'],
    queryFn: () =>
      api<
        { id: string; name: string; scope: string; createdAt: number; lastUsedAt: number | null }[]
      >('/tokens'),
  });
  const [created, setCreated] = useState<string | null>(null);
  return (
    <Card>
      <CardTitle>API tokens</CardTitle>
      <p className="text-muted-foreground mb-3 text-sm">
        Ground Control reads <code>GET /api/v1/summary</code> with a read-only token.
      </p>
      <ul className="mb-3 flex flex-col gap-2 text-sm">
        {tokens.data?.map((t) => (
          <li key={t.id} className="flex items-center gap-2">
            {t.name} <Badge tone="muted">{t.scope}</Badge>
            <span className="text-muted-foreground text-xs">last used {fmtDate(t.lastUsedAt)}</span>
            <ConfirmButton
              trigger={
                <Button size="xs" variant="ghost" className="ml-auto">
                  Revoke
                </Button>
              }
              title={`Revoke the token "${t.name}"?`}
              confirmLabel="Revoke"
              onConfirm={async () => {
                await api(`/tokens/${t.id}`, { method: 'DELETE' });
                await qc.invalidateQueries({ queryKey: ['tokens'] });
              }}
            />
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const f = new FormData(form);
          const res = await api<{ token: string }>('/tokens', {
            method: 'POST',
            body: { name: String(f.get('name')), scope: String(f.get('scope')) },
          });
          setCreated(res.token);
          form.reset();
          await qc.invalidateQueries({ queryKey: ['tokens'] });
        }}
      >
        <Input name="name" placeholder="Token name" required />
        <NativeSelect name="scope" defaultValue="read">
          <option value="read">read</option>
          <option value="write">write</option>
        </NativeSelect>
        <Button type="submit">Create</Button>
      </form>
      {created ? (
        <p className="mt-3 text-sm">
          Copy it now, it won&apos;t be shown again:{' '}
          <code className="bg-muted rounded px-1 break-all">{created}</code>
        </p>
      ) : null}
    </Card>
  );
}

function Password() {
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Card>
      <CardTitle>Password</CardTitle>
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const f = new FormData(form);
          try {
            await api('/auth/password', {
              method: 'POST',
              body: {
                currentPassword: String(f.get('current')),
                newPassword: String(f.get('next')),
              },
            });
            form.reset();
            setMsg('Password changed. Other sessions were signed out.');
          } catch (err) {
            setMsg(errorMessage(err));
          }
        }}
      >
        <Input
          name="current"
          type="password"
          placeholder="Current"
          required
          autoComplete="current-password"
        />
        <Input
          name="next"
          type="password"
          placeholder="New (12+ chars)"
          minLength={12}
          required
          autoComplete="new-password"
        />
        <Button type="submit">Change</Button>
      </form>
      {msg ? <p className="text-muted-foreground mt-2 text-sm">{msg}</p> : null}
    </Card>
  );
}

function DangerZone({ name }: { name: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  return (
    <Card className="border-destructive/40">
      <CardTitle>Danger zone</CardTitle>
      <ConfirmButton
        trigger={<Button variant="destructive">Delete workspace</Button>}
        title="Delete this workspace?"
        description="This permanently deletes every account, contact, deal, offer and ledger entry in it."
        typeToConfirm={name}
        confirmLabel="Delete workspace"
        onConfirm={async () => {
          await api('/workspace', { method: 'DELETE', body: { confirmName: name } });
          await qc.invalidateQueries();
          router.replace('/');
        }}
      />
    </Card>
  );
}
