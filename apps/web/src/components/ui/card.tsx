import * as React from 'react';
import { cn } from '@/lib/utils';

function Card({ className, ...props }: React.ComponentProps<'section'>) {
  return (
    <section
      data-slot="card"
      className={cn('bg-card text-card-foreground rounded-xl border p-5 shadow-sm', className)}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<'h2'>) {
  return <h2 className={cn('mb-3 text-base font-semibold', className)} {...props} />;
}

const tones = {
  default: 'bg-secondary text-secondary-foreground',
  warn: 'bg-amber-100 text-amber-900',
  danger: 'bg-red-100 text-red-900',
  ok: 'bg-emerald-100 text-emerald-900',
  muted: 'bg-muted text-muted-foreground',
};

function Badge({
  className,
  tone = 'default',
  ...props
}: React.ComponentProps<'span'> & { tone?: keyof typeof tones }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium',
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

export { Badge, Card, CardTitle };
