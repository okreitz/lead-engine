import { z } from 'zod';

const year = z.number().int().min(1600).max(2100).nullable();

/** Overrides for the ICP-derived candidate filter (SPEC §5.1 step 2). */
export const candidateFiltersSchema = z
  .object({
    industries: z.array(z.string().trim().min(1).max(120)).max(20),
    naics: z
      .array(
        z
          .string()
          .trim()
          .regex(/^\d{2,6}$/),
      )
      .max(20),
    sizeMin: z.number().int().min(0).max(10_000_000).nullable(),
    sizeMax: z.number().int().min(0).max(10_000_000).nullable(),
    states: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[A-Z]{2}$/),
      )
      .max(51),
    foundedFrom: year,
    foundedTo: year,
    exclude: z.array(z.string().trim().min(1).max(200)).max(20),
  })
  .partial()
  .strict();

export const personaRunBodySchema = z
  .object({
    limit: z.number().int().min(1).max(2_000).default(500),
    filters: candidateFiltersSchema.optional(),
    /** Detect technologies with httpx when it is installed. */
    tech: z.boolean().default(true),
    /** Then find people and emails for the new accounts (costs more; estimated separately). */
    people: z.boolean().default(false),
    /** The offer to find companies for; required when more than one offer is approved. */
    offerId: z.string().min(1).max(64).optional(),
  })
  .strict();
export type PersonaRunBody = z.infer<typeof personaRunBodySchema>;
