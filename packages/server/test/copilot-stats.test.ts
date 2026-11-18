import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { StatsResponse } from '@agent-canvas/shared';
import { buildServer } from '../src/api/server.js';
import { fileSources } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { StatsService, storeStatsSource } from '../src/stats/service.js';
import { openStore, type Store } from '../src/store/store.js';
import { ev, exampleLines, startLine } from './copilot-fixtures.js';

// Final review I-1: a Copilot CLI session's last turn must not run until the CLI exits. The session.shutdown node is
// the exit (its usage, the session total, is booked at the exit time), and work after a session.resume without a new
// prompt is a turn of its own. Temp dirs and invented data only.

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 3600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

let tmp: string;
let store: Store;
let pipeline: Pipeline;
let app: FastifyInstance;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-copilot-stats-'));
});
afterEach(async () => {
  await app?.close();
  await pipeline?.close();
  await pipeline?.idle();
  store?.close();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

async function statsOf(sessions: Record<string, string[]>): Promise<StatsResponse> {
  const copilotDir = path.join(tmp, '.copilot');
  for (const [id, lines] of Object.entries(sessions)) {
    const file = path.join(copilotDir, 'session-state', id, 'events.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, lines.map((l) => `${l}\n`).join(''));
  }
  const config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, cursorDbPath: null, deepseekDir: null, workbuddyDirs: [], codebuddyDir: null, doubaoDirs: [], qwenDir: null, geminiDir: null, grokDir: null, copilotDir });
  await fs.mkdir(config.projectsDir, { recursive: true });
  store = openStore(':memory:');
  pipeline = new Pipeline(store, config, { sources: fileSources(config, store) });
  await pipeline.scanAll();
  await pipeline.idle();
  expect(pipeline.ingestFailures()).toEqual([]);
  app = buildServer({ store, pipeline, config, stats: new StatsService(storeStatsSource(store), { now: () => NOW, dayKey: utcDay }) });
  const res = await app.inject({ method: 'GET', url: '/api/stats?range=all' });
  expect(res.statusCode).toBe(200);
  return res.json() as StatsResponse;
}

test('a one-minute turn followed by an exit 25 h later is a one-minute turn; the usage lands on the exit day', async () => {
  const T = Date.parse('2026-11-10T22:00:00.000Z');
  const body = await statsOf({
    'cop-exit': [
      startLine(),
      ev('user.message', { content: 'run the tests' }, { at: iso(T) }),
      ev('tool.execution_start', { toolCallId: 'b1', toolName: 'bash', arguments: { command: 'npm test' } }, { at: iso(T + 1000) }),
      ev('tool.execution_complete', { toolCallId: 'b1', success: true, result: { content: 'ok' } }, { at: iso(T + 1000 + MIN) }),
      ev('assistant.message', { content: 'all green', toolRequests: [] }, { at: iso(T + 61_000 + 1000) }),
      ev('session.shutdown', { shutdownType: 'routine', modelMetrics: { m: { usage: { inputTokens: 5000, outputTokens: 300 } } } }, { at: iso(T + 25 * HOUR) }),
    ],
  });
  expect(body.totals.turns).toBe(1);
  expect(body.totals.activeMs).toBe(62_000);
  expect(body.byOrigin.find((o) => o.origin === 'copilot')?.medianTurnMs).toBe(62_000);
  expect(body.totals.tokens).toEqual({ input: 5000, cachedInput: 0, output: 300 });
  const day = (d: string) => body.byDay.find((x) => x.day === d);
  // The turn on the day it started, the session total on the day the CLI exited.
  expect(day('2026-11-10')).toMatchObject({ turns: 1, activeMs: 62_000 });
  expect(day('2026-11-10')?.tokens ?? { input: 0, cachedInput: 0, output: 0 }).toEqual({ input: 0, cachedInput: 0, output: 0 });
  expect(day('2026-11-11')).toMatchObject({ turns: 0, activeMs: 0, tokens: { input: 5000, cachedInput: 0, output: 300 } });
});

test('work after a session.resume without a new prompt is its own turn (the example session: two short turns, not 25 h)', async () => {
  const body = await statsOf({ 'cop-example': exampleLines() });
  expect(body.totals.turns).toBe(2);
  // Turn 1: prompt 09:00:05 → reply 09:00:14 (9 s). Resume turn: dispatch 10:00:20 → completed 10:00:30 (10 s).
  expect(body.totals.activeMs).toBe(19_000);
  expect(body.totals.activeMs).toBeLessThan(HOUR);
  expect(body.totals.tokens).toEqual({ input: 5000, cachedInput: 0, output: 300 });
});
