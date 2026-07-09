// Flat ESLint config for the workspaces (apps/*, packages/shared, packages/engine).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '**/dist/**',
      'snapshots/**',
      '**/*.js',
      '**/*.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/**/*.ts', 'packages/**/*.ts', 'e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Boundary: the Angular app may only talk to the API over HTTP.
    // It must never import the Playwright engine.
    files: ['apps/web/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@waa/core', '@waa/core/*'], message: 'apps/web may only import @waa/shared. The engine is server-side.' },
            { group: ['playwright', 'playwright-core'], message: 'Playwright is server-side only.' },
          ],
        },
      ],
    },
  },
  {
    // Boundary: shared contracts must stay dependency-light and platform-neutral.
    files: ['packages/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@waa/core', '@waa/core/*', 'playwright', 'express', '@nestjs/*', '@angular/*'], message: 'packages/shared may depend on zod only.' },
          ],
        },
      ],
    },
  },
  {
    // Boundary: the engine never imports HTTP frameworks.
    files: ['packages/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@nestjs/*', 'express', '@angular/*'], message: 'the engine (packages/engine) communicates via typed events/callbacks, not HTTP frameworks.' },
          ],
        },
      ],
    },
  },
);
