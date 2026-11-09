import { z } from 'zod';

/** Response of the engine's and the collector's health endpoints. */
export const healthSchema = z.object({
  status: z.literal('ok'),
  service: z.enum(['engine', 'collector']),
  version: z.string(),
});
export type Health = z.infer<typeof healthSchema>;

/**
 * Body of `POST /collect/v` sent by `p.js` (SPEC §5.2).
 * Phase 0 defines the shape only; the collector pipeline arrives in Phase 3.
 */
export const collectVisitSchema = z
  .object({
    siteKey: z.string().min(8).max(64),
    path: z.string().max(512),
    referrer: z.string().max(512).optional(),
    utm: z
      .object({
        source: z.string().max(128).optional(),
        medium: z.string().max(128).optional(),
        campaign: z.string().max(128).optional(),
        term: z.string().max(128).optional(),
        content: z.string().max(128).optional(),
      })
      .strict()
      .optional(),
    at: z.number().int().positive(),
  })
  .strict();
export type CollectVisit = z.infer<typeof collectVisitSchema>;

/** Body of `POST /collect/identify` (SPEC §5.2). */
export const collectIdentifySchema = z
  .object({
    siteKey: z.string().min(8).max(64),
    emailDomain: z.string().min(3).max(253),
  })
  .strict();
export type CollectIdentify = z.infer<typeof collectIdentifySchema>;
