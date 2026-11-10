'use client';
import { useQuery } from '@tanstack/react-query';
import { api, fmtDate } from '@/lib/api';

interface AuditRow {
  id: string;
  action: string;
  target: string;
  at: number;
  details: Record<string, unknown>;
  email: string | null;
}

export default function AuditPage() {
  const rows = useQuery({
    queryKey: ['audit'],
    queryFn: () => api<AuditRow[]>('/audit?limit=200'),
  });
  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
      <table className="w-full text-sm">
        <thead className="text-muted-foreground text-left">
          <tr>
            <th className="py-2">When</th>
            <th>Who</th>
            <th>Action</th>
            <th>Target</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {rows.data?.map((r) => (
            <tr key={r.id} className="border-t align-top">
              <td className="py-2 whitespace-nowrap">{fmtDate(r.at)}</td>
              <td>{r.email ?? '—'}</td>
              <td className="font-mono">{r.action}</td>
              <td className="font-mono text-xs">{r.target}</td>
              <td className="text-muted-foreground font-mono text-xs">
                {Object.keys(r.details).length ? JSON.stringify(r.details) : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
