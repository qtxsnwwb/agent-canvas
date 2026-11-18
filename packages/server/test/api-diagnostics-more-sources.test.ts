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

type NewDirs = Pick<Config, 'deepseekDir' | 'workbuddyDirs' | 'codebuddyDir' | 'doubaoDirs'>;
const NEW_OFF: NewDirs = { deepseekDir: null, workbuddyDirs: [], codebuddyDir: null, doubaoDirs: [] };
function configFor(dirs: { geminiDir: string | null; grokDir: string | null; copilotDir: string | null } & Partial<NewDirs>): Config {
  const n = { ...NEW_OFF, ...dirs };
  return loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, cursorDbPath: null, geminiDir: dirs.geminiDir, grokDir: dirs.grokDir, copilotDir: dirs.copilotDir, deepseekDir: n.deepseekDir, workbuddyDirs: n.workbuddyDirs, codebuddyDir: n.codebuddyDir, doubaoDirs: n.doubaoDirs });
}
const OFF = { dir: null, present: false, reading: false, sessionCount: 0 };
const NEW_SOURCES_OFF = { deepseek: OFF, workbuddy: OFF, codebuddy: OFF, doubao: OFF };
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
    gemini: { dir: null, present: false, reading: false, sessionCount: 0 },
    grok: { dir: null, present: false, reading: false, sessionCount: 0 },
    copilot: { dir: null, present: false, reading: false, sessionCount: 0 },
    ...NEW_SOURCES_OFF,
  });
});

test('configured but absent: the directory the source would read, not present, no sessions; nothing created', async () => {
  const dirs = { geminiDir: path.join(tmp, 'no-gemini'), grokDir: path.join(tmp, 'no-grok'), copilotDir: path.join(tmp, 'no-copilot') };
  const { app } = await serve(configFor(dirs));
  expect((await diagnostics(app)).sources).toEqual({
    gemini: { dir: path.join(dirs.geminiDir, 'tmp'), present: false, reading: false, sessionCount: 0 },
    grok: { dir: path.join(dirs.grokDir, 'sessions'), present: false, reading: false, sessionCount: 0 },
    copilot: { dir: path.join(dirs.copilotDir, 'session-state'), present: false, reading: false, sessionCount: 0 },
    ...NEW_SOURCES_OFF,
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
    gemini: { dir: path.join(geminiDir, 'tmp'), present: true, reading: true, sessionCount: 1 },
    grok: { dir: null, present: false, reading: false, sessionCount: 0 },
    copilot: { dir: null, present: false, reading: false, sessionCount: 0 },
    ...NEW_SOURCES_OFF,
  });
  // The masked answer keeps the block (the dir is a path, masked by the page, not by the server).
  const masked = (await app.inject({ method: 'GET', url: '/api/diagnostics?mask=1' })).json() as Diagnostics;
  expect(masked.sources?.gemini).toEqual(d.sources?.gemini);
});

test('a source directory that appears after start: present, but not read until a restart (final review M-2)', async () => {
  const copilotDir = path.join(tmp, '.copilot');
  const { app } = await serve(configFor({ geminiDir: null, grokDir: null, copilotDir }));
  expect((await diagnostics(app)).sources?.copilot).toEqual({ dir: path.join(copilotDir, 'session-state'), present: false, reading: false, sessionCount: 0 });
  await fs.mkdir(path.join(copilotDir, 'session-state'), { recursive: true });
  expect((await diagnostics(app)).sources?.copilot).toEqual({ dir: path.join(copilotDir, 'session-state'), present: true, reading: false, sessionCount: 0 });
  // After a restart (a new pipeline built from the same config) the source exists and is read.
  const { app: restarted } = await serve(configFor({ geminiDir: null, grokDir: null, copilotDir }));
  expect((await diagnostics(restarted)).sources?.copilot).toMatchObject({ present: true, reading: true });
});

test('the four more sources (DeepSeek, WorkBuddy, CodeBuddy, Doubao) with no directories: each entry exists, absent, not read, no sessions', async () => {
  const { app } = await serve(configFor({ geminiDir: null, grokDir: null, copilotDir: null }));
  const sources = (await diagnostics(app)).sources;
  for (const origin of ['deepseek', 'workbuddy', 'codebuddy', 'doubao'] as const) expect(sources?.[origin], origin).toEqual(OFF);
});

test('the four more sources configured but absent: the directories they would read, not present; every root listed when there are several; nothing created', async () => {
  const at = (n: string): string => path.join(tmp, n);
  const { app } = await serve(configFor({
    geminiDir: null, grokDir: null, copilotDir: null,
    deepseekDir: at('.dsh'), workbuddyDirs: [at('.workbuddy'), at('.workbuddy-ai')], codebuddyDir: at('.codebuddy'), doubaoDirs: [at('DoubaoWork'), at('Doubao')],
  }));
  const sources = (await diagnostics(app)).sources;
  expect(sources?.deepseek).toEqual({ dir: path.join(at('.dsh'), 'sessions'), present: false, reading: false, sessionCount: 0 });
  expect(sources?.codebuddy).toEqual({ dir: path.join(at('.codebuddy'), 'projects'), present: false, reading: false, sessionCount: 0 });
  expect(sources?.workbuddy).toEqual({
    dir: path.join(at('.workbuddy'), 'projects'), present: false, reading: false, sessionCount: 0,
    dirs: [{ dir: path.join(at('.workbuddy'), 'projects'), present: false }, { dir: path.join(at('.workbuddy-ai'), 'projects'), present: false }],
  });
  expect(sources?.doubao).toEqual({
    dir: at('DoubaoWork'), present: false, reading: false, sessionCount: 0,
    dirs: [{ dir: at('DoubaoWork'), present: false }, { dir: at('Doubao'), present: false }],
  });
  for (const n of ['.dsh', '.workbuddy', '.workbuddy-ai', '.codebuddy', 'DoubaoWork', 'Doubao']) await expect(fs.stat(at(n))).rejects.toThrow();
  // A second root that exists makes the source present (stat only).
  await fs.mkdir(path.join(at('.workbuddy-ai'), 'projects'), { recursive: true });
  expect((await diagnostics(app)).sources?.workbuddy).toMatchObject({ present: true, reading: false, dirs: [{ present: false }, { present: true }] });
});
