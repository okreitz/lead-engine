import { z } from 'zod';

const opt = (max: number) => z.string().trim().max(max).nullish();

export const createAccountBodySchema = z
  .object({
    domain: z.string().trim().min(3).max(253),
    name: z.string().trim().min(1).max(200),
    country: z.string().trim().min(2).max(60).default('US'),
    state: opt(60),
    city: opt(100),
    industry: opt(120),
    naics: opt(10),
    sizeRange: opt(40),
    foundedYear: z.number().int().min(1600).max(2100).nullish(),
    stage: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

export const updateAccountBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    state: opt(60),
    city: opt(100),
    industry: opt(120),
    naics: opt(10),
    sizeRange: opt(40),
    foundedYear: z.number().int().min(1600).max(2100).nullish(),
    ownerUserId: z.string().nullish(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .strict();

export const stageBodySchema = z.object({ stage: z.string().trim().min(1).max(40) }).strict();

export const EMAIL_STATUS_VALUES = [
  'verified',
  'pattern_verified',
  'risky',
  'catch_all',
  'unknown',
  'invalid',
] as const;

export const contactBodySchema = z
  .object({
    fullName: z.string().trim().min(1).max(200),
    title: opt(200),
    seniority: opt(60),
    department: opt(100),
    email: z.string().trim().max(254).nullish(),
    emailStatus: z.enum(EMAIL_STATUS_VALUES).nullish(),
    phone: opt(40),
  })
  .strict();

export const dealBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    stage: z.string().trim().min(1).max(40).optional(),
    valueUsd: z.number().min(0).max(1e10).nullish(),
    outcome: z.enum(['won', 'lost']).nullish(),
  })
  .strict();

export const activityBodySchema = z
  .object({
    kind: z.enum(['note', 'email', 'call', 'meeting', 'reply']),
    body: z.string().trim().min(1).max(10_000),
    contactId: z.string().nullish(),
    dealId: z.string().nullish(),
    at: z.number().int().positive().optional(),
  })
  .strict();

export const nextStepBodySchema = z
  .object({ text: z.string().trim().min(1).max(500), dueAt: z.number().int().positive().nullish() })
  .strict();

export const suppressionBodySchema = z
  .object({
    kind: z.enum(['email', 'domain']),
    value: z.string().trim().min(3).max(254),
    reason: z.string().trim().min(1).max(200).default('opt-out'),
  })
  .strict();

export const CSV_ENTITIES = ['accounts', 'contacts', 'deals'] as const;
export type CsvEntity = (typeof CSV_ENTITIES)[number];
