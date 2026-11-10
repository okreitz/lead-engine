'use client';
import * as React from 'react';
import { Popover as P } from 'radix-ui';
import { cn } from '@/lib/utils';

export function Popover({
  trigger,
  children,
  className,
  open,
  onOpenChange,
  align = 'start',
}: {
  trigger: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: 'start' | 'center' | 'end';
}) {
  return (
    <P.Root {...(open !== undefined ? { open } : {})} {...(onOpenChange ? { onOpenChange } : {})}>
      <P.Trigger asChild>{trigger}</P.Trigger>
      <P.Portal>
        <P.Content
          align={align}
          sideOffset={4}
          className={cn(
            'bg-popover text-popover-foreground z-50 min-w-48 rounded-lg border p-2 text-sm shadow-lg',
            className,
          )}
        >
          {children}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
