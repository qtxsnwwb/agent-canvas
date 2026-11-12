import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { PollBatch, PollSink } from '../src/sources/poll.js';
import { openCursorDb, type CursorDbReader, type DbResult } from '../src/sources/cursor/db.js';
import { fileUriToPath, normaliseCwd, workspaceStorageDir } from '../src/sources/cursor/project.js';
import type { CursorBubbleRecord, CursorComposerRecord } from '../src/sources/cursor/records.js';
import { CursorSource, ORPHAN_PROBES_PER_ROUND, RECENT_MS, type CursorSourceOptions, type PollTimers } from '../src/sources/cursor/source.js';
import { bubbleRecord, capUtf8, trimBubble, trimComposer } from '../src/sources/cursor/trim.js';
import { CursorDbFixture, pageKey, T0, textBubble, thinkingBubble, toolBubble, userBubble, type ComposerSpec, type FixtureBubble } from './cursor-fixtures.js';

// Temp dirs and a synthetic database only: the real Cursor database is never opened.

class FakeSink implements PollSink {
  readonly batches: PollBatch[] = [];
  readonly calls: string[] = [];
  readonly failures = new Map<string, string>();
  stored: string[] = [];
  /** Rejects ingestRecords while set. */
  failIngest: Error | null = null;
  async ingestRecords(batch: PollBatch): Promise<void> {
    if (this.failIngest) throw this.failIngest;
    this.batches.push(batch);
    this.calls.push(`ingest ${batch.key} ${batch.records.map((r) => r.recordType).join(',')}`);
  }
  async markSourceDeleted(sessionId: string): Promise<void> {
    this.calls.push(`deleted ${sessionId}`);
  }
  async clearSourceDeleted(sessionId: string): Promise<void> {
    this.calls.push(`undeleted ${sessionId}`);
  }
  reportFailure(key: string, err: unknown): void {
    this.failures.set(key, err instanceof Error ? err.message : String(err));
  }
  clearFailure(key: string): void {
    this.failures.delete(key);
  }
  storedSessionIds(): string[] {
    return this.stored;
  }
  /** Records of all batches so far, parsed. */
  records(): { key: string; sessionId: string; agentId: string | null; projectId: string; recordType: string; value: Record<string, unknown> }[] {
    return this.batches.flatMap((b) =>
      b.records.map((r) => ({ key: b.key, sessionId: b.sessionId, agentId: b.agentId, projectId: b.projectId, recordType: r.recordType, value: JSON.parse(r.line) })),
    );
  }
  reset(): void {
    this.batches.length = 0;
    this.calls.length = 0;
  }
}

/** Timers that never fire on their own. */
class ManualTimers implements PollTimers {
  readonly pending: { fn: () => void; ms: number }[] = [];
  set(fn: () => void, ms: number): unknown {
    const t = { fn, ms };
    this.pending.push(t);
    return t;
  }
  clear(handle: unknown): void {
    const i = this.pending.indexOf(handle as { fn: () => void; ms: number });
    if (i !== -1) this.pending.splice(i, 1);
  }
  fire(): void {
    const t = this.pending.shift();
    t?.fn();
  }
}

let tmp: string;
let fx: CursorDbFixture;
let sink: FakeSink;
let clock: number;
let reads: string[];
let sources: CursorSource[];

/** Opens the fixture through the real reader, logging each KV lookup. */
const tracingOpen = (dbPath: string): DbResult<CursorDbReader> => {
  const opened = openCursorDb(dbPath);
  if (!opened.ok) return opened;
  const db = opened.value;
  return {
    ok: true,
    value: {
      headers: () => db.headers(),
      composerData: (id) => {
        reads.push(`composerData:${id}`);
        return db.composerData(id);
      },
      bubble: (id, b) => {
        reads.push(`bubble:${id}:${b}`);
        return db.bubble(id, b);
      },
      headerPages: (id) => {
        reads.push(`pages:${id}`);
        return db.headerPages(id);
      },
      close: () => db.close(),
    },
  };
};

function source(extra: Partial<CursorSourceOptions> = {}): CursorSource {
  const s = new CursorSource({ dbPath: fx.dbPath, now: () => clock, timers: new ManualTimers(), openDb: tracingOpen, ...extra });
  sources.push(s);
  return s;
}
async function started(extra: Partial<CursorSourceOptions> = {}, target: FakeSink = sink): Promise<CursorSource> {
  const s = source(extra);
  s.start(target);
  return s;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cursor-'));
  fx = new CursorDbFixture(path.join(tmp, 'Cursor'));
  sink = new FakeSink();
  clock = T0 + 60 * 60 * 1000; // an hour after the fixtures' times: nothing is "recently active" by default
  reads = [];
  sources = [];
});

