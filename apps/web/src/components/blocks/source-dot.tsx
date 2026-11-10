'use client';
import { Tooltip } from '@/components/ui/tooltip';

export interface Source {
  source: string;
  url: string | null;
  fetchedAt: number;
  confidence: number;
  costUsd?: number | null;
}

/**
 * The source dot shown next to every enriched field (docs/ui.md §1.2, §3.3): provider,
 * URL, fetched date, confidence and cost on hover.
 */
export function SourceDot({ sources }: { sources: Source[] }) {
  if (!sources.length) return null;
  const s = sources[sources.length - 1]!;
  return (
    <Tooltip
      content={
        <span className="flex flex-col">
          {sources.map((x, i) => (
            <span key={i}>
              {x.source} · {new Date(x.fetchedAt).toLocaleDateString()} ·{' '}
              {Math.round(x.confidence * 100)}%{x.costUsd ? ` · $${x.costUsd.toFixed(3)}` : ''}
              {x.url ? ` · ${x.url}` : ''}
            </span>
          ))}
        </span>
      }
    >
      <button
        type="button"
        className="ml-1 inline-flex items-center align-middle"
        aria-label={`Source: ${s.source}, fetched ${new Date(s.fetchedAt).toLocaleDateString()}`}
      >
        <span className="bg-sky-600 inline-block size-1.5 rounded-full" aria-hidden />
      </button>
    </Tooltip>
  );
}
