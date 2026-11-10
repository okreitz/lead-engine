import type { OfferProfile, ReviewDecision, ReviewField } from '@le/shared';

export type Review = Partial<Record<ReviewField, ReviewDecision>>;

export const FIELD_LABEL: Record<ReviewField, string> = {
  name: 'Name',
  summary: 'Summary',
  valueProps: 'Value propositions',
  competitors: 'Competitors',
  'icp.industries': 'Industries',
  'icp.naics': 'NAICS codes',
  'icp.employeeRange': 'Employee range',
  'icp.revenueRange': 'Revenue range',
  'icp.states': 'States',
  'icp.techUses': 'Uses technology',
  'icp.techAvoids': 'Avoids technology',
  'icp.mustHave': 'Must have',
  'icp.exclude': 'Exclude',
  personas: 'Personas',
  intentPhrases: 'Intent phrases',
};

type Value = OfferProfile[keyof OfferProfile] | OfferProfile['icp'][keyof OfferProfile['icp']];

export function getField(d: OfferProfile, f: ReviewField): Value {
  if (f.startsWith('icp.')) return d.icp[f.slice(4) as keyof OfferProfile['icp']];
  return d[f as keyof OfferProfile];
}

export function setField(d: OfferProfile, f: ReviewField, value: unknown): OfferProfile {
  if (f.startsWith('icp.')) return { ...d, icp: { ...d.icp, [f.slice(4)]: value } };
  return { ...d, [f]: value };
}

/** What a rejected field falls back to when there is no approved version. */
export function emptyOf(f: ReviewField): unknown {
  if (f === 'name' || f === 'summary' || f === 'icp.employeeRange') return '';
  if (f === 'icp.revenueRange') return null;
  return [];
}

/** A field as comparable text lines, for the diff. */
export function fieldLines(d: OfferProfile | null, f: ReviewField): string[] {
  if (!d) return [];
  const v = getField(d, f);
  if (v == null || v === '') return [];
  if (f === 'personas')
    return d.personas.map(
      (p) =>
        `${p.title} (${[p.seniority, p.department].filter(Boolean).join(', ')})` +
        (p.pains.length ? ` · pains: ${p.pains.join('; ')}` : '') +
        (p.titleKeywords.length ? ` · keywords: ${p.titleKeywords.join(', ')}` : ''),
    );
  if (f === 'intentPhrases')
    return d.intentPhrases.map(
      (p) => `"${p.phrase}" [${p.kind}]${p.negative.length ? ` −${p.negative.join(', −')}` : ''}`,
    );
  return Array.isArray(v) ? v.map(String) : [String(v)];
}

export interface FieldDiff {
  field: ReviewField;
  removed: string[];
  added: string[];
  kept: string[];
}

/** Field-level diff between two versions: per field, the lines removed, added and kept. */
export function diffVersions(a: OfferProfile | null, b: OfferProfile | null): FieldDiff[] {
  return (Object.keys(FIELD_LABEL) as ReviewField[]).map((field) => {
    const before = fieldLines(a, field);
    const after = fieldLines(b, field);
    const inBefore = new Set(before);
    const inAfter = new Set(after);
    return {
      field,
      removed: before.filter((x) => !inAfter.has(x)),
      added: after.filter((x) => !inBefore.has(x)),
      kept: after.filter((x) => inBefore.has(x)),
    };
  });
}
