import { z } from 'zod';

const str = (max: number) => z.string().trim().min(1).max(max);
const list = (max: number, itemMax = 120) => z.array(str(itemMax)).max(max);

export const INTENT_KINDS = ['seeking', 'alternative', 'pain', 'recommendation'] as const;

export const icpSchema = z.object({
  industries: list(20),
  naics: z
    .array(
      z
        .string()
        .trim()
        .regex(/^\d{2,6}$/),
    )
    .max(20),
  /** e.g. "11-50", "51-200", "201-1000". */
  employeeRange: str(40),
  revenueRange: z.string().trim().max(40).nullable(),
  states: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[A-Z]{2}$/),
    )
    .max(51),
  techUses: list(20),
  techAvoids: list(20),
  mustHave: list(10, 200),
  exclude: list(20, 200),
});

export const personaSchema = z.object({
  title: str(120),
  seniority: str(60),
  department: str(80),
  pains: list(8, 200),
  titleKeywords: list(12, 60),
});

export const intentPhraseSchema = z.object({
  phrase: str(120),
  kind: z.enum(INTENT_KINDS),
  negative: list(10, 60),
});

/** The offer profile (SPEC §3 Offer, §4.1) as edited and approved by a human. */
export const offerProfileSchema = z.object({
  name: str(120),
  summary: str(2000),
  valueProps: list(10, 300),
  competitors: list(20, 120),
  icp: icpSchema,
  personas: z.array(personaSchema).min(1).max(8),
  intentPhrases: z.array(intentPhraseSchema).min(1).max(60),
});
export type OfferProfile = z.infer<typeof offerProfileSchema>;

/**
 * Fields a person reviews one by one on an LLM draft (docs/ui.md §3.7): accept, edit or
 * reject. An LLM draft cannot be approved until every field has a decision.
 */
export const REVIEW_FIELDS = [
  'name',
  'summary',
  'valueProps',
  'competitors',
  'icp.industries',
  'icp.naics',
  'icp.employeeRange',
  'icp.revenueRange',
  'icp.states',
  'icp.techUses',
  'icp.techAvoids',
  'icp.mustHave',
  'icp.exclude',
  'personas',
  'intentPhrases',
] as const;
export type ReviewField = (typeof REVIEW_FIELDS)[number];
export const REVIEW_DECISIONS = ['accepted', 'edited', 'rejected'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];
export const reviewSchema = z.partialRecord(z.enum(REVIEW_FIELDS), z.enum(REVIEW_DECISIONS));

/** What the LLM must return: the same shape with SPEC §4.1's 20–40 intent phrases. */
export const offerDraftSchema = offerProfileSchema.extend({
  intentPhrases: z.array(intentPhraseSchema).min(20).max(40),
});

/** The draft plus a one-sentence "why" per field, shown next to each field for review. */
export const offerDraftLlmSchema = offerDraftSchema.extend({
  rationale: z
    .array(z.object({ field: z.enum(REVIEW_FIELDS), why: str(300) }))
    .max(REVIEW_FIELDS.length),
});

export const createOfferBodySchema = z
  .object({
    websiteUrl: z.string().trim().min(4).max(2000),
    name: z.string().trim().min(1).max(120).optional(),
    notes: z.string().trim().max(4000).optional(),
    competitors: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  })
  .strict();

export const saveOfferVersionBodySchema = z
  .object({ data: offerProfileSchema, review: reviewSchema.optional() })
  .strict();

/** Live match preview while editing the ICP (docs/ui.md §3.7). */
export const offerPreviewBodySchema = z
  .object({
    // Loose on purpose: the preview runs on half-edited values.
    icp: z.object({
      industries: z.array(z.string().max(120)).max(20).default([]),
      naics: z.array(z.string().max(6)).max(20).default([]),
      employeeRange: z.string().max(40).default(''),
      states: z.array(z.string().max(2)).max(51).default([]),
      techUses: z.array(z.string().max(120)).max(20).default([]),
      techAvoids: z.array(z.string().max(120)).max(20).default([]),
      exclude: z.array(z.string().max(200)).max(20).default([]),
    }),
  })
  .strict();
