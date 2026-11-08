// Bundles the engine into dist/index.js. Workspace packages (@le/shared, TypeScript
// source) are inlined; npm dependencies stay external and load from node_modules.
import { cpSync, readFileSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter((name) => !name.startsWith('@le/'));

rmSync('dist', { recursive: true, force: true });

await build({
  // Both entries land directly in dist/, so `new URL('./migrations', import.meta.url)`
  // resolves to dist/migrations in the bundle.
  entryPoints: { index: 'src/index.ts', migrate: 'src/db/migrate-cli.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external,
  logLevel: 'info',
});

cpSync('src/db/migrations', 'dist/migrations', { recursive: true });
