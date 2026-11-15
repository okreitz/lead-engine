/** Company matching keys, shared by manual entry and the dataset importers (no CRM imports). */
import { parseRange } from '../crm/scoring.ts';

const SUFFIXES = new Set([
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'llc',
  'l l c',
  'ltd',
  'limited',
  'plc',
  'lp',
  'llp',
  'pllc',
  'pc',
  'sa',
  'nv',
  'ag',
]);

/** "The Acme Co., Inc." → "acme"; used to match EDGAR names to dataset companies. */
export function nameKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const words = raw
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\/[a-z]{2}\/?$/, '') // EDGAR state suffixes like "/DE/"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (words[0] === 'the' && words.length > 1) words.shift();
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1]!)) words.pop();
  const key = words.join(' ');
  return key || null;
}

export function sizeBounds(range: string | null): {
  sizeMin: number | null;
  sizeMax: number | null;
} {
  const r = parseRange(range);
  if (!r) return { sizeMin: null, sizeMax: null };
  return { sizeMin: r[0], sizeMax: Number.isFinite(r[1]) ? r[1] : null };
}
