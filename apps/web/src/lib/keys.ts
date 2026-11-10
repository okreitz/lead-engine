'use client';
import { useEffect, useLayoutEffect, useRef } from 'react';

/** True when the key event comes from a text field, where shortcuts must not fire. */
export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

/**
 * Single-key shortcuts for a page (`j`, `k`, `x`, `[`…). Ignored while typing or with
 * Ctrl/Meta/Alt held. The handler map can change every render.
 */
export function useKeys(map: Record<string, (e: KeyboardEvent) => void>, enabled = true): void {
  const ref = useRef(map);
  useLayoutEffect(() => {
    ref.current = map;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((window as { __leGPending?: boolean }).__leGPending) return; // a G-chord is in progress
      const fn = ref.current[e.key];
      if (fn) {
        e.preventDefault();
        fn(e);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

/** The global shortcut list, shown on the `?` sheet (docs/ui.md §2). */
export const SHORTCUTS: { group: string; keys: string; label: string }[] = [
  { group: 'Global', keys: '⌘K / Ctrl K', label: 'Command palette: search and commands' },
  { group: 'Global', keys: '/', label: 'Search' },
  { group: 'Global', keys: '?', label: 'This shortcut sheet' },
  { group: 'Global', keys: 'Esc', label: 'Close the side sheet or dialog' },
  { group: 'Go to', keys: 'G T', label: 'Today' },
  { group: 'Go to', keys: 'G I', label: 'Inbox' },
  { group: 'Go to', keys: 'G A', label: 'Accounts' },
  { group: 'Go to', keys: 'G P', label: 'Pipeline' },
  { group: 'Go to', keys: 'G V', label: 'Visitors' },
  { group: 'Go to', keys: 'G O', label: 'Offer profile' },
  { group: 'Go to', keys: 'G R', label: 'ROI' },
  { group: 'Go to', keys: 'G S', label: 'Settings' },
  { group: 'Lists', keys: 'J / K', label: 'Next / previous row' },
  { group: 'Lists', keys: 'X', label: 'Select row' },
  { group: 'Lists', keys: 'Space', label: 'Preview in the side sheet' },
  { group: 'Lists', keys: 'Enter', label: 'Open the full page' },
  { group: 'Lists', keys: 'S', label: 'Set stage of selected rows' },
  { group: 'Pipeline', keys: '[ / ]', label: 'Move the selected card one stage left / right' },
];

export const GO_TO: Record<string, string> = {
  t: '/',
  i: '/inbox',
  a: '/accounts',
  p: '/pipeline',
  v: '/visitors',
  o: '/offer',
  r: '/roi',
  s: '/settings',
};
