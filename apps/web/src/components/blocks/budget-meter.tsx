import { cn } from '@/lib/utils';

/** Spend vs budget with a text label (docs/ui.md §4 BudgetMeter). */
export function BudgetMeter({
  spentUsd,
  budgetUsd,
  forecastUsd,
  compact = false,
  label,
}: {
  spentUsd: number;
  budgetUsd: number;
  forecastUsd?: number | null;
  compact?: boolean;
  label?: string;
}) {
  const share = budgetUsd > 0 ? spentUsd / budgetUsd : spentUsd > 0 ? 1 : 0;
  const state = share >= 1 ? 'reached' : share >= 0.8 ? 'warning' : 'ok';
  const forecastShare =
    forecastUsd != null && budgetUsd > 0 ? Math.min(1, forecastUsd / budgetUsd) : null;
  return (
    <div className={cn('flex items-center gap-2', compact ? 'text-xs' : 'text-sm')}>
      {label ? <span className="text-muted-foreground w-28 shrink-0 truncate">{label}</span> : null}
      <span className="tabular-nums">
        ${spentUsd.toFixed(2)} / ${budgetUsd.toFixed(Number.isInteger(budgetUsd) ? 0 : 2)}
      </span>
      <span
        className={cn('bg-muted relative h-2 overflow-hidden rounded', compact ? 'w-20' : 'w-40')}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={budgetUsd}
        aria-valuenow={spentUsd}
        aria-label="Budget used"
      >
        {forecastShare !== null ? (
          <span
            className="bg-foreground/15 absolute inset-y-0 left-0"
            style={{ width: `${forecastShare * 100}%` }}
          />
        ) : null}
        <span
          className={cn(
            'absolute inset-y-0 left-0',
            state === 'reached'
              ? 'bg-red-600'
              : state === 'warning'
                ? 'bg-amber-500'
                : 'bg-emerald-600',
          )}
          style={{ width: `${Math.min(1, share) * 100}%` }}
        />
      </span>
      {state !== 'ok' ? (
        <span
          className={cn('font-medium', state === 'reached' ? 'text-red-700' : 'text-amber-700')}
        >
          {state === 'reached' ? 'budget reached' : 'over 80%'}
        </span>
      ) : null}
      {forecastUsd != null ? (
        <span className="text-muted-foreground">forecast ${forecastUsd.toFixed(0)}</span>
      ) : null}
    </div>
  );
}
