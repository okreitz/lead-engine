'use client';
import { useQuery } from '@tanstack/react-query';
import { useState, type ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { api } from '@/lib/api';

export interface CostEstimate {
  usd: number;
  provider: string;
  model?: string;
  remainingUsd: number;
  confirm: boolean;
}

const money = (n: number) => (n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);

/**
 * A paid action (docs/ui.md §1.3, §4 CostConfirm). The estimate always shows next to the
 * button; a confirmation dialog opens only when the engine says the cost is high (over $1 or
 * 10% of what is left this month). The engine's budget stop still applies either way.
 */
export function CostAction({
  estimatePath,
  label,
  what,
  onRun,
  validate,
  disabled,
  ...button
}: {
  estimatePath: string;
  label: string;
  /** Short description for the dialog, e.g. "Draft the offer profile from acme.com". */
  what: string;
  onRun: () => Promise<unknown> | void;
  /** Runs before anything else; return false to stop (e.g. form.reportValidity()). */
  validate?: () => boolean;
} & Omit<ComponentProps<typeof Button>, 'onClick' | 'children' | 'type'>) {
  const est = useQuery({
    queryKey: ['estimate', estimatePath],
    queryFn: () => api<CostEstimate>(estimatePath),
    staleTime: 30_000,
  });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      await onRun();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        {...button}
        type="button"
        disabled={disabled || busy}
        onClick={() => {
          if (validate && !validate()) return;
          if (est.data?.confirm) setOpen(true);
          else void run();
        }}
      >
        {label}
      </Button>
      <span className="text-muted-foreground text-xs" aria-live="polite">
        {est.data ? `est. up to ${money(est.data.usd)}` : 'estimating…'}
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title={`Run this paid action?`}
          description={`${what}. Estimated cost up to ${est.data ? money(est.data.usd) : '…'}; ${
            est.data ? money(est.data.remainingUsd) : '…'
          } of this month's budget is left.`}
        >
          {est.data?.model ? (
            <p className="text-muted-foreground text-xs">
              {est.data.provider} · {est.data.model}. The charge is recorded in the ledger.
            </p>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button disabled={busy} onClick={() => void run()}>
              Run for up to {est.data ? money(est.data.usd) : '…'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </span>
  );
}