afterEach(async () => {
  for (const s of sources) await s.stop();
  fx.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('trim', () => {
  test('a tool bubble keeps the fields of spec 5.3 only, in a fixed order; equal content gives equal lines', () => {
    const raw = { ...toolBubble('b1', 'read_file', 'completed', T0, { toolCallId: 'tc-1', params: { target: 'a.txt' } }), codebaseContextChunks: [], turnDurationMs: 900 };
    const line = trimBubble(raw, 'b1', 4);
    const rec = JSON.parse(line) as CursorBubbleRecord;
    expect(Object.keys(rec)).toEqual([
      'bubbleId', 'order', 'type', 'capabilityType', 'createdAt', 'startedAtMs', 'completedAtMs', 'turnDurationMs', 'text', 'thinking',
      'thinkingDurationMs', 'tokenCount', 'toolFormerData', 'truncated',
    ]);
    expect(rec.toolFormerData).toEqual({ name: 'read_file', status: 'completed', toolCallId: 'tc-1', params: '{"target":"a.txt"}', result: '{"ok":true}' });
    expect(rec.text).toBeNull(); // empty string → null
    expect(rec.turnDurationMs).toBe(900);
    expect(rec.order).toBe(4);
    expect(trimBubble(raw, 'b1', 5)).not.toBe(line); // a new position is a new line
    expect(line).not.toContain('toolCallBinary');
    expect(line).not.toContain('rawArgs');
    expect(line).not.toContain('codebaseContextChunks');
    // key order of the input does not matter
    const shuffled = Object.fromEntries(Object.entries(raw).reverse());
    expect(trimBubble(shuffled, 'b1', 4)).toBe(line);
  });

  test('thinking, user and text bubbles; missing fields are null', () => {
    const t = bubbleRecord(thinkingBubble('t1', 'pondering'), 't1', 0);
    expect(t.thinking).toEqual({ text: 'pondering' });
    expect(t.thinkingDurationMs).toBe(1200);
    expect(JSON.stringify(t)).not.toContain('sig-xyz');
    const u = bubbleRecord({ bubbleId: 'u1', type: 1, text: 'hello' }, 'u1', 2);
    expect(u).toMatchObject({ bubbleId: 'u1', order: 2, type: 1, capabilityType: null, createdAt: null, completedAtMs: null, thinking: null, tokenCount: null, toolFormerData: null, truncated: [] });
    expect(bubbleRecord({ bubbleId: 'own', type: 2, text: 'x' }, 'from-key', 0).bubbleId).toBe('from-key');
  });

  test('text, thinking, params and result are cut to 64 KB of UTF-8 and named in truncated', () => {
    const big = 'é'.repeat(40_000); // 80 000 bytes
    const rec = bubbleRecord({
      bubbleId: 'b',
      type: 2,
      text: big,
      thinking: { text: big },
      toolFormerData: { name: 'x', status: 'completed', params: big, result: 'small' },
    }, 'b', 0);
    expect(Buffer.byteLength(rec.text!, 'utf8')).toBe(64 * 1024);
    expect(rec.text!.endsWith('é')).toBe(true);
    expect(rec.truncated).toEqual(['text', 'thinking.text', 'params']);
    expect(capUtf8('abc')).toEqual({ text: 'abc', cut: false });
    expect(capUtf8('a😀', 3)).toEqual({ text: 'a', cut: true });
  });

  test('a cut that lands inside a multi-byte character backs off to the character before it', () => {
    const euro = '€'.repeat(30_000); // 3 bytes each; 65536 is not a multiple of 3
    const rec = bubbleRecord({ type: 2, text: euro }, 'b', 0);
    expect(Buffer.byteLength(rec.text!, 'utf8')).toBe(65_535);
    expect(rec.text).toBe('€'.repeat(21_845));
    expect(rec.text!.includes('�')).toBe(false);
    expect(rec.truncated).toEqual(['text']);
  });

  test('params / result: JSON text kept as is; an object becomes stable JSON; anything else null', () => {
    const tool = (params: unknown, result: unknown) =>
      bubbleRecord({ type: 2, capabilityType: 15, toolFormerData: { name: 'x', status: 'completed', params, result } }, 'b', 0).toolFormerData!;
    expect(tool('{"b":1,"a":2}', undefined)).toMatchObject({ params: '{"b":1,"a":2}', result: null });
    expect(tool({ b: 1, a: { d: 1, c: 2 } }, { ok: true }).params).toBe('{"a":{"c":2,"d":1},"b":1}');
    expect(tool({ a: { c: 2, d: 1 }, b: 1 }, null).params).toBe('{"a":{"c":2,"d":1},"b":1}');
    expect(tool(42, '')).toMatchObject({ params: null, result: null });
    // text is not JSON-coerced
    expect(bubbleRecord({ type: 2, text: { not: 'text' } }, 'b', 0).text).toBeNull();
  });

  test('composer record: slowly changing facts only (no bubble list, no lastUpdatedAt), subagent info, header fallbacks', () => {
    const line = trimComposer(
      {
        composerId: 'ignored',
        name: 'Fix the widget',
        status: 'none',
        createdAt: 1000,
        unifiedMode: 'agent',
        modelConfig: { modelName: 'm-1' },
        subagentInfo: { subagentType: 2, subagentTypeName: 'explore', parentComposerId: 'p', rootParentConversationId: 'r', toolCallId: 'tc', conversationLengthAtSpawn: 4 },
        fullConversationHeadersOnly: [{ bubbleId: 'b2', type: 1 }, { type: 2 }, { bubbleId: 'b1', type: 2 }],
      },
      { composerId: 'c1', headerCreatedAt: 1, headerUnifiedMode: 'chat', cwd: 'd:\\w' },
    );
    const rec = JSON.parse(line) as CursorComposerRecord;
    expect(rec).toEqual({
      composerId: 'c1',
      name: 'Fix the widget',
      status: 'none',
      createdAt: 1000,
      modelName: 'm-1',
      unifiedMode: 'agent',
      cwd: 'd:\\w',
      subagentInfo: { parentComposerId: 'p', rootParentConversationId: 'r', toolCallId: 'tc', subagentTypeName: 'explore', subagentType: 2 },
    });
    expect(Object.keys(rec)).toEqual(['composerId', 'name', 'status', 'createdAt', 'modelName', 'unifiedMode', 'cwd', 'subagentInfo']);
    // a new step (lastUpdatedAt, a longer list) does not change the line
    const later = trimComposer(
      {
        name: 'Fix the widget',
        status: 'none',
        createdAt: 1000,
        lastUpdatedAt: 99_999,
        unifiedMode: 'agent',
        modelConfig: { modelName: 'm-1' },
        subagentInfo: { subagentType: 2, subagentTypeName: 'explore', parentComposerId: 'p', rootParentConversationId: 'r', toolCallId: 'tc' },
        fullConversationHeadersOnly: [{ bubbleId: 'b2', type: 1 }, { bubbleId: 'b1', type: 2 }, { bubbleId: 'b3', type: 2 }],
      },
      { composerId: 'c1', headerCreatedAt: 1, headerUnifiedMode: 'chat', cwd: 'd:\\w' },
    );
    expect(later).toBe(line);
  });
});

describe('project', () => {
  test('file URIs become local paths', () => {
    expect(fileUriToPath('file:///d%3A/work/x')).toBe('d:\\work\\x');
    expect(fileUriToPath('file:///home/u/my%20dir')).toBe('/home/u/my dir');
    expect(fileUriToPath('file://server/share/x')).toBe('\\\\server\\share\\x');
    expect(fileUriToPath('vscode-remote://ssh-remote+h/x')).toBeNull();
    expect(fileUriToPath('file:///bad%E0')).toBeNull();
    expect(fileUriToPath('file:///d%3A/work/x?query=1#frag')).toBe('d:\\work\\x');
    expect(fileUriToPath('file:///d%3A/a%23b')).toBe('d:\\a#b'); // an encoded # is part of the path
  });

  test('cwd normalisation: drive letter upper-cased, trailing separators dropped except on a root', () => {
    expect(normaliseCwd('d:\\work\\x\\')).toBe('D:\\work\\x');
    expect(normaliseCwd('D:\\work\\x')).toBe('D:\\work\\x');
    expect(normaliseCwd('d:\\')).toBe('D:\\');
    expect(normaliseCwd('/home/u/x/')).toBe('/home/u/x');
    expect(normaliseCwd('/')).toBe('/');
  });

  test('a workspace.json folder with a trailing slash and lower-case drive joins the Claude Code project', async () => {
    fx.put({ id: 'c', workspaceId: 'ws-c', bubbles: [userBubble('c1', 'hi')] });
    fx.writeWorkspaceJson('ws-c', { folder: 'file:///d%3A/work/gamma/' });
    const s = await started({ knownProjectIds: () => ['D--work-gamma'] });
    await s.pollOnce();
    expect(sink.batches[0]!.projectId).toBe('D--work-gamma');
    expect(sink.records()[0]!.value.cwd).toBe('D:\\work\\gamma');
  });

  test('workspaceStorage is the sibling of globalStorage', () => {
    expect(workspaceStorageDir(fx.dbPath)).toBe(fx.workspaceStorage);
  });

  test('cwd: composerData fsPath, then the header fsPath, then workspace.json; project id encoded, case-insensitively reused, else cursor-<workspaceId>', async () => {
    fx.put({ id: 'a', dataFsPath: 'd:\\work\\alpha', headerFsPath: 'd:\\other', bubbles: [userBubble('a1', 'hi')] });
    fx.put({ id: 'b', workspaceId: 'ws-b', headerFsPath: 'd:\\work\\beta', bubbles: [userBubble('b1', 'hi')] });
    fx.put({ id: 'c', workspaceId: 'ws-c', bubbles: [userBubble('c1', 'hi')] });
    fx.writeWorkspaceJson('ws-c', { folder: 'file:///d%3A/work/gamma' });
    fx.put({ id: 'd', workspaceId: 'ws-d', bubbles: [userBubble('d1', 'hi')] });
    fx.writeWorkspaceJson('ws-d', { workspace: 'file:///d%3A/x.code-workspace' });
    fx.put({ id: 'e', workspaceId: '..', bubbles: [userBubble('e1', 'hi')] });
    const s = await started({ knownProjectIds: () => ['D--work-alpha'] });
    await s.pollOnce();
    const composers = new Map(sink.records().filter((r) => r.recordType === 'composer').map((r) => [r.value.composerId as string, r]));
    expect(composers.get('a')!.value.cwd).toBe('D:\\work\\alpha'); // drive letter as Claude Code writes it
    expect(composers.get('a')!.projectId).toBe('D--work-alpha');
    expect(composers.get('b')!.value.cwd).toBe('D:\\work\\beta');
    expect(composers.get('b')!.projectId).toBe('D--work-beta');
    expect(composers.get('c')!.value.cwd).toBe('D:\\work\\gamma');
    expect(composers.get('d')!.value.cwd).toBeNull();
    expect(composers.get('d')!.projectId).toBe('cursor-ws-d');
    expect(composers.get('e')!.projectId).toBe('cursor-..');
    expect(composers.get('e')!.value.cwd).toBeNull();
  });
});

describe('database problems', () => {
  test('no database file: no reads, no error, no poll time', async () => {
    const s = await started({ dbPath: path.join(tmp, 'missing', 'state.vscdb') });
    await s.pollOnce();
    expect(sink.calls).toEqual([]);
    expect(s.status()).toEqual({ lastPollAt: null, lastError: null });
  });

  test('a missing table or column is a database-level error: round skipped, retried and cleared next round', async () => {
    fx.put({ id: 'a', bubbles: [userBubble('a1', 'hi')] });
    fx.exec('ALTER TABLE composerHeaders RENAME COLUMN isSubagent TO isSub');
    const s = await started();
    await s.pollOnce();
    expect(s.status().lastError).toMatch(/isSubagent/);
    expect(s.status().lastPollAt).toBeNull();
    expect(sink.calls).toEqual([]);
    fx.exec('ALTER TABLE composerHeaders RENAME COLUMN isSub TO isSubagent');
    await s.pollOnce();
    expect(s.status()).toEqual({ lastPollAt: new Date(clock).toISOString(), lastError: null });
    expect(sink.calls).toEqual(['ingest cursor:a composer,bubble']);
  });

  test('a file that is not a database: lastError, nothing thrown', async () => {
    const bad = path.join(tmp, 'bad.vscdb');
    fs.writeFileSync(bad, 'not sqlite at all, just some invented text'.repeat(200));
    const s = await started({ dbPath: bad });
    await s.pollOnce();
    expect(s.status().lastError).toMatch(/Cursor/);
  });

  test('opening never creates a missing database file', () => {
    const missing = path.join(tmp, 'nope.vscdb');
    const opened = openCursorDb(missing);
    expect(opened.ok).toBe(false);
    expect(fs.existsSync(missing)).toBe(false);
  });

  test('the handle is read-only: the reader leaves the database unchanged', async () => {
    fx.put({ id: 'c', bubbles: [userBubble('u1', 'go')] });
    const before = fs.readFileSync(fx.dbPath);
    const s = await started();
    await s.pollOnce();
    await s.pollOnce();
    expect(sink.calls).toEqual(['ingest cursor:c composer,bubble']);
    expect(fs.readFileSync(fx.dbPath).equals(before)).toBe(true);
  });
});

describe('selection and records', () => {
  test('unarchived non-draft main conversations and the subagents of picked roots; composer first, then bubbles', async () => {
    fx.put({
      id: 'main',
      name: 'Main one',
      subagentComposerIds: ['sub'],
      bubbles: [userBubble('m1', 'do it'), toolBubble('m2', 'task_v2', 'completed', T0 + 1, { toolCallId: 'tc-sub' }), textBubble('m3', 'done')],
    });
    fx.put({ id: 'arch', isArchived: true, bubbles: [userBubble('x1', 'old')] });
    fx.put({ id: 'draft', isDraft: true, bubbles: [] });
    fx.put({
      id: 'sub',
      isSubagent: true,
      subagentInfo: { subagentType: 1, subagentTypeName: 'explore', parentComposerId: 'main', rootParentConversationId: 'main', toolCallId: 'tc-sub' },
      bubbles: [userBubble('s1', 'look around'), thinkingBubble('s2', 'hmm')],
    });
    fx.put({
      id: 'sub-of-arch',
      isSubagent: true,
      subagentInfo: { parentComposerId: 'arch', rootParentConversationId: 'arch', toolCallId: 'tc-x' },
      bubbles: [userBubble('z1', 'nope')],
    });
    const s = await started();
    await s.pollOnce();
    expect(sink.calls).toEqual(['ingest cursor:main composer,bubble,bubble,bubble', 'ingest cursor:main/sub composer,bubble,bubble']);
    const main = sink.batches[0]!;
    expect(main).toMatchObject({ key: 'cursor:main', sessionId: 'main', agentId: null, projectId: 'cursor-ws-1' });
    const sub = sink.batches[1]!;
    expect(sub).toMatchObject({ key: 'cursor:main/sub', sessionId: 'main', agentId: 'sub', projectId: 'cursor-ws-1' });
    const composer = JSON.parse(main.records[0]!.line) as CursorComposerRecord;
    expect(composer).toMatchObject({ composerId: 'main', name: 'Main one', status: 'completed', modelName: 'synthetic-model', subagentInfo: null });
    expect(composer).not.toHaveProperty('bubbleIds');
    expect(composer).not.toHaveProperty('lastUpdatedAt');
    expect((JSON.parse(sub.records[0]!.line) as CursorComposerRecord).subagentInfo).toMatchObject({ rootParentConversationId: 'main', toolCallId: 'tc-sub' });
    const bubbles = main.records.slice(1).map((r) => JSON.parse(r.line) as CursorBubbleRecord);
    expect(bubbles.map((b) => [b.bubbleId, b.order])).toEqual([['m1', 0], ['m2', 1], ['m3', 2]]);
    expect(reads).not.toContain('bubble:arch:x1');
    expect(reads.filter((r) => r.startsWith('composerData:arch'))).toEqual([]);
    expect(sink.failures.size).toBe(0);
  });

  test('a conversation archived by value only is not imported; text values are decoded too', async () => {
    fx.put({ id: 'a', bubbles: [userBubble('a1', 'hi')] });
    fx.exec(`UPDATE composerHeaders SET value = json_set(value, '$.isArchived', json('true')) WHERE composerId = 'a'`);
    fx.put({ id: 'b', bubbles: [] });
    fx.setKv('bubbleId:b:t', JSON.stringify(userBubble('t', 'as text')), true);
    fx.setKv('composerData:b', JSON.stringify({ composerId: 'b', fullConversationHeadersOnly: [{ bubbleId: 't', type: 1 }] }), true);
    const s = await started();
    await s.pollOnce();
    expect(sink.calls).toEqual(['ingest cursor:b composer,bubble']);
  });

  test('a conversation without composerData stores nothing and is not a failure', async () => {
    fx.put({ id: 'empty', withData: false });
    const s = await started();
    await s.pollOnce();
    expect(sink.calls).toEqual([]);
    expect(sink.failures.size).toBe(0);
  });

  test('a subagent no session reaches (no links at all) is not collected, is no failure, and is probed once', async () => {
    fx.put({ id: 'main', bubbles: [userBubble('m1', 'go')] });
    fx.put({ id: 'lost', isSubagent: true, bubbles: [userBubble('l1', 'x')] });
    const s = await started();
    await s.pollOnce();
    expect(sink.calls).toEqual(['ingest cursor:main composer,bubble']);
    expect(sink.failures.size).toBe(0);
    reads = [];
    await s.pollOnce();
    expect(reads).toEqual([]); // not looked at again until it changes
  });
});

describe('incremental reads', () => {
  function setup(): void {
    const bubbles = [userBubble('u1', 'start')];
    for (let i = 0; i < 30; i += 1) bubbles.push(toolBubble(`t${i}`, 'read_file', 'completed', T0 + i));
    bubbles.push(toolBubble('live', 'run_terminal_cmd', 'loading', T0 + 100));
    fx.put({ id: 'c', lastUpdatedAt: T0, bubbles });
  }

  test('unchanged and not recent: nothing read, nothing stored', async () => {
    setup();
    const s = await started();
    await s.pollOnce();
    reads = [];
    sink.reset();
    await s.pollOnce();
    expect(reads).toEqual([]);
    expect(sink.calls).toEqual([]);
  });

  test('changed: reads only unseen, unfinished and the last 20 bubbles; stores only what changed', async () => {
    setup();
    const s = await started();
    await s.pollOnce();
    reads = [];
    sink.reset();
    fx.update('c', { lastUpdatedAt: T0 + 5000 });
    // the loading tool completes, a new bubble arrives
    fx.setBubble('c', toolBubble('live', 'run_terminal_cmd', 'completed', T0 + 100, { toolCallId: 'call-live' }));
    fx.setBubble('c', textBubble('new', 'all done', T0 + 200));
    fx.exec(
      `UPDATE cursorDiskKV SET value = json_set(CAST(value AS TEXT), '$.fullConversationHeadersOnly', json_insert(json_extract(CAST(value AS TEXT), '$.fullConversationHeadersOnly'), '$[#]', json('{"bubbleId":"new","type":2}'))) WHERE key = 'composerData:c'`,
    );
    await s.pollOnce();
    const bubbleReads = reads.filter((r) => r.startsWith('bubble:')).map((r) => r.split(':')[2]);
    // tail of 20 over 33 ids: t12..t29, live, new; plus nothing else (u1, t0..t11 are finished and not in the tail)
    expect(bubbleReads).toEqual([...Array.from({ length: 18 }, (_, i) => `t${i + 12}`), 'live', 'new']);
    const stored = sink.records();
    // the composer's slow facts did not change: only the two bubbles are stored
    expect(stored.map((r) => (r.recordType === 'composer' ? 'composer' : (r.value.bubbleId as string)))).toEqual(['live', 'new']);
    expect((stored[0]!.value as unknown as CursorBubbleRecord).toolFormerData?.status).toBe('completed');
    expect((stored[1]!.value as unknown as CursorBubbleRecord).order).toBe(32);
  });

  test('the composer is stored again only when a slow fact changes (status)', async () => {
    fx.put({ id: 'c', status: 'none', bubbles: [userBubble('u1', 'go')] });
    const s = await started();
    await s.pollOnce();
    sink.reset();
    fx.update('c', { lastUpdatedAt: T0 + 10, bubbles: [userBubble('u1', 'go'), textBubble('a1', 'ok')] });
    await s.pollOnce();
    expect(sink.calls).toEqual(['ingest cursor:c bubble']);
    sink.reset();
    fx.update('c', { lastUpdatedAt: T0 + 20, status: 'completed' });
    await s.pollOnce();
    expect(sink.calls).toEqual(['ingest cursor:c composer']);
    expect(sink.records()[0]!.value.status).toBe('completed');
  });

  /** Rewrites composerData:c's bubble list to these ids (first a user bubble, then assistant ones) and bumps lastUpdatedAt. */
  function setList(ids: string[]): void {
    const list = JSON.stringify(ids.map((id, i) => ({ bubbleId: id, type: i === 0 ? 1 : 2 })));
    fx.exec(`UPDATE cursorDiskKV SET value = json_set(CAST(value AS TEXT), '$.fullConversationHeadersOnly', json('${list}')) WHERE key = 'composerData:c'`);
    fx.exec(`UPDATE composerHeaders SET lastUpdatedAt = lastUpdatedAt + 1 WHERE composerId = 'c'`);
  }

  test('a bubble whose index changes outside the tail is re-read and stored with its new order', async () => {
    const bubbles = [userBubble('u1', 'start')];
    for (let i = 0; i < 30; i += 1) bubbles.push(textBubble(`x${i}`, `line ${i}`, T0 + i));
    fx.put({ id: 'c', bubbles });
    const s = await started();
    await s.pollOnce();
    reads = [];
    sink.reset();
    // a bubble inserted at index 3: x2 and later shift by one, most of them outside the tail of 20
    fx.setBubble('c', textBubble('ins', 'inserted', T0 + 2));
    const ids = bubbles.map((b) => b.bubbleId);
    ids.splice(3, 0, 'ins');
    setList(ids);
    await s.pollOnce();
    const bubbleReads = reads.filter((r) => r.startsWith('bubble:')).map((r) => r.split(':')[2]);
    expect(bubbleReads).toEqual(ids.slice(3)); // u1, x0, x1 kept their index and are finished: not read
    expect(sink.records().map((r) => [r.value.bubbleId, r.value.order])).toEqual(ids.slice(3).map((id, i) => [id, i + 3]));
  });

  test('a bubble that disappears from the list: nothing is emitted for it; the ones after it move up', async () => {
    fx.put({ id: 'c', bubbles: [userBubble('u1', 'go'), textBubble('a1', 'one'), textBubble('a2', 'two')] });
    const s = await started();
    await s.pollOnce();
    sink.reset();
    setList(['u1', 'a2']);
    await s.pollOnce();
    expect(sink.records().map((r) => [r.recordType, r.value.bubbleId, r.value.order])).toEqual([['bubble', 'a2', 1]]);
  });

  test('an unfinished bubble outside the tail is re-read until it finishes', async () => {
    const bubbles = [userBubble('u1', 'start'), toolBubble('slow', 'run_terminal_cmd', 'loading', T0)];
    for (let i = 0; i < 25; i += 1) bubbles.push(textBubble(`x${i}`, `line ${i}`, T0 + i));
    fx.put({ id: 'c', bubbles });
    const s = await started();
    await s.pollOnce();
    fx.update('c', { lastUpdatedAt: T0 + 1 });
    reads = [];
    await s.pollOnce();
    expect(reads).toContain('bubble:c:slow');
    expect(reads).not.toContain('bubble:c:u1');
  });

  test('recently active: processed every round even when lastUpdatedAt did not move', async () => {
    fx.put({ id: 'c', lastUpdatedAt: T0, bubbles: [userBubble('u1', 'go'), toolBubble('t1', 'grep', 'loading', T0)] });
    clock = T0 + RECENT_MS - 60_000;
    const s = await started();
    await s.pollOnce();
    reads = [];
    sink.reset();
    fx.setBubble('c', toolBubble('t1', 'grep', 'completed', T0, { toolCallId: 'call-t1' }));
    await s.pollOnce();
    expect(reads).toContain('composerData:c');
    expect(sink.records().map((r) => r.value.bubbleId ?? 'composer')).toEqual(['t1']);
    clock = T0 + RECENT_MS + 120_000; // our last observed change was at T0 + RECENT_MS - 60_000: still recent
    reads = [];
    await s.pollOnce();
    expect(reads).toContain('composerData:c');
    clock += RECENT_MS;
    reads = [];
    await s.pollOnce();
    expect(reads).toEqual([]);
  });

  test('records are remembered only once stored: a rejected batch is sent again next round', async () => {
    fx.put({ id: 'c', bubbles: [userBubble('u1', 'go')] });
    const s = await started();
    sink.failIngest = new Error('disk full');
    await s.pollOnce();
    expect(sink.failures.get('cursor:c')).toBe('disk full');
    sink.failIngest = null;
    await s.pollOnce();
    expect(sink.calls).toEqual(['ingest cursor:c composer,bubble']);
    expect(sink.failures.size).toBe(0);
  });

  test('a bubble that does not parse: the others are stored, the failure is visible, it is retried and cleared', async () => {
    fx.put({ id: 'c', bubbles: [userBubble('u1', 'go'), textBubble('b2', 'ok')] });
    fx.put({ id: 'other', bubbles: [userBubble('o1', 'fine')] });
    fx.setBubbleRaw('c', 'u1', '{"bubbleId": "u1", broken');
    const s = await started();
    await s.pollOnce();
    expect(sink.calls).toEqual(['ingest cursor:c composer,bubble', 'ingest cursor:other composer,bubble']);
    expect(sink.failures.get('cursor:c')).toMatch(/u1/);
    fx.setBubble('c', userBubble('u1', 'go'));
    sink.reset();
    await s.pollOnce();
    expect(sink.calls).toEqual(['ingest cursor:c bubble']);
    expect(sink.failures.size).toBe(0);
  });

  test('composerData that does not parse fails that conversation only', async () => {
    fx.put({ id: 'c', bubbles: [userBubble('u1', 'go')] });
    fx.put({ id: 'd', bubbles: [userBubble('d1', 'go')] });
    fx.setKv('composerData:c', '{nope');
    const s = await started();
    await s.pollOnce();
    expect(sink.calls).toEqual(['ingest cursor:d composer,bubble']);
    expect(sink.failures.get('cursor:c')).toMatch(/not JSON/);
    expect(s.status().lastError).toBeNull();
  });

  test('lines are deterministic: a fresh source over the same data produces the same lines', async () => {
    fx.put({ id: 'c', bubbles: [userBubble('u1', 'go'), toolBubble('t1', 'grep', 'completed'), thinkingBubble('k', 'hm')] });
    const a = await started();
    await a.pollOnce();
    const first = sink.batches.flatMap((b) => b.records.map((r) => r.line));
    const other = new FakeSink();
    clock += 12_345;
    const b = await started({}, other);
    await b.pollOnce();
    expect(other.batches.flatMap((x) => x.records.map((r) => r.line))).toEqual(first);
  });
});

describe('archive, disappearance, restart', () => {
  test('archived after collection: marked once, never read again; unarchived: flag cleared and read again', async () => {
    fx.put({ id: 'c', bubbles: [userBubble('u1', 'go')] });
    fx.put({ id: 's', isSubagent: true, subagentInfo: { rootParentConversationId: 'c', parentComposerId: 'c', toolCallId: 'tc' }, bubbles: [userBubble('s1', 'x')] });
    const s = await started();
    await s.pollOnce();
    sink.reset();
    fx.update('c', { isArchived: true, lastUpdatedAt: T0 + 10 });
    fx.update('s', { lastUpdatedAt: T0 + 10 });
    reads = [];
    await s.pollOnce();
    await s.pollOnce();
    expect(sink.calls).toEqual(['deleted c']);
    expect(reads).toEqual([]);
    fx.update('c', { isArchived: false, lastUpdatedAt: T0 + 20 });
    await s.pollOnce();
    expect(sink.calls).toEqual(['deleted c', 'undeleted c', 'ingest cursor:c composer,bubble', 'ingest cursor:c/s composer,bubble']);
  });

  test('gone from composerHeaders: marked "source deleted"', async () => {
    fx.put({ id: 'c', bubbles: [userBubble('u1', 'go')] });
    fx.put({ id: 'other', bubbles: [userBubble('o1', 'go')] });
    const s = await started();
    await s.pollOnce();
    sink.reset();
    fx.remove('c');
    await s.pollOnce();
    expect(sink.calls).toEqual(['deleted c']);
  });

  test('an empty header table while sessions are held marks nothing (a database being recreated)', async () => {
    fx.put({ id: 'c', bubbles: [userBubble('u1', 'go')] });
    sink.stored = ['c', 'old'];
    const s = await started();
    await s.pollOnce();
    expect(sink.calls.filter((c) => c.startsWith('deleted'))).toEqual(['deleted old']);
    sink.reset();
    fx.remove('c');
    await s.pollOnce();
    expect(sink.calls).toEqual([]); // c not marked
    expect(s.status().lastError).toBeNull();
    // rows back: nothing to undo, nothing marked
    fx.put({ id: 'c', bubbles: [userBubble('u1', 'go')] });
    await s.pollOnce();
    expect(sink.calls.filter((c) => c.startsWith('deleted') || c.startsWith('undeleted'))).toEqual([]);
  });

  test('a failing markSourceDeleted is reported and retried; the round still reads conversations', async () => {
    fx.put({ id: 'c', bubbles: [userBubble('u1', 'go')] });
    sink.stored = ['gone'];
    let fail = true;
    const mark = sink.markSourceDeleted.bind(sink);
    sink.markSourceDeleted = async (id) => {
      if (fail) throw new Error('store busy');
      return mark(id);
    };
    const s = await started();
    await s.pollOnce();
    expect(sink.failures.get('cursor:gone')).toBe('store busy');
    expect(sink.calls).toContain('ingest cursor:c composer,bubble');
    expect(s.status().lastPollAt).not.toBeNull();
    fail = false;
    await s.pollOnce();
    expect(sink.calls).toContain('deleted gone');
  });

  test('a failing storedSessionIds is retried next round', async () => {
    fx.put({ id: 'c', bubbles: [userBubble('u1', 'go')] });
    let fail = true;
    sink.storedSessionIds = () => {
      if (fail) throw new Error('not yet');
      return ['gone', 'c'];
    };
    const s = await started();
    await s.pollOnce();
    expect(sink.failures.get('cursor:poll')).toBe('not yet');
    expect(sink.calls.some((c) => c.startsWith('deleted'))).toBe(false);
    fail = false;
    await s.pollOnce();
    expect(sink.calls).toContain('deleted gone');
    expect(sink.calls).toContain('undeleted c');
  });

  test('after a restart, stored sessions now archived or gone are marked; picked ones are cleared and re-read', async () => {
    fx.put({ id: 'live', bubbles: [userBubble('u1', 'go')] });
    fx.put({ id: 'arch', isArchived: true, bubbles: [userBubble('a1', 'old')] });
    sink.stored = ['arch', 'gone', 'live'];
    const s = await started();
    await s.pollOnce();
    expect(sink.calls).toEqual(['deleted arch', 'deleted gone', 'undeleted live', 'ingest cursor:live composer,bubble']);
    sink.reset();
    await s.pollOnce();
    expect(sink.calls).toEqual([]);
  });

  test('a conversation never collected is not marked when archived', async () => {
    fx.put({ id: 'c', isArchived: true, bubbles: [userBubble('u1', 'go')] });
    const s = await started();
    await s.pollOnce();
    expect(sink.calls).toEqual([]);
  });
});

describe('loop', () => {
  test('start schedules an immediate round, then one every interval; stop cancels', async () => {
    fx.put({ id: 'c', bubbles: [userBubble('u1', 'go')] });
    const timers = new ManualTimers();
    const s = source({ timers, intervalMs: 3000 });
    s.start(sink);
    expect(timers.pending.map((t) => t.ms)).toEqual([0]);
    timers.fire();
    await s.pollOnce(); // waits for the fired round
    expect(sink.calls).toEqual(['ingest cursor:c composer,bubble']);
    expect(timers.pending.map((t) => t.ms)).toEqual([3000]);
    await s.stop();
    expect(timers.pending).toEqual([]);
    await s.pollOnce();
    expect(s.status().lastPollAt).not.toBeNull();
  });

  test('poke: an extra round that processes the poked session even when unchanged', async () => {
    fx.put({ id: 'c', bubbles: [userBubble('u1', 'go')] });
    fx.put({ id: 's', isSubagent: true, subagentInfo: { rootParentConversationId: 'c', toolCallId: 'tc' }, bubbles: [userBubble('s1', 'x')] });
    fx.put({ id: 'd', bubbles: [userBubble('d1', 'go')] });
    const s = await started();
    await s.pollOnce();
    reads = [];
    s.poke('c');
    s.poke('c');
    await s.pollOnce();
    expect(reads).toEqual(['composerData:c', 'bubble:c:u1', 'composerData:s', 'bubble:s:s1']);
  });

  test('poke before start or after stop does nothing', async () => {
    fx.put({ id: 'c', bubbles: [userBubble('u1', 'go')] });
    const s = source();
    s.poke('c');
    await s.pollOnce();
    expect(reads).toEqual([]);
    s.start(sink);
    await s.stop();
    s.poke('c');
    await s.pollOnce();
    expect(reads).toEqual([]);
  });
});

describe('robustness (fix round 2)', () => {
  /** Wraps the tracing reader: optional failures, counts opens / closes and overlapping handles. */
  function instrumented(
    opts: { bubble?: (id: string, b: string) => DbResult<string | null> | null; composerData?: (id: string) => DbResult<string | null> | null } = {},
  ) {
    const stats = { opens: 0, closes: 0, open: 0, overlapped: false };
    const openDb = (p: string): DbResult<CursorDbReader> => {
      const r = tracingOpen(p);
      if (!r.ok) return r;
      stats.opens += 1;
      stats.open += 1;
      if (stats.open > 1) stats.overlapped = true;
      const db = r.value;
      return {
        ok: true,
        value: {
          headers: () => db.headers(),
          composerData: (id) => opts.composerData?.(id) ?? db.composerData(id),
          bubble: (id, b) => opts.bubble?.(id, b) ?? db.bubble(id, b),
          headerPages: (id) => db.headerPages(id),
          close: () => {
            stats.closes += 1;
            stats.open -= 1;
            db.close();
          },
        },
      };
    };
    return { stats, openDb };
  }
  const busy = (): DbResult<string | null> => ({ ok: false, error: Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }) });
  const odd = (): DbResult<string | null> => ({ ok: false, error: new Error('something odd') });
  const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

  test('a database-level lookup error mid-round ends the round: lastError, no conversation blamed, retried next round', async () => {
    fx.put({ id: 'a', lastUpdatedAt: T0 + 3, bubbles: [userBubble('a1', 'go')] });
    fx.put({ id: 'b', lastUpdatedAt: T0 + 2, bubbles: [userBubble('b1', 'go')] });
    fx.put({ id: 'c', lastUpdatedAt: T0 + 1, bubbles: [userBubble('c1', 'go')] });
    let locked = true;
    const { stats, openDb } = instrumented({ bubble: (id) => (locked && id === 'b' ? busy() : null) });
    const s = await started({ openDb });
    await s.pollOnce();
    expect(sink.calls).toEqual(['ingest cursor:a composer,bubble']);
    expect(reads).not.toContain('composerData:c');
    expect(sink.failures.size).toBe(0);
    expect(s.status().lastError).toMatch(/unavailable.*locked/);
    expect(s.status().lastPollAt).toBeNull();
    expect(stats.closes).toBe(stats.opens);
    locked = false;
    await s.pollOnce();
    expect(sink.calls).toEqual(['ingest cursor:a composer,bubble', 'ingest cursor:b composer,bubble', 'ingest cursor:c composer,bubble']);
    expect(s.status().lastError).toBeNull();
  });

  test('three consecutive failed lookups end the round whatever the error; fewer are per-conversation failures', async () => {
    for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) fx.put({ id, lastUpdatedAt: T0 + 10 - i, bubbles: [userBubble(`${id}1`, 'go')] });
    const tried: string[] = [];
    const { openDb } = instrumented({
      composerData: (id) => {
        tried.push(id);
        return odd();
      },
    });
    const s = await started({ openDb });
    await s.pollOnce();
    expect([...sink.failures.keys()]).toEqual(['cursor:a', 'cursor:b']);
    expect(tried).toEqual(['a', 'b', 'c']);
    expect(s.status().lastError).toMatch(/something odd/);
  });

  test('the handle is closed on every path: abandoned round, open failure, normal round', async () => {
    fx.put({ id: 'a', bubbles: [userBubble('a1', 'go')] });
    let fail = true;
    const { stats, openDb } = instrumented({ bubble: () => (fail ? busy() : null) });
    const s = await started({ openDb });
    await s.pollOnce(); // abandoned
    fail = false;
    fx.exec('ALTER TABLE composerHeaders RENAME TO composerHeadersX');
    await s.pollOnce(); // open fails (statement prepare): the reader closes its own handle
    fx.exec('ALTER TABLE composerHeadersX RENAME TO composerHeaders');
    await s.pollOnce(); // normal
    expect(stats.opens).toBe(2);
    expect(stats.closes).toBe(2);
    expect(stats.open).toBe(0);
  });

  test('stop() mid-round: the round stops between conversations, closes the handle, and is not a completed poll', async () => {
    fx.put({ id: 'a', lastUpdatedAt: T0 + 2, bubbles: [userBubble('a1', 'go')] });
    fx.put({ id: 'b', lastUpdatedAt: T0 + 1, bubbles: [userBubble('b1', 'go')] });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ingest = sink.ingestRecords.bind(sink);
    sink.ingestRecords = async (batch) => {
      await gate;
      return ingest(batch);
    };
    const { stats, openDb } = instrumented();
    const s = await started({ openDb });
    const round = s.pollOnce();
    await tick();
    await tick();
    const stopping = s.stop();
    release();
    await stopping;
    await round;
    expect(sink.calls).toEqual(['ingest cursor:a composer,bubble']);
    expect(reads).not.toContain('composerData:b');
    expect(s.status().lastPollAt).toBeNull();
    expect(stats.closes).toBe(stats.opens);
  });

  test('a poke during a running round is served by one more round; rounds never overlap', async () => {
    fx.put({ id: 'a', bubbles: [userBubble('a1', 'go')] });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ingest = sink.ingestRecords.bind(sink);
    sink.ingestRecords = async (batch) => {
      await gate;
      return ingest(batch);
    };
    const { stats, openDb } = instrumented();
    const s = await started({ openDb });
    const round = s.pollOnce();
    await tick();
    await tick();
    s.poke('a');
    s.poke('a');
    const extra = s.pollOnce(); // queued behind the poked round
    release();
    await round;
    await extra;
    expect(reads.filter((r) => r === 'composerData:a')).toHaveLength(2); // first round + the poked round
    expect(stats.overlapped).toBe(false);
    expect(stats.opens).toBe(3);
  });

  test('nested subagents: a child read before its parent waits for the parent root, then joins the session', async () => {
    fx.put({ id: 'root', lastUpdatedAt: T0, bubbles: [userBubble('r1', 'go')] });
    fx.put({
      id: 'child',
      isSubagent: true,
      lastUpdatedAt: T0 + 1,
      subagentInfo: { parentComposerId: 'root', rootParentConversationId: 'root', toolCallId: 't1' },
      bubbles: [userBubble('c1', 'x')],
    });
    // newer than its parent (read first), and no rootParentConversationId
    fx.put({ id: 'grand', isSubagent: true, lastUpdatedAt: T0 + 2, subagentInfo: { parentComposerId: 'child', toolCallId: 't2' }, bubbles: [userBubble('g1', 'y')] });
    const s = await started();
    await s.pollOnce();
    expect(sink.batches.find((b) => b.key === 'cursor:root/grand')).toMatchObject({ sessionId: 'root', agentId: 'grand' });
    expect(sink.failures.size).toBe(0);
  });

  test('a nested subagent whose parent is not readable is not guessed: it waits, without a failure', async () => {
    fx.put({ id: 'root', bubbles: [userBubble('r1', 'go')] });
    fx.put({ id: 'mid', isSubagent: true, withData: false });
    fx.put({ id: 'leaf', isSubagent: true, subagentInfo: { parentComposerId: 'mid', toolCallId: 't' }, bubbles: [userBubble('l1', 'x')] });
    const s = await started();
    await s.pollOnce();
    expect(sink.batches.map((b) => b.key)).toEqual(['cursor:root']);
    expect(sink.failures.size).toBe(0);
    // mid becomes readable later, naming the root: leaf follows in the same round
    fx.update('mid', {
      withData: true,
      lastUpdatedAt: T0 + 5,
      subagentInfo: { parentComposerId: 'root', rootParentConversationId: 'root', toolCallId: 'tm' },
      bubbles: [userBubble('m1', 'z')],
    });
    await s.pollOnce();
    expect(sink.batches.find((b) => b.key === 'cursor:root/leaf')).toMatchObject({ sessionId: 'root', agentId: 'leaf' });
  });

  test('a root without composerData: nothing stored for it or its subagents, no failure', async () => {
    fx.put({ id: 'root', withData: false });
    fx.put({ id: 'sub', isSubagent: true, subagentInfo: { rootParentConversationId: 'root', toolCallId: 't' }, bubbles: [userBubble('s1', 'x')] });
    const s = await started();
    await s.pollOnce();
    await s.pollOnce();
    expect(sink.calls).toEqual([]);
    expect(sink.failures.size).toBe(0);
    expect(s.status().lastError).toBeNull();
  });

  test('the database file deleted, then replaced, between rounds', async () => {
    fx.put({ id: 'c', bubbles: [userBubble('u1', 'go')] });
    const s = await started();
    await s.pollOnce();
    sink.reset();
    const dir = path.dirname(fx.dbPath);
    fx.close();
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
    await s.pollOnce(); // gone: Cursor "not installed", nothing marked
    expect(sink.calls).toEqual([]);
    expect(s.status().lastError).toBeNull();
    fx = new CursorDbFixture(path.join(tmp, 'Cursor'));
    fx.put({ id: 'n', bubbles: [userBubble('n1', 'new')] });
    await s.pollOnce();
    expect(sink.calls).toEqual(['deleted c', 'ingest cursor:n composer,bubble']);
  });

  test('yields to the event loop between conversations and inside a long conversation', async () => {
    fx.put({ id: 'a', lastUpdatedAt: T0 + 2, bubbles: [userBubble('a1', 'go')] });
    const many = [userBubble('b0', 'go')];
    for (let i = 1; i < 12; i += 1) many.push(textBubble(`b${i}`, `t${i}`, T0 + i));
    fx.put({ id: 'b', lastUpdatedAt: T0 + 1, bubbles: many });
    let fired = false;
    let firedMidConversation = false;
    const { openDb } = instrumented({
      bubble: (id, b) => {
        if (id !== 'b') return null;
        if (b === 'b0') setImmediate(() => (fired = true));
        if (b === 'b11') firedMidConversation = fired;
        const until = performance.now() + 3; // a slow lookup
        while (performance.now() < until) {
          // busy
        }
        return null;
      },
    });
    let ticked = false;
    let tickedBeforeB = false;
    const ingest = sink.ingestRecords.bind(sink);
    sink.ingestRecords = async (batch) => {
      if (batch.key === 'cursor:a') setImmediate(() => (ticked = true));
      if (batch.key === 'cursor:b') tickedBeforeB = ticked;
      return ingest(batch);
    };
    const s = await started({ openDb });
    await s.pollOnce();
    expect(tickedBeforeB).toBe(true); // between conversations
    expect(firedMidConversation).toBe(true); // 12 lookups of 3 ms exceed the 10 ms budget
  });
});

