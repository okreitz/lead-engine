import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { providerHelpMarkdown } from '../src/provider-help.ts';

describe('provider help', () => {
  it('docs/providers.md "Getting your keys" is generated from PROVIDER_HELP (run pnpm docs:keys)', () => {
    const doc = readFileSync(new URL('../../../docs/providers.md', import.meta.url), 'utf8');
    const block =
      /<!-- generated:provider-help -->\n([\s\S]*?)\n<!-- \/generated:provider-help -->/.exec(
        doc,
      )?.[1];
    expect(block).toBe(providerHelpMarkdown());
  });
});
