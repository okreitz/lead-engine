import * as React from 'react';
import { cn } from '@/lib/utils';

const field =
  'border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 rounded-md border bg-transparent text-sm shadow-xs outline-none focus-visible:ring-[3px] disabled:opacity-50';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(field, 'flex h-9 w-full min-w-0 px-3 py-1', className)}
      {...props}
    />
  );
}

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(field, 'flex min-h-16 w-full px-3 py-2', className)}
      {...props}
    />
  );
}

function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return <select data-slot="select" className={cn(field, 'h-9 px-2', className)} {...props} />;
}

function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label className={cn('flex flex-col gap-1.5 text-sm font-medium', className)} {...props} />
  );
}

export { Input, Label, NativeSelect, Textarea };