describe('paged header lists (fix round 3)', () => {
  function many(prefix: string, n: number): FixtureBubble[] {
    const out: FixtureBubble[] = [userBubble(`${prefix}0`, 'go')];
    for (let i = 1; i < n; i += 1) out.push(textBubble(`${prefix}${i}`, `t${i}`, T0 + i));
    return out;
  }

  test('an empty inline list uses the pages, concatenated in page order; order is the index in that list', async () => {
    fx.put({ id: 'c', paged: true, pageSize: 4, bubbles: many('b', 10) }); // pages 000000..000002
    const s = await started();
    await s.pollOnce();
    expect(reads.filter((r) => r.startsWith('pages:'))).toEqual(['pages:c']); // one range query
    const bubbles = sink.records().filter((r) => r.recordType === 'bubble');
    expect(bubbles.map((r) => [r.value.bubbleId, r.value.order])).toEqual(Array.from({ length: 10 }, (_, i) => [`b${i}`, i]));
    expect(sink.records()[0]!.recordType).toBe('composer');
  });

  test('pages are read by key range: page order follows the key, another conversation sharing a prefix is not included', async () => {
    fx.put({ id: 'c', paged: true, pageSize: 2, bubbles: many('b', 3) });
    fx.put({ id: 'c2', paged: true, bubbles: many('z', 2) });
    // a stray row under a neighbouring key family must not leak in
    fx.setKv('composerConvHeaders:c;x', JSON.stringify([{ bubbleId: 'nope', type: 1 }]));
    const s = await started();
    await s.pollOnce();
    const c = sink.records().filter((r) => r.key === 'cursor:c' && r.recordType === 'bubble');
    expect(c.map((r) => r.value.bubbleId)).toEqual(['b0', 'b1', 'b2']);
  });

  test('a non-empty inline list wins over pages', async () => {
    fx.put({ id: 'c', bubbles: [userBubble('i0', 'inline')] });
    fx.setKv(pageKey('c', 0), JSON.stringify([{ bubbleId: 'p0', type: 1 }]));
    fx.setBubble('c', userBubble('p0', 'paged'));
    const s = await started();
    await s.pollOnce();
    expect(sink.records().filter((r) => r.recordType === 'bubble').map((r) => r.value.bubbleId)).toEqual(['i0']);
    expect(reads).not.toContain('pages:c');
  });

  test('incremental reads on top of pages: unchanged and quiet = no page read; a new bubble on the last page = tail + new only', async () => {
    const bubbles = many('b', 40);
    fx.put({ id: 'c', paged: true, pageSize: 16, bubbles });
    const s = await started();
    await s.pollOnce();
    reads = [];
    sink.reset();
    await s.pollOnce();
    expect(reads).toEqual([]);
    fx.update('c', { lastUpdatedAt: T0 + 100, bubbles: [...bubbles, textBubble('new', 'fresh', T0 + 100)] });
    await s.pollOnce();
    const bubbleReads = reads.filter((r) => r.startsWith('bubble:')).map((r) => r.split(':')[2]);
    expect(bubbleReads).toEqual([...Array.from({ length: 19 }, (_, i) => `b${i + 21}`), 'new']);
    expect(sink.records().map((r) => [r.value.bubbleId, r.value.order])).toEqual([['new', 40]]);
  });

  test('a page that is not JSON fails that conversation only', async () => {
    fx.put({ id: 'c', paged: true, bubbles: many('b', 2) });
    fx.put({ id: 'd', bubbles: [userBubble('d0', 'ok')] });
    fx.setKv(pageKey('c', 0), '[{"bubbleId": broken');
    const s = await started();
    await s.pollOnce();
    expect(sink.calls).toEqual(['ingest cursor:d composer,bubble']);
    expect(sink.failures.get('cursor:c')).toMatch(/page/);
  });
});

