/**
 * `pnpm --filter @le/engine check:claude`: reruns the canonical claude-cli invocation from
 * docs/claude-cli.md with a one-line prompt, to recheck the flags after a CLI upgrade.
 * It makes one real call (about $0.0005, notional on a subscription). Not run in tests or CI.
 */
import { z } from 'zod';
import { claudeCliAdapter } from './claude-cli.ts';

const adapter = claudeCliAdapter();
const result = await adapter.complete(
  {
    system: 'Reply with the requested JSON only.',
    prompt: 'Set ok to true.',
    schema: z.object({ ok: z.boolean() }),
    model: adapter.defaultModel,
    maxOutputTokens: 50,
    callCapUsd: 0.05,
  },
  { apiKey: null },
);
console.log(JSON.stringify(result, null, 2));
if ((result.output as { ok?: unknown }).ok !== true) process.exit(1);
