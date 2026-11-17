import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { fileSources } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { GEMINI_LEGACY_MAX_BYTES, GeminiFileSource } from '../src/sources/gemini/source.js';
import { openStore, type Store } from '../src/store/store.js';
import { legacyJson, M1, SID, userMsg } from './gemini-fixtures.js';

// Final review M-4: a legacy Gemini `.json` is read whole by the pipeline; one larger than the cap is reported as a
// failure and nothing of it is ingested. Temp dirs and invented data only.

let tmp: string;
let store: Store;
let pipeline: Pipeline;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-gemini-legacy-cap-'));
});
afterEach(async () => {
  await pipeline?.close();
  await pipeline?.idle();
  store?.close();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

async function ingest(content: string, legacyMaxBytes: number): Promise<void> {
  const geminiDir = path.join(tmp, '.gemini');
  const gemTmp = path.join(geminiDir, 'tmp');
  const file = path.join(gemTmp, 'demo-app', 'chats', 'session-2026-11-10T08-00-3f9c2a1b.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(path.join(gemTmp, 'demo-app', '.project_root'), '/home/dev/demo-app');
  await fs.writeFile(file, content);
  const config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, cursorDbPath: null, deepseekDir: null, workbuddyDirs: [], codebuddyDir: null, doubaoDirs: [], geminiDir, grokDir: null, copilotDir: null });
  await fs.mkdir(config.projectsDir, { recursive: true });
  store = openStore(':memory:');
  const sources = fileSources(config, store).filter((s) => !(s instanceof GeminiFileSource));
  pipeline = new Pipeline(store, config, { sources: [...sources, new GeminiFileSource(gemTmp, undefined, { legacyMaxBytes })] });
  await pipeline.scanAll();
  await pipeline.idle();
}

test('the default cap is generous (64 MB)', () => {
  expect(GEMINI_LEGACY_MAX_BYTES).toBe(64 * 1024 * 1024);
});

test('a legacy .json over the cap: reported in the failures, no session, nothing stored', async () => {
  const content = legacyJson([userMsg(M1, 'hello')]);
  await ingest(content, content.length - 1);
  expect(store.getSession(SID)).toBeNull();
  expect(store.listProjects(Date.now())).toEqual([]);
  const failures = pipeline.ingestFailures();
  expect(failures).toHaveLength(1);
  expect(failures[0]!.error).toContain('larger than');
});

test('the same file under the cap is read as before', async () => {
  const content = legacyJson([userMsg(M1, 'hello')]);
  await ingest(content, content.length);
  expect(pipeline.ingestFailures()).toEqual([]);
  expect(store.getSession(SID)).toMatchObject({ origin: 'gemini' });
});
