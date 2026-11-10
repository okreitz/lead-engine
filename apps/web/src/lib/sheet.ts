'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

/**
 * The account side sheet lives in the URL (`?sheet=<accountId>`), so any list can open it,
 * back/forward work and the view stays shareable (docs/ui.md §3.3, RecordSheet).
 */
export function useSheet() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = params.get('sheet');
  const set = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (id) next.set('sheet', id);
      else next.delete('sheet');
      const qs = next.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
    },
    [params, pathname, router],
  );
  return { current, open: (id: string) => set(id), close: () => set(null) };
}
