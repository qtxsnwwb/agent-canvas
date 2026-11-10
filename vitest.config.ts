import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));
const packagesDir = fileURLToPath(new URL('./packages/', import.meta.url));

// Tests run against shared's TypeScript source (no prior build needed).
// Inline projects with `extends: true` so every package inherits this alias.
export default defineConfig({
  resolve: {
    alias: {
      '@claude-canvas/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    projects: readdirSync(packagesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({
        extends: true as const,
        test: { name: `@claude-canvas/${d.name}`, root: `${root}packages/${d.name}` },
      })),
  },
});
