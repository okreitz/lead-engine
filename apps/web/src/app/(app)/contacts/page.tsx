'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { ConfirmButton } from '@/components/confirm';
import { CopyEmail } from '@/components/copy-email';
import { ExportButton } from '@/components/export-button';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { EMAIL_STATUS_TONE, type Contact } from '@/lib/crm';

type Row = Contact & { company: string; domain: string };

export default function ContactsPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const list = useQuery({
    queryKey: ['contacts', q],
    queryFn: () => api<Row[]>(`/contacts${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
        <ExportButton entity="contacts" />
      </div>
      <Input
        placeholder="Search name, email or company"
        className="w-72"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <table className="w-full text-sm">
        <thead className="text-muted-foreground text-left">
          <tr>
            <th className="py-2">Name</th>
            <th>Title</th>
            <th>Company</th>
            <th>Email</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.data?.map((c) => (
            <tr key={c.id} className="border-t">
              <td className="py-2">{c.fullName}</td>
              <td>{c.title ?? '—'}</td>
              <td>
                <Link href={`/accounts/${c.accountId}`} className="hover:underline">
                  {c.company}
                </Link>
              </td>
              <td>
                {c.email ? (
                  <span className="flex items-center gap-2">
                    <CopyEmail email={c.email} />
                    {c.emailStatus ? (
                      <Badge tone={EMAIL_STATUS_TONE[c.emailStatus] ?? 'muted'}>
                        {c.emailStatus}
                      </Badge>
                    ) : null}
                  </span>
                ) : (
                  '—'
                )}
              </td>
              <td className="text-right">
                {c.email ? (
                  <ConfirmButton
                    trigger={
                      <Button size="xs" variant="ghost">
                        Suppress
                      </Button>
                    }
                    title={`Suppress ${c.email}?`}
                    confirmLabel="Suppress"
                    onConfirm={async () => {
                      await api(`/contacts/${c.id}/suppress`, { method: 'POST' });
                      await qc.invalidateQueries({ queryKey: ['contacts'] });
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
