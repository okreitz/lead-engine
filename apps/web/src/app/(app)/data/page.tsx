'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ExportButton } from '@/components/export-button';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { api, errorMessage } from '@/lib/api';

const COLUMNS = {
  accounts:
    'domain, name, country (US only), state, city, industry, naics, size_range, founded_year, stage',
  contacts: 'account_domain, full_name, title, seniority, department, email, email_status, phone',
  deals: 'account_domain, name, stage, value_usd, outcome',
} as const;

interface Report {
  created: number;
  existing: number;
  skipped: { row: number; reason: string }[];
}

export default function DataPage() {
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Import and export</h1>
      <p className="text-muted-foreground text-sm">
        Import accounts first, then contacts and deals (matched by account domain). Only US
        companies are imported; suppressed emails and domains are skipped.
      </p>
      {(Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]).map((entity) => (
        <ImportCard key={entity} entity={entity} />
      ))}
    </div>
  );
}

function ImportCard({ entity }: { entity: keyof typeof COLUMNS }) {
  const qc = useQueryClient();
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card>
      <div className="flex items-center justify-between">
        <CardTitle className="capitalize">{entity}</CardTitle>
        <ExportButton entity={entity} />
      </div>
      <p className="text-muted-foreground mb-3 text-xs">Columns: {COLUMNS[entity]}</p>
      <form
        className="flex items-center gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const file = (new FormData(e.currentTarget).get('file') as File | null) ?? null;
          if (!file || file.size === 0) return;
          try {
            setError(null);
            const text = await file.text();
            setReport(
              await api<Report>(`/import/${entity}`, {
                method: 'POST',
                raw: text,
                contentType: 'text/csv',
              }),
            );
            await qc.invalidateQueries();
          } catch (err) {
            setError(errorMessage(err));
          }
        }}
      >
        <input name="file" type="file" accept=".csv,text/csv" className="text-sm" required />
        <Button type="submit" size="sm">
          Import
        </Button>
      </form>
      {error ? <p className="text-destructive mt-2 text-sm">{error}</p> : null}
      {report ? (
        <div className="mt-3 text-sm">
          Created {report.created}, already present {report.existing}, skipped{' '}
          {report.skipped.length}.
          {report.skipped.length ? (
            <ul className="text-muted-foreground mt-1 max-h-40 overflow-auto text-xs">
              {report.skipped.map((s) => (
                <li key={s.row}>
                  Row {s.row}: {s.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
