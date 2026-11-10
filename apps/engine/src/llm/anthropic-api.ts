/**
 * `anthropic-api` adapter (VPS and customers). Official SDK, structured output via
 * `output_config.format`, low effort, no tools. Cost comes from the response's usage.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ProviderCallError } from '../providers/errors.ts';
import { costUsd } from './pricing.ts';
import type { LlmAdapter } from './types.ts';

export function anthropicApiAdapter(
  options: { baseURL?: string; timeoutMs?: number } = {},
): LlmAdapter {
  return {
    name: 'anthropic-api',
    keyProvider: 'anthropic',
    defaultModel: 'claude-haiku-5-5',
    async complete(request, env) {
      if (!env.apiKey) throw new ProviderCallError('no Anthropic API key configured', null, false);
      const client = new Anthropic({
        apiKey: env.apiKey,
        maxRetries: 2,
        timeout: options.timeoutMs ?? 120_000,
        ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      });
      let message;
      try {
        // `create`, not `parse`: we check stop_reason and record the cost before parsing.
        message = await client.messages.create({
          model: request.model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.prompt }],
          output_config: { effort: 'low', format: zodOutputFormat(request.schema) },
        });
      } catch (err) {
        if (err instanceof Anthropic.APIError) {
          const retryable = err.status === undefined || err.status === 429 || err.status >= 500;
          throw new ProviderCallError(
            `Anthropic API error ${err.status ?? ''}`.trim(),
            null,
            retryable,
          );
        }
        throw err;
      }
      const inputTokens =
        message.usage.input_tokens +
        (message.usage.cache_creation_input_tokens ?? 0) +
        (message.usage.cache_read_input_tokens ?? 0);
      const outputTokens = message.usage.output_tokens;
      const usd = costUsd(message.model, inputTokens, outputTokens);
      const cost = { usd, units: inputTokens + outputTokens };
      if (message.stop_reason === 'refusal')
        throw new ProviderCallError('model refused', cost, false);
      if (message.stop_reason === 'max_tokens')
        throw new ProviderCallError('output hit max_tokens', cost, false);
      const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      let output: unknown;
      try {
        output = JSON.parse(text);
      } catch {
        throw new ProviderCallError('no structured output', cost);
      }
      return { output, usd, estimated: false, inputTokens, outputTokens, model: message.model };
    },
  };
}
