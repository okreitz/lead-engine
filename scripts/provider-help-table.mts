/**
 * Regenerates the "Getting your keys" table in docs/providers.md from PROVIDER_HELP
 * (packages/shared). Run: `pnpm docs:keys`. A test fails when the table is stale.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { providerHelpMarkdown } from '../packages/shared/src/provider-help.ts';

const file = new URL('../docs/providers.md', import.meta.url);
const doc = readFileSync(file, 'utf8');
const out = doc.replace(
  /<!-- generated:provider-help -->[\s\S]*?<!-- \/generated:provider-help -->/,
  `<!-- generated:provider-help -->\n${providerHelpMarkdown()}\n<!-- /generated:provider-help -->`,
);
writeFileSync(file, out);
