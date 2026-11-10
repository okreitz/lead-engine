// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import nextVitals from 'eslint-config-next/core-web-vitals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      'data/**',
      'apps/web/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // CLAUDE.md: external binaries run only through apps/engine/src/commands.ts.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'child_process', message: 'Use apps/engine/src/commands.ts.' },
            { name: 'node:child_process', message: 'Use apps/engine/src/commands.ts.' },
            { name: 'execa', message: 'Use apps/engine/src/commands.ts.' },
          ],
        },
      ],
    },
  },
  {
    // Tests read loosely-typed JSON responses.
    files: ['**/test/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    files: ['apps/engine/src/commands.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  ...nextVitals.map((config) => ({
    ...config,
    files: ['apps/web/**/*.{ts,tsx,js,jsx,mjs}'],
  })),
  {
    files: ['apps/web/**/*.{ts,tsx,js,jsx,mjs}'],
    settings: { next: { rootDir: 'apps/web' } },
  },
);
