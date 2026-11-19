import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));
const packagesDir = fileURLToPath(new URL('./packages/', import.meta.url));

/** Tests asserting an event-loop gap or a wall-clock bound; they run in their own project, see below. */
const TIMING = '**/*.timing.test.ts';

/**
 * The default per-test timeout is a hang detector, not an assertion about speed: the wall-clock bounds tests assert
 * are written where they are tested, in the timing project. It is 20 s (Vitest's default is 5 s): tests that open and
 * migrate a file database, start a child process or run a pipeline over a temp directory took more than 5 s whenever
 * the machine was busy (several suites or agents at once), and failed although nothing was wrong.
 *
 * CI sets AGENT_CANVAS_TIMING_SCALE (see .github/workflows): a shared runner is several times slower than a developer
 * machine, most of all its disk. The timeouts and the timing project's bounds grow by that factor there.
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
    testTimeout: 20_000 * TIMING_SCALE,
    hookTimeout: 30_000 * TIMING_SCALE,
    // Never the real Cursor database: a test that wants one passes a temp path (cursorDbPath override or stubbed env).
    // Never the real Gemini CLI / Grok / Copilot CLI / DeepSeek Harness / WorkBuddy / CodeBuddy Code / Doubao Work /
    // Qwen Code directories either (start() reads process.env): a test that wants one passes a temp dir.
    // No stats warm-up in start() unless a test asks for it (StartOptions.statsWarmup).
    env: {
      AGENT_CANVAS_CURSOR_DB: '',
      AGENT_CANVAS_GEMINI_DIR: '',
      AGENT_CANVAS_GROK_DIR: '',
      AGENT_CANVAS_COPILOT_DIR: '',
      AGENT_CANVAS_DSH_DIR: '',
      AGENT_CANVAS_WORKBUDDY_DIR: '',
      AGENT_CANVAS_CODEBUDDY_DIR: '',
      AGENT_CANVAS_DOUBAO_DIR: '',
      AGENT_CANVAS_QWEN_DIR: '',
      AGENT_CANVAS_STATS_WARMUP: '0',
    },
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
