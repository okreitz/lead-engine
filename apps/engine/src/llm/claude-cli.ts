/**
 * `claude-cli` adapter (local mode). Runs the official `claude` binary through
 * `commands.ts` with exactly the flags verified in docs/claude-cli.md, from an empty temp
 * directory, with the prompt on stdin. Never touches Claude credentials.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { runCommand, type RunResult } from '../commands.ts';
import { ProviderCallError } from '../providers/errors.ts';
import type { LlmAdapter, LlmRequest, LlmResult } from './types.ts';

/** The argv from docs/claude-cli.md ("The invocation the adapter uses"). */
export function claudeCliArgs(request: LlmRequest, jsonSchema: object): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--model',
    request.model,
    '--effort',
    'low',
    '--tools',
    '',
    '--disallowedTools',
    'mcp__*',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--system-prompt',
    request.system,
    '--json-schema',
    JSON.stringify(jsonSchema),
    '--max-budget-usd',
    String(request.callCapUsd),
  ];
}

const cliResultSchema = z.looseObject({
  type: z.literal('result'),
  subtype: z.string().optional(),
  is_error: z.boolean(),
  structured_output: z.unknown().optional(),
  total_cost_usd: z.number().optional(),
  usage: z
    .looseObject({ input_tokens: z.number().optional(), output_tokens: z.number().optional() })
    .optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
  api_error_status: z.number().nullable().optional(),
  errors: z.array(z.string()).optional(),
});

/**
 * Applies the adapter rules from docs/claude-cli.md: success only when the exit code is 0,
 * `is_error` is false and `structured_output` is present, whatever `subtype` says. Cost is
 * recorded on failures too.
 */
export function parseClaudeCliResult(run: RunResult, requestedModel: string): LlmResult {
  if (run.timedOut) throw new ProviderCallError('claude CLI timed out', null);
  let json: unknown;
  try {
    json = JSON.parse(run.stdout);
  } catch {
    throw new ProviderCallError(
      `claude CLI returned no JSON (exit ${run.exitCode}): ${run.stderr.slice(0, 200)}`,
      null,
    );
  }
  const parsed = cliResultSchema.safeParse(json);
  if (!parsed.success) throw new ProviderCallError('unexpected claude CLI output shape', null);
  const r = parsed.data;
  const usd = r.total_cost_usd ?? 0;
  const inputTokens = r.usage?.input_tokens ?? 0;
  const outputTokens = r.usage?.output_tokens ?? 0;
  const cost = { usd, units: inputTokens + outputTokens, estimated: true };
  if (run.exitCode !== 0 || r.is_error || r.structured_output === undefined) {
    const why = r.is_error
      ? `${r.subtype ?? 'error'}${r.api_error_status ? ` (API ${r.api_error_status})` : ''}`
      : r.structured_output === undefined
        ? 'no structured output'
        : `exit ${run.exitCode}`;
    // An unknown model or exhausted per-call cap won't fix itself on retry.
    const retryable = !(r.api_error_status === 404 || r.subtype === 'error_max_budget_usd');
    throw new ProviderCallError(`claude CLI failed: ${why}`, cost, retryable);
  }
  const model = Object.keys(r.modelUsage ?? {})[0] ?? requestedModel;
  return { output: r.structured_output, usd, estimated: true, inputTokens, outputTokens, model };
}

export function claudeCliAdapter(): LlmAdapter {
  return {
    name: 'claude-cli',
    keyProvider: null,
    defaultModel: 'haiku',
    async complete(request) {
      const jsonSchema = z.toJSONSchema(request.schema);
      const cwd = await mkdtemp(path.join(tmpdir(), 'le-claude-'));
      try {
        const run = await runCommand('claude', claudeCliArgs(request, jsonSchema), {
          input: request.prompt,
          cwd,
        });
        return parseClaudeCliResult(run, request.model);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  };
}
