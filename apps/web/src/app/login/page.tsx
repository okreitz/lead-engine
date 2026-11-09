'use client';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { api, errorMessage, setCsrfToken } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const state = useQuery({
    queryKey: ['auth-state'],
    queryFn: () => api<{ needsSetup: boolean; setupTokenRequired: boolean }>('/auth/state'),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setup = state.data?.needsSetup ?? false;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = {
        email: String(form.get('email')),
        password: String(form.get('password')),
      };
      if (setup) {
        body.workspaceName = String(form.get('workspaceName'));
        const token = String(form.get('setupToken') ?? '');
        if (token) body.setupToken = token;
      }
      const res = await api<{ csrfToken: string }>(setup ? '/auth/setup' : '/auth/login', {
        method: 'POST',
        body,
      });
      setCsrfToken(res.csrfToken);
      router.replace('/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Lead Engine</h1>
      <Card>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <p className="text-muted-foreground text-sm">
            {setup ? 'Create the first user and workspace.' : 'Sign in to continue.'}
          </p>
          <Label>
            Email
            <Input name="email" type="email" autoComplete="email" required />
          </Label>
          <Label>
            Password
            <Input
              name="password"
              type="password"
              autoComplete={setup ? 'new-password' : 'current-password'}
              minLength={setup ? 12 : 1}
              required
            />
          </Label>
          {setup ? (
            <>
              <Label>
                Workspace name
                <Input name="workspaceName" required maxLength={80} />
              </Label>
              {state.data?.setupTokenRequired ? (
                <Label>
                  Setup token (LE_SETUP_TOKEN)
                  <Input name="setupToken" type="password" required />
                </Label>
              ) : null}
            </>
          ) : null}
          {error ? <p className="text-destructive text-sm">{error}</p> : null}
          <Button type="submit" disabled={busy || state.isLoading}>
            {setup ? 'Create account' : 'Sign in'}
          </Button>
        </form>
      </Card>
    </main>
  );
}
