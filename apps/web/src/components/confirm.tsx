'use client';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';

/**
 * Confirmation dialog for destructive actions (CLAUDE.md). With `typeToConfirm`, the user
 * must type that exact text (e.g. the workspace name) before the button enables.
 */
export function ConfirmButton({
  trigger,
  title,
  description,
  confirmLabel = 'Delete',
  typeToConfirm,
  onConfirm,
}: {
  trigger: ReactNode;
  title: string;
  description?: string;
  confirmLabel?: string;
  typeToConfirm?: string;
  onConfirm: () => Promise<unknown> | void;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = !typeToConfirm || typed === typeToConfirm;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        setTyped('');
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent title={title} {...(description ? { description } : {})}>
        {typeToConfirm ? (
          <Label>
            <span>
              Type <span className="font-mono">{typeToConfirm}</span> to confirm
            </span>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
          </Label>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            variant="destructive"
            disabled={!ok || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                setOpen(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
