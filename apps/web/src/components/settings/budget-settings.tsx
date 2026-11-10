'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { BudgetCard } from '@/components/budget';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { useMe } from '@/lib/me';

const STREAMS = [
  { key: 'personas', label: 'Persona fit', def: 0.6 },
  { key: 'conversations', label: 'Conversations', def: 0.2 },
  { key: 'visits', label: 'Website visits', def: 0.1 },
  { key: 'llm', label: 'LLM', def: 0.1 },
] as const;

/**
 * Budget tab (docs/ui.md §3.9, SPEC §8.1): monthly cap, optional sub-caps and the 80% / 100%
 * behaviour. Changes are audited and resume waiting jobs.
 */
export function BudgetSettings({ disabled }: { disabled: boolean }) {
  const ws = useMe().data!.workspace!;
  const qc = useQueryClient();
  const [enforce, setEnforce] = useState(ws.settings.enforceSubCaps ?? false);
  const save = useMutation({
    mutationFn: (body: unknown) => api('/workspace', { method: 'PATCH', body }),
    onSuccess: () => qc.invalidateQueries(),
  });
  return (
    <div className="flex flex-col gap-4">
      <BudgetCard />
      <Card>
        <CardTitle>Monthly budget</CardTitle>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const subCaps = Object.fromEntries(
              STREAMS.map((s) => [s.key, Number(f.get(s.key)) / 100]),
            );
            save.mutate({
              monthlyBudgetUsd: Number(f.get('budget')),
              settings: { enforceSubCaps: enforce, subCaps },
            });
          }}
        >
          <Label className="max-w-xs">
            Cap per calendar month (USD)
            <Input
              name="budget"
              type="number"
              min={0}
              step="1"
              defaultValue={ws.monthlyBudgetUsd}
              disabled={disabled}
            />
          </Label>
          <p className="text-muted-foreground text-sm">
            At 80% a warning shows on every page. At 100% paid calls stop and jobs wait with the
            reason &ldquo;budget reached&rdquo; until next month or until you raise the cap. Serper
            never goes past its free queries.
          </p>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={enforce}
              onChange={(e) => setEnforce(e.target.checked)}
              disabled={disabled}
            />
            Enforce per-stream sub-caps
          </label>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {STREAMS.map((s) => (
              <Label key={s.key}>
                {s.label} (%)
                <Input
                  name={s.key}
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={Math.round(
                    ((ws.settings.subCaps?.[s.key] as number | undefined) ?? s.def) * 100,
                  )}
                  disabled={disabled || !enforce}
                />
              </Label>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={disabled || save.isPending}>
              Save budget
            </Button>
            {save.error ? (
              <span className="text-destructive text-sm">{errorMessage(save.error)}</span>
            ) : null}
            {save.isSuccess ? <span className="text-muted-foreground text-sm">Saved</span> : null}
          </div>
        </form>
      </Card>
    </div>
  );
}
