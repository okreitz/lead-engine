import { z } from 'zod';

export const UNIVERSE_SOURCE_IDS = ['pdl', 'sec-edgar'] as const;

/** Start a company-universe import (Settings → Company data). */
export const startImportBodySchema = z
  .object({
    source: z.enum(UNIVERSE_SOURCE_IDS),
    /** Download link (https). PDL sends one after its download form; EDGAR's is fixed. */
    url: z.string().trim().url().max(4000).optional(),
    /** Or a file an operator copied into the data volume's `imports/` folder. */
    file: z.string().trim().max(200).optional(),
    /** `icp`: keep only rows that may fit the approved ICP; `all`: every US company with a website. */
    filter: z.enum(['icp', 'all']).default('icp'),
  })
  .strict();
export type StartImportBody = z.infer<typeof startImportBodySchema>;
