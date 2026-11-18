/**
 * Normalisers shared by the dataset importers: domains from website fields, US state codes,
 * company-name keys for cross-dataset matching, sizes and founded years.
 */
import { isBlockedSite } from '../crawler/crawler.ts';
import { isValidDomain } from '../crm/accounts.ts';
import { overlaps, parseRange } from '../crm/scoring.ts';
import { nameKey, sizeBounds } from './keys.ts';

export { nameKey, sizeBounds };
import type { ImportFilter } from '../db/schema.ts';

const STATES: Record<string, string> = {
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  'district of columbia': 'DC',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
  'puerto rico': 'PR',
};
const CODES = new Set(Object.values(STATES));

/** "texas", "Texas", "TX" → "TX"; anything else → null. */
export function stateCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;
  if (s.length === 2 && CODES.has(s.toUpperCase())) return s.toUpperCase();
  return STATES[s] ?? null;
}

const US = new Set(['us', 'usa', 'united states', 'united states of america', 'u.s.', 'u.s.a.']);
export function isUsCountry(raw: unknown): boolean {
  return typeof raw === 'string' && US.has(raw.trim().toLowerCase());
}

/** "https://www.Acme.com/about" → "acme.com"; invalid, blocked (LinkedIn, …) → null. */
export function domainFromWebsite(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let d = raw.trim().toLowerCase();
  if (!d) return null;
  d = d.replace(/^[a-z]+:\/\//, '').split(/[/?#\s]/)[0] ?? '';
  d = d
    .replace(/:\d+$/, '')
    .replace(/^www\d?\./, '')
    .replace(/\.$/, '');
  if (!isValidDomain(d) || isBlockedSite(d)) return null;
  return d;
}

export function foundedYear(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseFloat(raw) : NaN;
  if (!Number.isFinite(n)) return null;
  const y = Math.trunc(n);
  return y >= 1600 && y <= 2100 ? y : null;
}

export function clean(raw: unknown, max = 200): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

export interface UniverseRow {
  domain: string;
  name: string;
  state: string | null;
  city: string | null;
  industry: string | null;
  naics: string | null;
  sizeRange: string | null;
  foundedYear: number | null;
}

/**
 * The ICP prefilter applied while streaming (lenient: unknown values pass, so the SQL
 * candidate filter and the fit score decide later). Returns the reason a row is dropped.
 */
export function icpDropReason(row: UniverseRow, f: ImportFilter): string | null {
  if (f.anyOf?.length) return f.anyOf.every((g) => icpDropReason(row, g)) ? 'icp' : null;
  if (f.exclude.length && overlaps(`${row.name} ${row.industry ?? ''}`, f.exclude)) return 'icp';
  if (f.industries.length && row.industry && !overlaps(row.industry, f.industries)) return 'icp';
  const want = parseRange(f.employeeRange);
  const have = parseRange(row.sizeRange);
  if (want && have && !(have[0] <= want[1] && have[1] >= want[0])) return 'icp';
  if (f.states.length && row.state && !f.states.includes(row.state)) return 'icp';
  return null;
}
