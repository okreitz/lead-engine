import type { LlmAdapter, LlmRequest, LlmResult } from './types.ts';

/** Test adapter: never calls a model. `respond` returns the structured output. */
export function fakeLlm(
  respond: (request: LlmRequest) => unknown,
  options: { usd?: number } = {},
): LlmAdapter & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    requests,
    name: 'fake',
    keyProvider: null,
    defaultModel: 'claude-haiku-5-5',
    async complete(request): Promise<LlmResult> {
      requests.push(request);
      return {
        output: respond(request),
        usd: options.usd ?? 0.001,
        estimated: false,
        inputTokens: Math.ceil(request.prompt.length / 4),
        outputTokens: 100,
        model: request.model,
      };
    },
  };
}
