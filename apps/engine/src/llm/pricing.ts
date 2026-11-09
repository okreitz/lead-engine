/**
 * USD per million tokens (prompts ≤ 100k tokens), from docs/providers.md and the Anthropic
 * pricing page (checked 2026-11-08). Unknown models are refused so the budget check never
 * runs on a guess.
 */
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
};

/** CLI aliases resolve to these for estimates (docs/claude-cli.md: haiku → claude-haiku-5-5). */
const ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
};

export function priceOf(model: string): { input: number; output: number } {
  const price = MODEL_PRICES[ALIASES[model] ?? model];
  if (!price) throw new Error(`no price known for model ${model}; add it to llm/pricing.ts`);
  return price;
}

/** Rough token count: ~3.5 characters per token for English prose, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceOf(model);
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

/**
 * Upper bound for the budget check: input estimate plus the full output allowance, plus a
 * fixed overhead for the system prompt, schema and (for the CLI) Claude Code's own context.
 */
export function estimateCallUsd(
  model: string,
  system: string,
  prompt: string,
  maxOutputTokens: number,
): number {
  const OVERHEAD_TOKENS = 4_000;
  return costUsd(model, estimateTokens(system + prompt) + OVERHEAD_TOKENS, maxOutputTokens) * 1.2;
}
