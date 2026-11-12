import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));
const packagesDir = fileURLToPath(new URL('./packages/', import.meta.url));

/** Tests asserting an event-loop gap or a wall-clock bound; they run in their own project, see below. */
const TIMING = '**/*.timing.test.ts';

// Tests run against shared's TypeScript source (no prior build needed).
// Inline projects with `extends: true` so every package inherits this alias.
export default defineConfig({
  resolve: {
    alias: {
      '@claude-canvas/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    // Never the real Cursor database: a test that wants one passes a temp path (cursorDbPath override or stubbed env).
    env: { CLAUDE_CANVAS_CURSOR_DB: '' },
    projects: [
      ...readdirSync(packagesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => ({
          extends: true as const,
          test: {
            name: `@claude-canvas/${d.name}`,
            root: `${root}packages/${d.name}`,
            exclude: ['**/node_modules/**', '**/dist/**', TIMING],
          },
        })),
      {
        // Timing-sensitive tests: run after every other project has finished (groupOrder), one file at a time in a
        // single fork (the per-project equivalent of fileParallelism: false), and retried to absorb machine noise.
        extends: true as const,
        test: {
          name: 'timing',
          root,
          include: [`packages/*/test/${TIMING}`],
          retry: 2,
          sequence: { groupOrder: 1 },
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
});
