/**
 * Drops LinkedIn-derived data at the provider boundary (CLAUDE.md "Data sources"): any key
 * that names LinkedIn or Sales Navigator, and any string value that points at linkedin.com,
 * at every depth. Applied to every provider response before it is cached, returned or stored.
 */
const LINKEDIN_KEY = /linked_?in|sales_?nav|\bli_?(url|id|profile)|navigator_?id/i;
const LINKEDIN_VALUE = /(^|[/.@])(?:[a-z]{2,3}\.)?linkedin\.com\b|\blnkd\.in\b/i;

export function stripLinkedIn<T>(value: T): T {
  return strip(value) as T;
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((v) => !(typeof v === 'string' && LINKEDIN_VALUE.test(v))).map(strip);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (LINKEDIN_KEY.test(k)) continue;
      if (typeof v === 'string' && LINKEDIN_VALUE.test(v)) continue;
      out[k] = strip(v);
    }
    return out;
  }
  return value;
}
