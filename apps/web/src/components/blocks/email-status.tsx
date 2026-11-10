import { cn } from '@/lib/utils';

const STYLES: Record<string, { label: string; className: string }> = {
  verified: { label: 'Verified', className: 'bg-emerald-100 text-emerald-900 border-emerald-200' },
  pattern_verified: { label: 'Pattern verified', className: 'border-emerald-500 text-emerald-800' },
  risky: { label: 'Risky', className: 'bg-amber-100 text-amber-900 border-amber-200' },
  catch_all: { label: 'Catch-all', className: 'border-amber-500 text-amber-800' },
  unknown: { label: 'Unknown', className: 'bg-muted text-muted-foreground border-transparent' },
  invalid: { label: 'Invalid', className: 'bg-red-100 text-red-900 border-red-200 line-through' },
};

/** Email status with text and colour, never colour alone (docs/ui.md §3.3). */
export function EmailStatusBadge({ status }: { status: string | null }) {
  if (!status) return null;
  const s = STYLES[status] ?? { label: status, className: 'bg-muted' };
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium',
        s.className,
      )}
    >
      {s.label}
    </span>
  );
}
