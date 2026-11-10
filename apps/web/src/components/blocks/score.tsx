'use client';
import { HoverCard } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const fmt = (n: number | null | undefined) => (n == null ? '—' : String(Math.round(n)));

/** Five-segment mini bar with an accessible label (never colour alone). */
export function MiniBar({ value, label }: { value: number | null | undefined; label: string }) {
  const filled = value == null ? 0 : Math.round(Math.max(0, Math.min(100, value)) / 20);
  return (
    <span
      className="inline-flex items-center gap-1"
      aria-label={`${label} ${fmt(value)}`}
      title={`${label} ${fmt(value)}`}
    >
      <span className="inline-flex gap-px" aria-hidden>
        {Array.from({ length: 5 }, (_, i) => (
          <span
            key={i}
            className={cn(
              'h-2.5 w-1.5 rounded-[1px]',
              i < filled ? 'bg-foreground/80' : 'bg-foreground/15',
            )}
          />
        ))}
      </span>
      <span className="text-muted-foreground text-[10px] uppercase">{label}</span>
    </span>
  );
}

export interface ScoreInput {
  priority: number;
  fitScore: number | null;
  intentScore: number;
  scoreReasons?: { fit: string[]; intent: string[] } | null;
}

/** Short chip text for a reason ("Industry matches \"Logistics\"" → "Logistics"). */
export function reasonChip(reason: string): string {
  const quoted = /"([^"]+)"/.exec(reason)?.[1];
  if (quoted) return quoted;
  const m = /^(\w[\w ]*?) \(/.exec(reason);
  if (m) return m[1]!;
  return reason.split(/[:,·]/)[0]!.slice(0, 24);
}

/**
 * Priority number, fit and intent mini bars and up to 3 reason chips, with a hover card
 * showing the full breakdown (docs/ui.md §3.2, principle 1: every score explains itself).
 */
export function ScoreCell({ score, chips = true }: { score: ScoreInput; chips?: boolean }) {
  const reasons = [
    ...(score.scoreReasons?.intent ?? []),
    ...(score.scoreReasons?.fit ?? []),
  ].filter((r) => r !== 'No approved offer profile yet');
  return (
    <HoverCard
      trigger={
        <span className="inline-flex cursor-default items-center gap-2" tabIndex={0}>
          <span className="w-7 text-right text-sm font-semibold tabular-nums">
            {fmt(score.priority)}
          </span>
          <MiniBar value={score.fitScore} label="fit" />
          <MiniBar value={score.intentScore} label="int" />
          {chips
            ? reasons.slice(0, 3).map((r, i) => (
                <span
                  key={i}
                  className="bg-muted text-muted-foreground max-w-28 truncate rounded px-1.5 py-0.5 text-[11px]"
                >
                  {reasonChip(r)}
                </span>
              ))
            : null}
        </span>
      }
    >
      <ScoreBreakdown score={score} />
    </HoverCard>
  );
}

export function ScoreBreakdown({ score }: { score: ScoreInput }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="font-medium">Priority {fmt(score.priority)}</span>
        <span className="text-muted-foreground text-xs">0.6 × fit + 0.4 × intent</span>
      </div>
      <section>
        <div className="text-xs font-medium">Fit {fmt(score.fitScore)}</div>
        <ul className="text-muted-foreground list-disc pl-4 text-xs">
          {(score.scoreReasons?.fit ?? ['Not scored yet']).map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      </section>
      <section>
        <div className="text-xs font-medium">Intent {fmt(score.intentScore)}</div>
        <ul className="text-muted-foreground list-disc pl-4 text-xs">
          {(score.scoreReasons?.intent?.length
            ? score.scoreReasons.intent
            : ['No recent signals']
          ).map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
