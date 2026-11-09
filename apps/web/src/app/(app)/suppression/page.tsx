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

export default function SuppressionPage() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['suppressions'],
    queryFn: () => api<Suppression[]>('/suppressions'),
  });
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Suppression list</h1>
      <p className="text-muted-foreground text-sm">
        Suppressed emails and domains (with their subdomains) are hidden from every view and export
        and are never enriched. Honour opt-outs within 10 business days (CAN-SPAM).
      </p>
      <Card>
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            try {
              setError(null);
              await api('/suppressions', {
                method: 'POST',
                body: {
                  kind: String(f.get('kind')),
                  value: String(f.get('value')),
                  reason: String(f.get('reason') || 'opt-out'),
                },
              });
              form.reset();
              await qc.invalidateQueries();
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        >
          <NativeSelect name="kind" defaultValue="email" aria-label="Kind">
            <option value="email">Email</option>
            <option value="domain">Domain</option>
          </NativeSelect>
          <Input name="value" placeholder="jane@acme.com or acme.com" required />
          <Input name="reason" placeholder="Reason (opt-out)" className="w-48" />
          <Button type="submit">Suppress</Button>
        </form>
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
    </div>
  );
}
