/**
 * Runs an LLM task through the provider layer, so it is budget-checked, cached and metered
 * like every other paid call. Output is zod-validated; invalid output is never used.
 */
import type { Stream } from '@le/shared';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { AppContext } from '../api/context.ts';
import { workspaces } from '../db/schema.ts';
import { callProvider, ProviderCallError } from '../providers/index.ts';
import type { ProviderAdapter } from '../providers/types.ts';
import { anthropicApiAdapter } from './anthropic-api.ts';
import { claudeCliAdapter } from './claude-cli.ts';
import { estimateCallUsd } from './pricing.ts';
import { UNTRUSTED_RULES } from './prompt.ts';
import type { LlmAdapter, LlmRequest, LlmResult } from './types.ts';

export class LlmOutputError extends Error {
  override name = 'LlmOutputError';
}

/** Adapter for a workspace: the test override, else its setting, else API when a key exists. */
export function llmAdapterFor(ctx: AppContext, workspaceId: string): LlmAdapter {
  if (ctx.llm) return ctx.llm;
  const ws = ctx.db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  const choice =
    ws?.settings.llmAdapter ?? (ctx.config.anthropicApiKey ? 'anthropic-api' : 'claude-cli');
  return choice === 'claude-cli' ? claudeCliAdapter() : anthropicApiAdapter();
}

/** Wraps an LLM adapter as the provider-layer `llm` operation. */
export function llmProvider(adapter: LlmAdapter): ProviderAdapter<LlmRequest, LlmResult> {
  return {
    provider: adapter.name,
    operation: 'llm',
    keyProvider: adapter.keyProvider,
    cacheTtlMs: 7 * 24 * 3600_000,
    estimateUsd: (r) => estimateCallUsd(r.model, r.system, r.prompt, r.maxOutputTokens),
    cacheKey: (r) => ({
      system: r.system,
      prompt: r.prompt,
      model: r.model,
      schema: r.schema.toJSONSchema(),
    }),
    async call(request, env) {
      const result = await adapter.complete(request, env);
      return {
        value: result,
        usd: result.usd,
        units: result.inputTokens + result.outputTokens,
        estimated: result.estimated,
        confident: true,
        meta: {
          model: result.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        },
      };
    },
  };
}

export interface LlmTask<S extends z.ZodObject> {
  workspaceId: string;
  stream: Stream;
  jobId?: string;
  /** Trusted instructions; the untrusted-data rules are appended. */
  system: string;
  prompt: string;
  schema: S;
  maxOutputTokens?: number;
  model?: string;
  refresh?: boolean;
  /** The record the call is for, linked from the ledger. */
  ledgerEntity?: { type: string; id: string };
}

export async function runLlm<S extends z.ZodObject>(
  ctx: AppContext,
  task: LlmTask<S>,
): Promise<z.infer<S>> {
  const adapter = llmAdapterFor(ctx, task.workspaceId);
  const ws = ctx.db.select().from(workspaces).where(eq(workspaces.id, task.workspaceId)).get();
  const model = task.model ?? ws?.settings.llmModel ?? adapter.defaultModel;
  const maxOutputTokens = task.maxOutputTokens ?? 4_000;
  const request: LlmRequest = {
    system: `${task.system.trim()}\n\n${UNTRUSTED_RULES}`,
    prompt: task.prompt,
    schema: task.schema,
    model,
    maxOutputTokens,
    callCapUsd: 0,
  };
  request.callCapUsd = Math.max(
    0.01,
    Number(
      (estimateCallUsd(model, request.system, request.prompt, maxOutputTokens) * 2).toFixed(4),
    ),
  );

  const res = await callProvider(ctx, llmProvider(adapter), request, {
    workspaceId: task.workspaceId,
    stream: task.stream,
    ...(task.jobId ? { jobId: task.jobId } : {}),
    ...(task.refresh ? { refresh: true } : {}),
    ...(task.ledgerEntity ? { ledgerEntity: task.ledgerEntity } : {}),
    accept: (r) => task.schema.safeParse(r.output).success,
  });
  if (res.status !== 'ok')
    throw new ProviderCallError(`LLM call skipped: ${res.reason}`, null, false);
  return parseLlmOutput(task.schema, res.value.output);
}

/** Only schema-valid output is used (SPEC §4.4). */
export function parseLlmOutput<S extends z.ZodObject>(schema: S, output: unknown): z.infer<S> {
  const parsed = schema.safeParse(output);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new LlmOutputError(
      `LLM output failed validation at ${first?.path.join('.') || '(root)'}: ${first?.message}`,
    );
  }
  return parsed.data;
}

export type { LlmAdapter, LlmRequest, LlmResult } from './types.ts';
