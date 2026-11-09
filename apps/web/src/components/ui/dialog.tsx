'use client';
import * as React from 'react';
import { Dialog as D } from 'radix-ui';
import { cn } from '@/lib/utils';

function Dialog(props: React.ComponentProps<typeof D.Root>) {
  return <D.Root {...props} />;
}

function DialogContent({
  className,
  title,
  description,
  children,
  ...props
}: React.ComponentProps<typeof D.Content> & { title: string; description?: string }) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/40" />
      <D.Content
        className={cn(
          'bg-background fixed top-1/2 left-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border p-6 shadow-lg',
          className,
        )}
        {...props}
      >
        <D.Title className="text-lg font-semibold">{title}</D.Title>
        <D.Description className={description ? 'text-muted-foreground mt-1 text-sm' : 'sr-only'}>
          {description ?? title}
        </D.Description>
        <div className="mt-4">{children}</div>
      </D.Content>
    </D.Portal>
  );
}

const DialogTrigger = D.Trigger;
const DialogClose = D.Close;

export { Dialog, DialogClose, DialogContent, DialogTrigger };
