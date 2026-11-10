'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { CAN_SPAM_CHECKLIST } from '@/lib/crm';

/** Copy email, with the CAN-SPAM reminder shown first (SPEC §6, §9). */
export function CopyEmail({ email }: { email: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog onOpenChange={() => setCopied(false)}>
      <DialogTrigger asChild>
        <button type="button" className="font-mono text-xs hover:underline">
          {email}
        </button>
      </DialogTrigger>
      <DialogContent title="Before you email" description="CAN-SPAM applies to commercial email.">
        <ul className="list-disc pl-5 text-sm">
          {CAN_SPAM_CHECKLIST.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
          <Button
            onClick={async () => {
              await navigator.clipboard.writeText(email);
              setCopied(true);
            }}
          >
            {copied ? 'Copied' : `Copy ${email}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
