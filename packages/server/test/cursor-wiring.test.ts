import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { pollSources, rebuild, start, type Running } from '../src/cli-commands.js';
import { loadConfig } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { ClaudeFileSource } from '../src/sources/claude.js';
import { CursorSource } from '../src/sources/cursor/source.js';
import type { PollTimers } from '../src/sources/cursor/source.js';
import { openStore, type Store } from '../src/store/store.js';
import { CursorDbFixture, T0, textBubble, userBubble } from './cursor-fixtures.js';

// Temp dirs and a synthetic Cursor database only.

const NO_TIMERS: PollTimers = { set: () => null, clear: () => undefined };

let tmp: string;
let fx: CursorDbFixture;
const apps: Running[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cursor-wiring-'));
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
  fx = new CursorDbFixture(path.join(tmp, 'Cursor'));
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  fx.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10 });
});

test('the test environment never points at the real Cursor database', () => {
  expect(process.env.CLAUDE_CANVAS_CURSOR_DB).toBe('');
  expect(loadConfig(process.env).cursorDbPath).toBeNull();
});

function pipelineWith(store: Store, source: CursorSource): Pipeline {
  const config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, cursorDbPath: fx.dbPath });
  return new Pipeline(store, config, { sources: [new ClaudeFileSource(config.projectsDir)], pollSources: [source] });
}

test('through a real pipeline: stored once as cursor raw events; a restarted source stores nothing new; stored sessions are listed', async () => {
  fx.put({ id: 'c1', bubbles: [userBubble('u1', 'hello'), textBubble('a1', 'hi there')] });
  fx.put({ id: 's1', isSubagent: true, subagentInfo: { rootParentConversationId: 'c1', parentComposerId: 'c1', toolCallId: 'tc' }, bubbles: [userBubble('x1', 'look')] });
  const store = openStore(path.join(tmp, 'data.db'));
  try {
    for (let run = 0; run < 2; run += 1) {
      const source = new CursorSource({ dbPath: fx.dbPath, now: () => T0 + 3_600_000, timers: NO_TIMERS });
      const pipeline = pipelineWith(store, source);
      await pipeline.scanAll(); // starts the poll source
      await source.pollOnce();
      await pipeline.close();
      await pipeline.idle();
      const raw = store.rawForSession('c1').filter((e) => e.source === 'transcript');
      expect(raw.map((e) => [e.file, e.recordType, e.agentId])).toEqual([
        ['cursor:c1', 'composer', null],
        ['cursor:c1', 'bubble', null],
        ['cursor:c1', 'bubble', null],
        ['cursor:c1/s1', 'composer', 's1'],
        ['cursor:c1/s1', 'bubble', 's1'],
      ]);
      expect(raw.every((e) => e.origin === 'cursor')).toBe(true);
    }
    expect(store.transcriptSessionIds('cursor:')).toEqual(['c1']);
    expect(store.transcriptSessionIds('codex:')).toEqual([]);
  } finally {
    store.close();
  }
});

test('pollSources: a CursorSource when cursorDbPath is set, none when it is null', () => {
  const base = { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null };
  expect(pollSources(loadConfig({}, { ...base, cursorDbPath: null }))).toEqual([]);
  const [source] = pollSources(loadConfig({}, { ...base, cursorDbPath: fx.dbPath }));
  expect(source).toBeInstanceOf(CursorSource);
});

test('start polls the configured database; rebuild does not need it', async () => {
  fx.put({ id: 'c1', bubbles: [userBubble('u1', 'hello')] });
  const dataDir = path.join(tmp, 'data');
  const app = await start({ projectsDir: path.join(tmp, 'projects'), dataDir, codexSessionsDir: null, cursorDbPath: fx.dbPath, port: 0 });
  apps.push(app);
  let diag: { cursor: { dbPath: string | null; lastPollAt: string | null; lastError: string | null } } | null = null;
  for (let i = 0; i < 400; i += 1) {
    diag = (await (await fetch(`${app.url}/api/diagnostics`)).json()) as typeof diag;
    if (diag!.cursor.lastPollAt !== null) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(diag!.cursor).toMatchObject({ dbPath: fx.dbPath, lastError: null });
  expect(diag!.cursor.lastPollAt).not.toBeNull();
  await apps.pop()!.close();
  const db = new Database(path.join(dataDir, 'data.db'), { readonly: true });
  const rows = db.prepare(`SELECT file, record_type FROM raw_event WHERE origin = 'cursor' ORDER BY ingest_id`).all();
  db.close();
  expect(rows).toEqual([
    { file: 'cursor:c1', record_type: 'composer' },
    { file: 'cursor:c1', record_type: 'bubble' },
  ]);
  // rebuild replays the stored events with the Cursor database gone
  fx.close();
  fs.rmSync(path.join(tmp, 'Cursor'), { recursive: true, force: true });
  fx = { close: () => undefined } as unknown as CursorDbFixture;
  expect(() => rebuild({ projectsDir: path.join(tmp, 'projects'), dataDir, codexSessionsDir: null, cursorDbPath: path.join(tmp, 'Cursor', 'gone.vscdb') })).not.toThrow();
}, 30_000);
