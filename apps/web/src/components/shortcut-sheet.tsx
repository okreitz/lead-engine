'use client';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { SHORTCUTS } from '@/lib/keys';

/** `?` lists every shortcut (docs/ui.md principle 5). */
export function ShortcutSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Keyboard shortcuts" className="max-w-lg">
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
          {groups.map((g) => (
            <section key={g}>
              <h3 className="text-muted-foreground mb-1 text-xs font-medium uppercase">{g}</h3>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                  <div key={s.keys + s.label} className="contents">
                    <dt>
                      <kbd className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                        {s.keys}
                      </kbd>
                    </dt>
                    <dd className="text-muted-foreground">{s.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
