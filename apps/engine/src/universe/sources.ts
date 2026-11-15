/**
 * Dataset sources for the company universe (SPEC §5.1 step 1). Each maps a raw record to a
 * company row, or says why it was dropped. LinkedIn-derived columns (PDL's `linkedin_url`
 * and `id`) are never read.
 */
import type { Config } from '../config.ts';
import type { UniverseSource } from '../db/schema.ts';
import {
  clean,
  domainFromWebsite,
  foundedYear,
  isUsCountry,
  nameKey,
  stateCode,
  type UniverseRow,
} from './normalize.ts';
import { jsonArrayRows, readRecords, type RawRecord } from './records.ts';

export type Mapped =
  | { kind: 'company'; row: UniverseRow }
  | { kind: 'match'; nameKey: string; cik: string; ticker: string | null }
  | { kind: 'drop'; reason: 'not_us' | 'no_website' | 'invalid' };

export interface SourceDef {
  id: UniverseSource;
  label: string;
  licence: string;
  homepage: string;
  /** Attribution shown on source dots and in NOTICE. */
  attribution: string;
  /** Fixed download URL (EDGAR), else the user gives a URL or file. */
  fixedUrl?: string;
  /** Why the source can't run on this instance (missing env), or null. */
  unavailable(config: Config): string | null;
  headers(config: Config): Record<string, string>;
  records(chunks: AsyncIterable<string>): AsyncGenerator<RawRecord>;
  map(rec: RawRecord): Mapped;
  /** True when rows are filtered to the workspace ICP while streaming. */
  icpFilter: boolean;
}

const pick = (rec: RawRecord, ...keys: string[]) => {
  for (const k of keys) if (rec[k] !== undefined && rec[k] !== '') return rec[k];
  return undefined;
};

export const PDL: SourceDef = {
  id: 'pdl',
  label: 'People Data Labs free company dataset',
  licence: 'CC BY 4.0',
  homepage: 'https://www.peopledatalabs.com/company-dataset',
  attribution:
    'Company data © People Data Labs, CC BY 4.0 (modified: US only, LinkedIn fields removed)',
  unavailable: () => null,
  headers: () => ({}),
  records: readRecords,
  icpFilter: true,
  map(rec) {
    if (rec.__invalid) return { kind: 'drop', reason: 'invalid' };
    if (!isUsCountry(pick(rec, 'country'))) return { kind: 'drop', reason: 'not_us' };
    const domain = domainFromWebsite(pick(rec, 'website', 'domain'));
    if (!domain) return { kind: 'drop', reason: 'no_website' };
    const name = clean(pick(rec, 'name'), 200) ?? domain;
    return {
      kind: 'company',
      row: {
        domain,
        name,
        state: stateCode(pick(rec, 'region', 'state')),
        city: clean(pick(rec, 'locality', 'city'), 100),
        industry: clean(pick(rec, 'industry'), 120),
        naics: null,
        sizeRange: clean(pick(rec, 'size'), 40),
        foundedYear: foundedYear(pick(rec, 'founded')),
      },
    };
  },
};

export const SEC_EDGAR: SourceDef = {
  id: 'sec-edgar',
  label: 'SEC EDGAR company tickers',
  licence: 'US government data (public)',
  homepage: 'https://www.sec.gov/os/accessing-edgar-data',
  attribution: 'SEC EDGAR (U.S. Securities and Exchange Commission)',
  fixedUrl: 'https://www.sec.gov/files/company_tickers_exchange.json',
  unavailable: (config) =>
    config.secUserAgent ? null : 'set LE_SEC_USER_AGENT (SEC requires a contact User-Agent)',
  headers: (config) => ({ 'user-agent': config.secUserAgent ?? '' }),
  records: jsonArrayRows,
  icpFilter: false,
  // EDGAR has no websites (docs/providers.md finding #7): it only tags companies the other
  // datasets already hold, matched by normalised name.
  map(rec) {
    const key = nameKey(pick(rec, 'name'));
    const cik = pick(rec, 'cik');
    if (!key || cik === undefined) return { kind: 'drop', reason: 'invalid' };
    return {
      kind: 'match',
      nameKey: key,
      cik: String(cik).padStart(10, '0'),
      ticker: clean(pick(rec, 'ticker'), 12),
    };
  },
};

export const SOURCES: Record<string, SourceDef> = { pdl: PDL, 'sec-edgar': SEC_EDGAR };
