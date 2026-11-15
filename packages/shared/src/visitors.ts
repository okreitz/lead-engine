import { z } from 'zod';

/** Intent page of a site: a path prefix and a label (pricing, demo, contact, …). */
export const intentPageSchema = z.object({
  path: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^\/[^\s?#]*$/, 'a path starting with /, without query or #'),
  label: z.string().trim().min(1).max(40),
});
export type IntentPageInput = z.infer<typeof intentPageSchema>;

export const siteCreateSchema = z.object({
  domain: z.string().trim().min(3).max(253),
});

export const siteUpdateSchema = z.object({
  intentPages: z.array(intentPageSchema).max(20),
});

/** Grouped dropped-traffic categories for the Visitors header (docs/ui.md §3.6). */
export const DROPPED_GROUPS = {
  nonUs: ['non_us'],
  bot: ['bot'],
  network: ['isp', 'mobile', 'hosting', 'vpn'],
  unmatched: ['unmatched', 'suppressed'],
  unclassified: ['unclassified', 'rate_limited'],
} as const;

export const MATCH_SOURCE_LABELS: Record<string, string> = {
  provider: 'ipapi.is',
  ptr: 'PTR',
  form: 'Form fill',
  asn: 'ASN',
  manual: 'Manual',
};
