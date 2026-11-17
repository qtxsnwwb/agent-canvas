import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));
const packagesDir = fileURLToPath(new URL('./packages/', import.meta.url));

/** Tests asserting an event-loop gap or a wall-clock bound; they run in their own project, see below. */
const TIMING = '**/*.timing.test.ts';

/**
 * CI sets AGENT_CANVAS_TIMING_SCALE (see .github/workflows): a shared runner is several times slower than a developer
 * machine, most of all its disk. The default per-test timeout grows by that factor there (tests that open and migrate a
 * file database took more than 5 s on GitHub's Windows runner); unset, it is Vitest's default. A timeout is not an
 * assertion: the wall-clock bounds tests assert are scaled where they are written (pipeline.timing.test.ts).
 */
const TIMING_SCALE = Math.max(1, Number(process.env.AGENT_CANVAS_TIMING_SCALE) || 1);

// Tests run against shared's TypeScript source (no prior build needed).
// Inline projects with `extends: true` so every package inherits this alias.
export default defineConfig({
  resolve: {
    alias: {
      '@agent-canvas/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    testTimeout: 5_000 * TIMING_SCALE,
    hookTimeout: 10_000 * TIMING_SCALE,
    // Never the real Cursor database: a test that wants one passes a temp path (cursorDbPath override or stubbed env).
    // Never the real Gemini CLI / Grok / Copilot CLI directories either (start() reads process.env): a test that wants one passes a temp dir.
    // No stats warm-up in start() unless a test asks for it (StartOptions.statsWarmup).
    env: { AGENT_CANVAS_CURSOR_DB: '', AGENT_CANVAS_GEMINI_DIR: '', AGENT_CANVAS_GROK_DIR: '', AGENT_CANVAS_COPILOT_DIR: '', AGENT_CANVAS_STATS_WARMUP: '0' },
    projects: [
      ...readdirSync(packagesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => ({
          extends: true as const,
          test: {
            name: `@agent-canvas/${d.name}`,
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
