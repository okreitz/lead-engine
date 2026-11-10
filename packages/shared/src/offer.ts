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

/** What the LLM must return: the same shape with SPEC §4.1's 20–40 intent phrases. */
export const offerDraftSchema = offerProfileSchema.extend({
  intentPhrases: z.array(intentPhraseSchema).min(20).max(40),
});

export const createOfferBodySchema = z
  .object({
    websiteUrl: z.string().trim().min(4).max(2000),
    name: z.string().trim().min(1).max(120).optional(),
    notes: z.string().trim().max(4000).optional(),
    competitors: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  })
  .strict();

export const saveOfferVersionBodySchema = z.object({ data: offerProfileSchema }).strict();