describe('empty conversations (fix round 3)', () => {
  test('a conversation without any bubble produces nothing; its composer comes first once it has one', async () => {
    fx.put({ id: 'e', bubbles: [] });
    fx.put({ id: 'p', paged: true, bubbles: [] });
    const s = await started();
    await s.pollOnce();
    expect(sink.calls).toEqual([]);
    expect(sink.failures.size).toBe(0);
    reads = [];
    await s.pollOnce();
    expect(reads).toEqual([]); // looked at again only when it changes
    fx.update('e', { lastUpdatedAt: T0 + 5, bubbles: [userBubble('e0', 'finally')] });
    await s.pollOnce();
    expect(sink.calls).toEqual(['ingest cursor:e composer,bubble']);
  });

  test('a subagent without bubbles produces nothing yet', async () => {
    fx.put({ id: 'm', subagentComposerIds: ['s'], bubbles: [userBubble('m0', 'go')] });
    fx.put({ id: 's', isSubagent: true, subagentInfo: { parentComposerId: 'm', toolCallId: 't' }, bubbles: [] });
    const s = await started();
    await s.pollOnce();
    expect(sink.calls).toEqual(['ingest cursor:m composer,bubble']);
  });

  test('an empty main conversation does not make its subagents a session', async () => {
    fx.put({ id: 'm', subagentComposerIds: ['s'], bubbles: [] });
    fx.put({ id: 's', isSubagent: true, subagentInfo: { parentComposerId: 'm', rootParentConversationId: 'm', toolCallId: 't' }, bubbles: [userBubble('s0', 'x')] });
    const s = await started();
    await s.pollOnce();
    expect(sink.calls).toEqual([]);
  });
});

