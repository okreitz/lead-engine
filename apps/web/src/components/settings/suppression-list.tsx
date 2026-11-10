'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmButton } from '@/components/confirm';
import { Button } from '@/components/ui/button';
import { Badge, Card } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/input';
import { api, errorMessage, fmtDate } from '@/lib/api';

interface Suppression {
  id: string;
  kind: 'email' | 'domain';
  value: string;
  reason: string;
  createdAt: number;
  global: boolean;
}

/** Suppression tab: add (single or pasted list), reason, remove with confirmation. */
export function SuppressionList() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['suppressions'],
    queryFn: () => api<Suppression[]>('/suppressions'),
  });
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        Suppressed emails and domains (with their subdomains) are hidden from every view and export
        and are never enriched. Honour opt-outs within 10 business days (CAN-SPAM).
      </p>
      <Card>
        <form
          className="flex flex-col gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            const values = String(f.get('value'))
              .split(/[\s,;]+/)
              .map((v) => v.trim())
              .filter(Boolean);
            const reason = String(f.get('reason') || 'opt-out');
            setError(null);
            let added = 0;
            const failed: string[] = [];
            for (const value of values) {
              const kind = value.includes('@') ? 'email' : 'domain';
              try {
                await api('/suppressions', { method: 'POST', body: { kind, value, reason } });
                added++;
              } catch (err) {
                failed.push(`${value} (${errorMessage(err)})`);
              }
            }
            setImported(values.length > 1 ? `Added ${added} of ${values.length}.` : null);
            if (failed.length) setError(`Not added: ${failed.join(', ')}`);
            form.reset();
            await qc.invalidateQueries();
          }}
        >
          <div className="flex gap-2">
            <Input
              name="value"
              placeholder="jane@acme.com, acme.com … (paste a list to import)"
              required
            />
            <NativeSelect name="reason" defaultValue="opt-out" aria-label="Reason">
              <option value="opt-out">opt-out</option>
              <option value="customer">existing customer</option>
              <option value="competitor">competitor</option>
              <option value="bounce">bounced</option>
              <option value="other">other</option>
            </NativeSelect>
            <Button type="submit">Suppress</Button>
          </div>
          <p className="text-muted-foreground text-xs">
            Values with an @ are emails; the rest are domains.
          </p>
        </form>
        {imported ? <p className="mt-2 text-sm">{imported}</p> : null}
        {error ? <p className="text-destructive mt-2 text-sm">{error}</p> : null}
      </Card>
      <table className="w-full text-sm">
        <thead className="text-muted-foreground text-left">
          <tr>
            <th className="py-2">Value</th>
            <th>Kind</th>
            <th>Reason</th>
            <th>Added</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.data?.map((s) => (
            <tr key={s.id} className="border-t">
              <td className="py-2 font-mono">{s.value}</td>
              <td>
                {s.kind} {s.global ? <Badge tone="muted">global</Badge> : null}
              </td>
              <td>{s.reason}</td>
              <td>{fmtDate(s.createdAt)}</td>
              <td className="text-right">
                {!s.global ? (
                  <ConfirmButton
                    trigger={
                      <Button size="xs" variant="ghost">
                        Remove
                      </Button>
                    }
                    title={`Remove ${s.value} from the suppression list?`}
                    description="Only do this if the opt-out was added by mistake."
                    confirmLabel="Remove"
                    onConfirm={async () => {
                      await api(`/suppressions/${s.id}`, { method: 'DELETE' });
                      await qc.invalidateQueries();
                    }}
                  />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.data?.length === 0 ? (
        <p className="text-muted-foreground text-sm">No suppressions yet.</p>
      ) : null}
    </div>
  );
}
