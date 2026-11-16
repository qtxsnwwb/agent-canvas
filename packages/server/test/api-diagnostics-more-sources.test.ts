import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Diagnostics } from '@agent-canvas/shared';
import { buildServer } from '../src/api/server.js';
import { fileSources } from '../src/cli.js';
import { loadConfig, type Config } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { openStore, type Store } from '../src/store/store.js';
import { exampleLines, MAIN_REL } from './gemini-fixtures.js';

// Diagnostics' `sources` block for Gemini CLI, Grok Build and Copilot CLI: temp dirs only, invented data.

let tmp: string;
const stores: Store[] = [];
const apps: FastifyInstance[] = [];
const pipelines: Pipeline[] = [];

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-api-diag-more-'));
  await fs.mkdir(path.join(tmp, 'projects'), { recursive: true });
});
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const p of pipelines.splice(0)) {
    await p.close();
    await p.idle();
  }
  for (const s of stores.splice(0)) s.close();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

function configFor(dirs: { geminiDir: string | null; grokDir: string | null; copilotDir: string | null }): Config {
  return loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, cursorDbPath: null, geminiDir: dirs.geminiDir, grokDir: dirs.grokDir, copilotDir: dirs.copilotDir });
}
async function serve(config: Config): Promise<{ app: FastifyInstance; pipeline: Pipeline }> {
  const store = openStore(':memory:');
  stores.push(store);
  const pipeline = new Pipeline(store, config, { sources: fileSources(config, store) });
  pipelines.push(pipeline);
  await pipeline.scanAll();
  await pipeline.idle();
  const app = buildServer({ store, pipeline, config });
  apps.push(app);
  return { app, pipeline };
}
const diagnostics = async (app: FastifyInstance): Promise<Diagnostics> => (await app.inject({ method: 'GET', url: '/api/diagnostics' })).json() as Diagnostics;

test('not configured: dir null, not present, no sessions', async () => {
  const { app } = await serve(configFor({ geminiDir: null, grokDir: null, copilotDir: null }));
  expect((await diagnostics(app)).sources).toEqual({
    gemini: { dir: null, present: false, sessionCount: 0 },
    grok: { dir: null, present: false, sessionCount: 0 },
    copilot: { dir: null, present: false, sessionCount: 0 },
  });
});

test('configured but absent: the directory the source would read, not present, no sessions; nothing created', async () => {
  const dirs = { geminiDir: path.join(tmp, 'no-gemini'), grokDir: path.join(tmp, 'no-grok'), copilotDir: path.join(tmp, 'no-copilot') };
  const { app } = await serve(configFor(dirs));
  expect((await diagnostics(app)).sources).toEqual({
    gemini: { dir: path.join(dirs.geminiDir, 'tmp'), present: false, sessionCount: 0 },
    grok: { dir: path.join(dirs.grokDir, 'sessions'), present: false, sessionCount: 0 },
    copilot: { dir: path.join(dirs.copilotDir, 'session-state'), present: false, sessionCount: 0 },
  });
  for (const d of Object.values(dirs)) await expect(fs.stat(d)).rejects.toThrow();
});

test('a Gemini CLI directory with one session: present, one session; the others stay absent', async () => {
  const geminiDir = path.join(tmp, '.gemini');
  const file = path.join(geminiDir, 'tmp', ...MAIN_REL.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(path.join(geminiDir, 'tmp', 'demo-app', '.project_root'), '/home/dev/demo-app');
  await fs.writeFile(file, exampleLines().map((l) => `${l}\n`).join(''));
  const { app } = await serve(configFor({ geminiDir, grokDir: null, copilotDir: null }));
  const d = await diagnostics(app);
  expect(d.sources).toEqual({
    gemini: { dir: path.join(geminiDir, 'tmp'), present: true, sessionCount: 1 },
    grok: { dir: null, present: false, sessionCount: 0 },
    copilot: { dir: null, present: false, sessionCount: 0 },
  });
  // The masked answer keeps the block (the dir is a path, masked by the page, not by the server).
  const masked = (await app.inject({ method: 'GET', url: '/api/diagnostics?mask=1' })).json() as Diagnostics;
  expect(masked.sources?.gemini).toEqual(d.sources?.gemini);
});
