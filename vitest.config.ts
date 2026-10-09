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
      // Floors sit just below the measured project values so a real regression
      // fails the build instead of being absorbed by leftover headroom.
      thresholds: {
        statements: 86,
        branches: 79,
        functions: 86,
        lines: 90,
        // The weakest modules keep their own floor: gains elsewhere must not
        // hide a regression in the command handlers or the relay schema parser.
        'src/commands/connectionCommands.ts': {
          statements: 61,
          branches: 52,
          functions: 60,
          lines: 68,
        },
        'src/relay/schema.ts': {
          statements: 63,
          branches: 70,
          functions: 95,
          lines: 68,
        },
      },
    },
  },
});
