'use client';
import { useEffect } from 'react';
import { AccountView } from '@/components/account-view';
import { useSheet } from '@/lib/sheet';

/**
 * Right-hand account sheet, opened from any list via `?sheet=<id>` (docs/ui.md §3.3).
 * Not a modal: the list stays usable behind it; Esc closes it.
 */
export function RecordSheet() {
  const sheet = useSheet();
  const { current, close } = sheet;
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, close]);
  if (!current) return null;
  return (
    <aside
      aria-label="Account preview"
      className="bg-background fixed inset-y-0 right-0 z-40 w-full max-w-xl overflow-y-auto border-l shadow-2xl"
    >
      <AccountView id={current} compact onClose={close} />
    </aside>
  );
}
