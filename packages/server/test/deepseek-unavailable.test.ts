import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Diagnostics } from '@agent-canvas/shared';

// A Node without zstd in node:zlib (< 22.15), simulated: the DeepSeek source is not created and diagnostics say why.
vi.mock('../src/sources/deepseek/zstd-frames.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/sources/deepseek/zstd-frames.js')>();
  return { ...real, zstdAvailable: () => false };
});

const { buildServer } = await import('../src/api/server.js');
const { fileSources } = await import('../src/cli.js');
const { loadConfig } = await import('../src/config.js');
const { Pipeline } = await import('../src/pipeline.js');
const { openStore } = await import('../src/store/store.js');

let tmp: string;
const cleanup: (() => Promise<void> | void)[] = [];
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-dsh-unavailable-'));
});
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

async function diagnosticsFor(deepseekDir: string | null): Promise<Diagnostics> {
  const config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, cursorDbPath: null, geminiDir: null, grokDir: null, copilotDir: null, deepseekDir, workbuddyDirs: [], codebuddyDir: null, doubaoDirs: [] });
  const store = openStore(':memory:');
  cleanup.push(() => store.close());
  const sources = fileSources(config, store);
  expect(sources.map((s) => s.origin)).not.toContain('deepseek');
  const pipeline = new Pipeline(store, config, { sources });
  cleanup.push(async () => {
    await pipeline.close();
    await pipeline.idle();
  });
  await pipeline.scanAll();
  const app: FastifyInstance = buildServer({ store, pipeline, config });
  cleanup.push(() => app.close());
  return (await app.inject({ method: 'GET', url: '/api/diagnostics' })).json() as Diagnostics;
}

test('a dsh sessions directory on a Node without zstd: present, not read, unavailable says which Node is needed', async () => {
  const home = path.join(tmp, '.dsh');
  await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
  expect((await diagnosticsFor(home)).sources?.deepseek).toEqual({ dir: path.join(home, 'sessions'), present: true, reading: false, sessionCount: 0, unavailable: '需要 Node 22.15 或更高' });
});

test('no dsh directory, or DeepSeek disabled: nothing to say', async () => {
  expect((await diagnosticsFor(path.join(tmp, 'none'))).sources?.deepseek).toEqual({ dir: path.join(tmp, 'none', 'sessions'), present: false, reading: false, sessionCount: 0 });
  expect((await diagnosticsFor(null)).sources?.deepseek).toEqual({ dir: null, present: false, reading: false, sessionCount: 0 });
});
