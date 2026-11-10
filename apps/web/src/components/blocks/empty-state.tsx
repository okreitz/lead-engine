import Link from 'next/link';
import type { ReactNode } from 'react';

/** Empty lists say what to do next (docs/ui.md §4). */
export function EmptyState({
  title,
  next,
  href,
  action,
  children,
}: {
  title: string;
  next?: string;
  href?: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="text-muted-foreground flex flex-col items-start gap-1 rounded-lg border border-dashed p-6 text-sm">
      <p className="text-foreground font-medium">{title}</p>
      {children}
      {next && href ? (
        <Link href={href} className="text-foreground underline underline-offset-4">
          {next}
        </Link>
      ) : null}
      {action}
    </div>
  );
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="bg-muted h-8 animate-pulse rounded" />
      ))}
    </div>
  );
}
