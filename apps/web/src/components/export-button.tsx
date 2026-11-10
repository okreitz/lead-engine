'use client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { CAN_SPAM_CHECKLIST } from '@/lib/crm';

/** CSV export behind the CAN-SPAM checklist (SPEC §6, §9). Suppressed records are never exported. */
export function ExportButton({ entity }: { entity: 'accounts' | 'contacts' | 'deals' }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">Export {entity} CSV</Button>
      </DialogTrigger>
      <DialogContent
        title={`Export ${entity}`}
        description="Suppressed emails and domains are left out. If you use this list for outreach, follow CAN-SPAM:"
      >
        <ul className="list-disc pl-5 text-sm">
          {CAN_SPAM_CHECKLIST.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <DialogClose asChild>
            <Button asChild>
              <a href={`/api/v1/export/${entity}.csv`} download>
                Download
              </a>
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
