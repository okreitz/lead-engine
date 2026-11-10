'use client';
import * as React from 'react';
import { HoverCard as HC, Tooltip as T } from 'radix-ui';
import { cn } from '@/lib/utils';

/** Small text tooltip (shadcn-style). Wrap the app once in <TooltipProvider>. */
export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return <T.Provider delayDuration={200}>{children}</T.Provider>;
}

export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={4}
          className="bg-foreground text-background z-50 max-w-xs rounded-md px-2 py-1 text-xs shadow-md"
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

/** Rich hover card (score breakdowns). */
export function HoverCard({
  trigger,
  children,
  className,
}: {
  trigger: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <HC.Root openDelay={250} closeDelay={100}>
      <HC.Trigger asChild>{trigger}</HC.Trigger>
      <HC.Portal>
        <HC.Content
          sideOffset={6}
          className={cn(
            'bg-popover text-popover-foreground z-50 w-80 rounded-lg border p-3 text-sm shadow-lg',
            className,
          )}
        >
          {children}
        </HC.Content>
      </HC.Portal>
    </HC.Root>
  );
}
