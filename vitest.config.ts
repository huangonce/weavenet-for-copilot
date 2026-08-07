import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      vscode: resolve(__dirname, 'test/support/vscode.mock.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/constants.ts', 'src/relay/types.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 80,
        branches: 73,
        functions: 78,
        lines: 83,
      },
    },
  },
});
