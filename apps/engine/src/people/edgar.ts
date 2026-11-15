/**
 * Officers of public companies from SEC EDGAR (SPEC §5.1 step 5): recent Form 3/4/5 filings'
 * `reportingOwner` entries with `isOfficer` (booleans come as true/false or 1/0). Needs the
 * declared `LE_SEC_USER_AGENT`; at most 10 requests/second (we stay well under).
 */
import { readJson, type HttpFetch } from './http.ts';

export interface Officer {
  name: string;
  title: string;
  url: string;
  isDirector: boolean;
}

const tag = (xml: string, name: string) =>
  new RegExp(`<${name}>\\s*(?:<value>)?\\s*([^<]*?)\\s*(?:</value>)?\\s*</${name}>`, 'i').exec(
    xml,
  )?.[1] ?? null;
const truthy = (v: string | null) => v === '1' || v?.toLowerCase() === 'true';
const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'");

/** EDGAR lists owners as "Last First Middle"; turn that into "First Middle Last". */
export function ownerName(raw: string): string {
  const parts = decode(raw).trim().split(/\s+/);
  if (parts.length < 2) return decode(raw).trim();
  const [last, ...rest] = parts;
  const cap = (w: string) =>
    w.length <= 2 && w.endsWith('.')
      ? w.toUpperCase()
      : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  return [...rest, last!].map(cap).join(' ');
}

export function parseOwners(xml: string, url: string): Officer[] {
  const out: Officer[] = [];
  for (const m of xml.matchAll(/<reportingOwner>([\s\S]*?)<\/reportingOwner>/gi)) {
    const block = m[1]!;
    const name = tag(block, 'rptOwnerName');
    if (!name || !truthy(tag(block, 'isOfficer'))) continue;
    out.push({
      name: ownerName(name),
      title: decode(tag(block, 'officerTitle') ?? '').slice(0, 160) || 'Officer',
      url,
      isDirector: truthy(tag(block, 'isDirector')),
    });
  }
  return out;
}

export async function edgarOfficers(opts: {
  cik: string;
  userAgent: string;
  http: HttpFetch;
  sleep: (ms: number) => Promise<void>;
  maxFilings?: number;
}): Promise<Officer[]> {
  const headers = { 'user-agent': opts.userAgent, accept: 'application/json' };
  const cik = opts.cik.padStart(10, '0');
  const res = await opts.http(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers });
  if (res.status !== 200) return [];
  const sub = (await readJson(res)) as {
    filings?: {
      recent?: { form?: string[]; accessionNumber?: string[]; primaryDocument?: string[] };
    };
  } | null;
  const recent = sub?.filings?.recent;
  if (!recent?.form || !recent.accessionNumber || !recent.primaryDocument) return [];
  const byName = new Map<string, Officer>();
  let fetched = 0;
  for (let i = 0; i < recent.form.length && fetched < (opts.maxFilings ?? 12); i++) {
    if (!['3', '4', '5'].includes(recent.form[i]!)) continue;
    const acc = recent.accessionNumber[i]!.replace(/-/g, '');
    const doc = recent.primaryDocument[i]!.split('/').pop()!;
    if (!/\.xml$/i.test(doc)) continue;
    const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc}/${doc}`;
    await opts.sleep(200); // ≤ 5 requests/second
    fetched++;
    const r = await opts.http(url, { headers: { 'user-agent': opts.userAgent } });
    if (r.status !== 200) continue;
    for (const o of parseOwners(await r.text(), url))
      if (!byName.has(o.name)) byName.set(o.name, o);
  }
  return [...byName.values()];
}
