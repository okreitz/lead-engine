import type { z } from 'zod';

export type LlmAdapterName = 'claude-cli' | 'anthropic-api' | 'fake';

export interface LlmRequest {
  /** Trusted instructions only. */
  system: string;
  /** Built with `buildPrompt`, so untrusted text sits inside delimited data blocks. */
  prompt: string;
  /** Output schema. Both adapters ask for structured output; the result is re-validated. */
  schema: z.ZodObject;
  model: string;
  maxOutputTokens: number;
  /** Per-call ceiling passed to the CLI's --max-budget-usd (a safety net, not our budget). */
  callCapUsd: number;
}

export interface LlmResult {
  /** Raw structured output; validate with the request schema before use. */
  output: unknown;
  usd: number;
  estimated: boolean;
  inputTokens: number;
  outputTokens: number;
  /** The model that actually answered (e.g. the alias `haiku` resolves to an id). */
  model: string;
}

/** No tools, ever (SPEC §4.4). */
export interface LlmAdapter {
  name: LlmAdapterName;
  /** Where the key comes from: 'anthropic' workspace key, or none for the CLI. */
  keyProvider: string | null;
  defaultModel: string;
  complete(request: LlmRequest, env: { apiKey: string | null }): Promise<LlmResult>;
}
