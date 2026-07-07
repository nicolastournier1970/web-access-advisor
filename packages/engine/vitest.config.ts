import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@waa/shared': path.resolve(here, '../shared/src/index.ts'),
    },
  },
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
