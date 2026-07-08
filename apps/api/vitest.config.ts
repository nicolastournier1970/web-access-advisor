import { defineConfig } from 'vitest/config';

/**
 * Specs run against the COMPILED app in dist/ (the `test` script builds
 * first): vitest/esbuild cannot emit the decorator metadata Nest's DI needs,
 * so test files import dist modules rather than src.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
