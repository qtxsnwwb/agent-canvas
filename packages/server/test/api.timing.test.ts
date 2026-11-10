import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { loadConfig, type Config } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';
import { assistantBlock, userPrompt } from './fixtures.js';

// Timing-sensitive: runs in the serial "timing" Vitest project (see vitest.config.ts).

let tmp: string;
let store: Store;
let config: Config;
let pipeline: Pipeline;
let app: FastifyInstance;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-api-timing-'));
  config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data') });
  await fs.mkdir(config.projectsDir, { recursive: true });
  store = openStore(':memory:');
  pipeline = new Pipeline(store, config);
  app = buildServer({ store, pipeline, config });
});
afterEach(async () => {
  await app.close();
  store.close();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
});

test('全量导入进行中 /hooks 仍在 100ms 内应答', async () => {
  const events: RawEvent[] = [userPrompt('u0', null, 'start')];
  for (let i = 1; i < 20_000; i++) events.push(assistantBlock(`a${i}`, 'u0', { type: 'text', text: `t${i}` }));
  const file = path.join(config.projectsDir, 'proj', 'big.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, events.map((e) => (e.source === 'transcript' ? e.line : '') + '\n').join(''));
  const importing = pipeline.scanAll();
  const t0 = performance.now();
  const res = await app.inject({ method: 'POST', url: '/hooks', payload: { hook_event_name: 'Stop', session_id: 's1' } });
  expect(res.statusCode).toBe(200);
  expect(performance.now() - t0).toBeLessThan(100);
  await importing;
  await pipeline.idle();
}, 60_000);
