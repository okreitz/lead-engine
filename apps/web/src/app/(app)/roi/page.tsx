'use client';
import { BudgetCard } from '@/components/budget';

/** ROI (docs/ui.md §3.8). Stream bars, forecast and the ledger follow in the next PR. */
export default function RoiPage() {
  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">ROI</h1>
      <BudgetCard />
    </div>
  );
}
