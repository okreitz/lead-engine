import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

/** At least 12 characters; argon2id handles the rest. */
export const passwordSchema = z.string().min(12).max(256);

export const setupBodySchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    workspaceName: z.string().trim().min(1).max(80),
    setupToken: z.string().max(256).optional(),
  })
  .strict();

export const loginBodySchema = z
  .object({ email: emailSchema, password: z.string().min(1).max(256) })
  .strict();

export const changePasswordBodySchema = z
  .object({ currentPassword: z.string().min(1).max(256), newPassword: passwordSchema })
  .strict();

export const switchWorkspaceBodySchema = z.object({ workspaceId: z.string().min(1) }).strict();

export const createWorkspaceBodySchema = z
  .object({ name: z.string().trim().min(1).max(80) })
  .strict();

export const updateWorkspaceBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    monthlyBudgetUsd: z.number().min(0).max(100_000).optional(),
    timezone: z.string().min(1).max(64).optional(),
    settings: z
      .object({
        stages: z.array(z.string().trim().min(1).max(40)).min(2).max(20).optional(),
        scoreWeights: z
          .object({ fit: z.number().min(0).max(1), intent: z.number().min(0).max(1) })
          .optional(),
        fitThreshold: z.number().min(0).max(100).optional(),
        subCaps: z
          .object({
            personas: z.number().min(0).max(1).optional(),
            conversations: z.number().min(0).max(1).optional(),
            visits: z.number().min(0).max(1).optional(),
            llm: z.number().min(0).max(1).optional(),
          })
          .optional(),
        enforceSubCaps: z.boolean().optional(),
        llmAdapter: z.enum(['claude-cli', 'anthropic-api']).optional(),
        llmModel: z.string().min(1).max(80).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Deleting a workspace requires typing its exact name (CLAUDE.md). */
export const deleteWorkspaceBodySchema = z.object({ confirmName: z.string() }).strict();

export const addMemberBodySchema = z
  .object({
    email: emailSchema,
    /** Initial password when the user does not exist yet. */
    password: passwordSchema.optional(),
    role: z.enum(['owner', 'member']).default('member'),
  })
  .strict();

export const createTokenBodySchema = z
  .object({ name: z.string().trim().min(1).max(80), scope: z.enum(['read', 'write']) })
  .strict();

export const providerKeyBodySchema = z.object({ key: z.string().trim().min(8).max(512) }).strict();
