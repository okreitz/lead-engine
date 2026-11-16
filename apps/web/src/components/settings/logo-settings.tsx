'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type ChangeEvent } from 'react';
import { WorkspaceLogo } from '@/components/workspace-logo';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { LOGO_CONTENT_TYPES, LOGO_MAX_BYTES } from '@le/shared';
import { api, errorMessage } from '@/lib/api';
import { useMe } from '@/lib/me';

const ACCEPT: readonly string[] = LOGO_CONTENT_TYPES;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'));
    reader.readAsDataURL(file);
  });
}

/** Settings → General: the logo shown next to the workspace name in the sidebar. */
export function LogoSettings({ disabled }: { disabled: boolean }) {
  const ws = useMe().data!.workspace!;
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(e: ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setError(null);
    if (!ACCEPT.includes(file.type)) {
      setError('Use a PNG, JPEG or WebP image.');
    } else if (file.size > LOGO_MAX_BYTES) {
      setError(`The logo must be at most ${LOGO_MAX_BYTES / 1024} kB.`);
    } else {
      setBusy(true);
      try {
        await api('/workspace/logo', {
          method: 'PUT',
          body: { dataUrl: await readAsDataUrl(file) },
        });
        await qc.invalidateQueries({ queryKey: ['me'] });
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    }
    input.value = '';
  }

  async function remove() {
    setError(null);
    setBusy(true);
    try {
      await api('/workspace/logo', { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardTitle>Logo</CardTitle>
      <div className="flex flex-wrap items-center gap-4">
        <div className="bg-muted/40 flex h-16 w-40 items-center gap-2 rounded-md border px-3">
          <WorkspaceLogo className="h-8" />
          <span className="truncate text-sm font-semibold">{ws.name}</span>
        </div>
        <label className={disabled || busy ? 'pointer-events-none opacity-50' : undefined}>
          <span className="border-input hover:bg-accent inline-flex h-9 cursor-pointer items-center rounded-md border px-3 text-sm">
            {ws.logoUpdatedAt ? 'Replace logo' : 'Upload logo'}
          </span>
          <input
            type="file"
            accept={ACCEPT.join(',')}
            className="sr-only"
            onChange={(e) => void upload(e)}
            disabled={disabled || busy}
          />
        </label>
        {ws.logoUpdatedAt ? (
          <Button variant="ghost" onClick={() => void remove()} disabled={disabled || busy}>
            Remove
          </Button>
        ) : null}
      </div>
      <p className="text-muted-foreground mt-3 text-sm">
        Shown in the sidebar next to the workspace name. PNG, JPEG or WebP up to{' '}
        {LOGO_MAX_BYTES / 1024} kB; a square or wide image about 64 px high looks best. Rename the
        workspace in the form above.
      </p>
      {error ? <p className="text-destructive mt-2 text-sm">{error}</p> : null}
    </Card>
  );
}
