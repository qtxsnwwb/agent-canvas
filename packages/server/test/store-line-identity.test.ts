import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Origin } from '@agent-canvas/shared';
import { fileSources, pollSources } from '../src/cli-commands.js';
import { loadConfig } from '../src/config.js';
import { openStore, transcriptLineHash, type RawEvent } from '../src/store/store.js';

// Line identity (Task 4 fix C1): Grok's session logs dedupe raw lines by (generation, offset, content); every other
// origin keeps the content-only hash it always had.

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-line-identity-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');
const line = '{"type":"x","text":"same bytes"}';
const ev = (origin: Origin, offset: number, file = `${origin}:f.jsonl`): RawEvent => ({ source: 'transcript', origin, file, offset, line, recordType: 'x', sessionId: 's', agentId: null, projectId: 'p' });

describe('store dedupe hash', () => {
  test('without identity: SHA-1 of the line, a repeat anywhere in the file is a duplicate (unchanged)', () => {
    expect(transcriptLineHash(line)).toBe(sha1(line));
    const store = openStore(':memory:');
    expect(store.insertRaw(ev('claude', 0))).not.toBeNull();
    expect(store.insertRaw(ev('claude', 100))).toBeNull();
    expect(store.hasTranscriptLine('claude:f.jsonl', line)).toBe(true);
    store.close();
  });

  test('with identity: the same bytes at another offset are a line of their own; the same place is a duplicate', () => {
    const store = openStore(':memory:');
    expect(store.insertRaw(ev('grok', 0), { identity: '0:0' })).not.toBeNull();
    expect(store.insertRaw(ev('grok', 40), { identity: '0:40' })).not.toBeNull();
    expect(store.insertRaw(ev('grok', 40), { identity: '0:40' })).toBeNull();
    expect(store.insertRaw(ev('grok', 0), { identity: '1:0' })).not.toBeNull(); // a new generation of the file
    expect(transcriptLineHash(line, '0:40')).not.toBe(sha1(line));
    store.close();
  });

  for (const origin of ['claude', 'codex', 'cursor', 'gemini', 'copilot'] as const) {
    test(`${origin}: the stored line_hash is still SHA-1 of the line`, () => {
      const file = path.join(tmp, `${origin}.sqlite`);
      const store = openStore(file);
      store.insertRaw(ev(origin, 7));
      store.close();
      const db = new Database(file, { readonly: true });
      const row = db.prepare(`SELECT line_hash AS h FROM raw_event WHERE source = 'transcript'`).get() as { h: string };
      db.close();
      expect(row.h).toBe(sha1(line));
    });
  }
});

test('only the Grok, DeepSeek, WorkBuddy and CodeBuddy sources identify lines by offset', async () => {
  const dirs = { codex: path.join(tmp, 'codex'), gemini: path.join(tmp, 'gemini'), grok: path.join(tmp, 'grok'), copilot: path.join(tmp, 'copilot') };
  await fs.mkdir(dirs.codex, { recursive: true });
  await fs.mkdir(path.join(dirs.gemini, 'tmp'), { recursive: true });
  await fs.mkdir(path.join(dirs.grok, 'sessions'), { recursive: true });
  await fs.mkdir(path.join(dirs.copilot, 'session-state'), { recursive: true });
  await fs.mkdir(path.join(tmp, 'dsh', 'sessions'), { recursive: true });
  await fs.mkdir(path.join(tmp, 'workbuddy', 'projects'), { recursive: true });
  await fs.mkdir(path.join(tmp, 'codebuddy', 'projects'), { recursive: true });
  const config = loadConfig(
    {},
    { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: dirs.codex, deepseekDir: path.join(tmp, 'dsh'), workbuddyDirs: [path.join(tmp, 'workbuddy')], codebuddyDir: path.join(tmp, 'codebuddy'), doubaoDirs: [path.join(tmp, 'doubao')], geminiDir: dirs.gemini, grokDir: dirs.grok, copilotDir: dirs.copilot, cursorDbPath: path.join(tmp, 'state.vscdb') },
  );
  // zstd: true so the DeepSeek source exists whatever this Node has (it reads nothing here).
  const sources = fileSources(config, undefined, { zstd: true });
  expect(sources.map((s) => [s.origin, s.lineIdentity ?? 'content'])).toEqual([
    ['claude', 'content'],
    ['codex', 'content'],
    ['gemini', 'content'],
    ['copilot', 'content'],
    ['grok', 'offset'],
    ['deepseek', 'offset'],
    ['workbuddy', 'offset'],
    ['codebuddy', 'offset'],
  ]);
  // Cursor is polled: its records go through the content-only hash (no file offsets at all).
  expect(pollSources(config).map((s) => 'lineIdentity' in s)).toEqual([false]);
});