describe('subagent ownership (fix round 3)', () => {
  const sub = (id: string, info: Record<string, unknown>, extra: Partial<ComposerSpec> = {}): ComposerSpec => ({
    id,
    isSubagent: true,
    subagentInfo: { toolCallId: `tc-${id}`, ...info },
    bubbles: [userBubble(`${id}-0`, `task ${id}`)],
    ...extra,
  });

  test('forks listing the same subagents: each subagent is stored once per owning session, under cursor:<session>/<subagent>', async () => {
    fx.put({ id: 'A', lastUpdatedAt: T0 + 2, subagentComposerIds: ['s1', 's2'], bubbles: [userBubble('a0', 'go')] });
    fx.put({ id: 'B', lastUpdatedAt: T0 + 1, subagentComposerIds: ['s1', 's2'], bubbles: [userBubble('b0', 'go')] });
    // rootParentConversationId points elsewhere (unreliable); the parents' lists decide
    fx.put(sub('s1', { parentComposerId: 'A', rootParentConversationId: 'X' }));
    fx.put(sub('s2', { parentComposerId: 'B', rootParentConversationId: 'X' }));
    fx.put({ id: 'X', bubbles: [userBubble('x0', 'unrelated')] });
    const s = await started();
    await s.pollOnce();
    const keys = sink.batches.map((b) => [b.key, b.sessionId, b.agentId]);
    expect(keys).toEqual(
      expect.arrayContaining([
        ['cursor:A/s1', 'A', 's1'],
        ['cursor:A/s2', 'A', 's2'],
        ['cursor:B/s1', 'B', 's1'],
        ['cursor:B/s2', 'B', 's2'],
      ]),
    );
    expect(keys.filter((k) => k[1] === 'X')).toEqual([['cursor:X', 'X', null]]);
    // the shared conversation was looked up once per round, not once per owner
    expect(reads.filter((r) => r === 'composerData:s1')).toHaveLength(1);
    // dedupe state is per (session, conversation): a change reaches both owners
    sink.reset();
    fx.update('s1', { lastUpdatedAt: T0 + 50, bubbles: [userBubble('s1-0', 'task s1'), textBubble('s1-1', 'more', T0 + 50)] });
    await s.pollOnce();
    expect(sink.calls.filter((c) => c.includes('/s1'))).toEqual(['ingest cursor:A/s1 bubble', 'ingest cursor:B/s1 bubble']);
  });

  test('nested subagents are reached through the subagents own subagentComposerIds', async () => {
    fx.put({ id: 'A', subagentComposerIds: ['s1'], bubbles: [userBubble('a0', 'go')] });
    fx.put(sub('s1', { parentComposerId: 'A' }, { subagentComposerIds: ['s3'] }));
    fx.put(sub('s3', { parentComposerId: 's1', rootParentConversationId: 'elsewhere' }));
    const s = await started();
    await s.pollOnce();
    expect(sink.batches.find((b) => b.key === 'cursor:A/s3')).toMatchObject({ sessionId: 'A', agentId: 's3' });
  });

  test('links without a list: parentComposerId reaches a session; rootParentConversationId only when no link exists', async () => {
    fx.put({ id: 'A', subagentComposerIds: ['s1'], bubbles: [userBubble('a0', 'go')] });
    fx.put({ id: 'B', bubbles: [userBubble('b0', 'go')] });
    fx.put(sub('s1', { parentComposerId: 'A' }));
    fx.put(sub('p1', { parentComposerId: 's1', rootParentConversationId: 'B' })); // parent link wins over root
    fx.put(sub('r1', { rootParentConversationId: 'B' })); // no link at all: root fallback
    const s = await started();
    await s.pollOnce();
    const owners = Object.fromEntries(sink.batches.filter((b) => b.agentId !== null).map((b) => [b.agentId, b.sessionId]));
    expect(owners).toEqual({ s1: 'A', p1: 'A', r1: 'B' });
  });

  test('the first round does not read the composerData of every unreachable subagent: probes are budgeted and done once', async () => {
    fx.put({ id: 'A', bubbles: [userBubble('a0', 'go')] });
    fx.put({ id: 'Z', isArchived: true, bubbles: [userBubble('z0', 'old')] });
    for (let i = 0; i < 40; i += 1) fx.put(sub(`o${i}`, { parentComposerId: 'Z', rootParentConversationId: 'Z' }));
    const s = await started();
    await s.pollOnce();
    const probes = () => reads.filter((r) => r.startsWith('composerData:o')).length;
    expect(probes()).toBe(ORPHAN_PROBES_PER_ROUND);
    for (let i = 0; i < 5; i += 1) await s.pollOnce();
    expect(probes()).toBe(40); // each once
    expect(sink.calls).toEqual(['ingest cursor:A composer,bubble']);
  });

  test('a subagent that disappears does not mark its session; archiving one fork leaves the other fork its subagents', async () => {
    fx.put({ id: 'A', subagentComposerIds: ['s1', 'gone'], bubbles: [userBubble('a0', 'go')] });
    fx.put({ id: 'B', subagentComposerIds: ['s1'], bubbles: [userBubble('b0', 'go')] });
    fx.put(sub('s1', { parentComposerId: 'A' }));
    fx.put(sub('gone', { parentComposerId: 'A' }));
    const s = await started();
    await s.pollOnce();
    sink.reset();
    fx.remove('gone');
    await s.pollOnce();
    expect(sink.calls).toEqual([]);
    fx.update('A', { isArchived: true, lastUpdatedAt: T0 + 9 });
    fx.update('s1', { lastUpdatedAt: T0 + 9, bubbles: [userBubble('s1-0', 'task s1'), textBubble('s1-1', 'later', T0 + 9)] });
    await s.pollOnce();
    expect(sink.calls).toEqual(['deleted A', 'ingest cursor:B/s1 bubble']);
  });

  test('restart: stored session ids come from both key forms; a subagent-only key never marks a session by itself', async () => {
    fx.put({ id: 'A', subagentComposerIds: ['s1'], bubbles: [userBubble('a0', 'go')] });
    fx.put(sub('s1', { parentComposerId: 'A' }));
    sink.stored = ['A', 'old'];
    const s = await started();
    await s.pollOnce();
    expect(sink.calls).toEqual(['deleted old', 'undeleted A', 'ingest cursor:A composer,bubble', 'ingest cursor:A/s1 composer,bubble']);
  });
});
