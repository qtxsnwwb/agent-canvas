import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { fileSources } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { LINE_GENERATION_PREFIX, Pipeline } from '../src/pipeline.js';
import { DeepSeekFileSource, type DeepSeekLookup } from '../src/sources/deepseek/source.js';
import { openStore } from '../src/store/store.js';
import type { FileSource } from '../src/sources/source.js';
import { readDshLines } from '../src/sources/deepseek/zstd-frames.js';
import { appendBatch, CHILD, CWD, encodeSegment, events, GRANDCHILD, HAS_ZSTD, headerLine, NO_ZSTD_REASON, PROJECT, projectKey, SID, sessionRel, V4, writeSession } from './deepseek-fixtures.js';

// DeepSeekFileSource: which files of <dsh home>/sessions are sessions, and which session each belongs to.

if (!HAS_ZSTD) console.warn(NO_ZSTD_REASON);

let tmp: string;
let home: string;
let root: string;

const abs = (rel: string): string => path.join(root, ...rel.split('/'));
const key = (rel: string): string => `deepseek:${rel}`;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-dsh-source-'));
  home = path.join(tmp, '.dsh');
  root = path.join(home, 'sessions');
  await fs.mkdir(root, { recursive: true });
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

describe('DeepSeekFileSource: keys and listing', () => {
  test('origin, root, depth, line identity, reader', () => {
    const s = new DeepSeekFileSource(home);
    expect(s.origin).toBe('deepseek');
    expect(s.rootDir).toBe(root);
    expect(s.watchDepth).toBe(2);
    expect(s.lineIdentity).toBe('offset');
    expect(s.readLines).toBe(readDshLines);
    expect((s as FileSource).watchRoots).toBeUndefined();
  });

  test('keys: only <project>/<session>/session.v4.jsonl.zstd', () => {
    const s = new DeepSeekFileSource(home);
    const rel = sessionRel(SID);
    expect(rel).toBe(`--D-Projects-Demo--/${SID}/${V4}`);
    expect(s.keyOf(abs(rel))).toBe(key(rel));
    expect(s.pathOf(key(rel))).toBe(abs(rel));
    const dir = `${projectKey(CWD)}/${SID}`;
    for (const other of [
      `${dir}/session.v3.jsonl.zstd`,
      `${dir}/session.jsonl.zstd`,
      `${dir}/session.v5.jsonl.zstd`,
      `${dir}/session.v4.jsonl`,
      `${dir}/session.v4.jsonl.zstd.0123456789ab.tmp`,
      `${dir}/session.migration.abc.jsonl.zstd.tmp`,
      `${dir}/session.lock`,
      `${projectKey(CWD)}/${SID}.jsonl.zstd`,
      `${dir}/sub/${V4}`,
      V4,
    ]) {
      expect(s.keyOf(abs(other)), other).toBeNull();
    }
    expect(s.keyOf(path.join(tmp, V4))).toBeNull();
    expect(s.pathOf('deepseek:nope')).toBeNull();
    expect(s.pathOf(`grok:${rel}`)).toBeNull();
  });

  test.skipIf(!HAS_ZSTD)('lists v4 files only; legacy directories counted, a higher version beside v4 counted and v4 still listed; temp files ignored', async () => {
    const at = (id: string, name: string): string => abs(sessionRel(id, CWD, name));
    await writeSession(at(SID, V4), headerLine());
    // Only old formats: counted, not listed.
    await writeSession(at('old-one', 'session.v3.jsonl.zstd'), headerLine({ id: 'old-one', version: 3 }));
    await writeSession(at('old-two', 'session.jsonl.zstd'), headerLine({ id: 'old-two', version: 0 }));
    await writeSession(at('old-two', 'session.v1.jsonl.zstd'), headerLine({ id: 'old-two', version: 1 }));
    // A v5 beside v4: counted, v4 still read.
    await writeSession(at('newer', V4), headerLine({ id: 'newer' }));
    await writeSession(at('newer', 'session.v5.jsonl.zstd'), headerLine({ id: 'newer', version: 5 }));
    // A v4 beside older generations: listed, not counted.
    await writeSession(at('migrated', V4), headerLine({ id: 'migrated' }));
    await writeSession(at('migrated', 'session.v3.jsonl.zstd'), headerLine({ id: 'migrated', version: 3 }));
    // Temp files, a lock, and a directory with nothing canonical: neither listed nor counted.
    await writeSession(at('tmp-only', `${V4}.0123456789ab.tmp`), headerLine({ id: 'tmp-only' }));
    await fs.writeFile(at('tmp-only', 'session.lock'), '');
    await writeSession(at('flat', 'notes.txt'), 'x');
    await fs.writeFile(path.join(root, projectKey(CWD), 'stray.jsonl.zstd'), 'x');
    const s = new DeepSeekFileSource(home);
    expect(s.status()).toEqual({ legacyFiles: 0 });
    expect(await s.listFiles()).toEqual([at('migrated', V4), at('newer', V4), at(SID, V4)].sort());
    expect(s.status()).toEqual({ legacyFiles: 3 });
  });

  test('a missing sessions directory: nothing listed, nothing created', async () => {
    await fs.rm(root, { recursive: true });
    const s = new DeepSeekFileSource(home);
    expect(await s.listFiles()).toEqual([]);
    await expect(fs.stat(root)).rejects.toThrow();
  });
});

describe.skipIf(!HAS_ZSTD)('DeepSeekFileSource: classification', () => {
  test('a main session: its header id, the project of its cwd', async () => {
    await writeSession(abs(sessionRel(SID)), headerLine(), [events(0, 2)]);
    const s = new DeepSeekFileSource(home);
    expect(await s.classify(key(sessionRel(SID)))).toEqual({ kind: 'session', projectId: PROJECT, sessionId: SID });
    expect(s.mainSessionOf(key(sessionRel(SID)))).toBe(SID);
    expect(s.projectOfKey(key(sessionRel(SID)))).toBeNull();
    expect(s.projectOfTranscript(abs(sessionRel(SID)))).toBe(PROJECT);
  });

  test('no cwd: project unknown; a header that is not a session header, or unreadable, is not classified (yet)', async () => {
    await writeSession(abs(sessionRel('nocwd', null)), headerLine({ id: 'nocwd', cwd: null }));
    await writeSession(abs(sessionRel('weird')), JSON.stringify({ type: 'other', id: 'weird' }));
    await fs.mkdir(path.dirname(abs(sessionRel('torn'))), { recursive: true });
    await fs.writeFile(abs(sessionRel('torn')), Buffer.from([0x28, 0xb5, 0x2f]));
    const s = new DeepSeekFileSource(home);
    expect(await s.classify(key(sessionRel('nocwd', null)))).toEqual({ kind: 'session', projectId: 'unknown', sessionId: 'nocwd' });
    expect(await s.classify(key(sessionRel('weird')))).toBeNull();
    expect(await s.classify(key(sessionRel('torn')))).toBeNull();
    expect(await s.classify(key(sessionRel('missing')))).toBeNull();
    expect(s.mainSessionOf(key(sessionRel('torn')))).toBeNull();
  });

  test('a fork (parentSession without origin subagent, or isSeeded) is a session of its own', async () => {
    await writeSession(abs(sessionRel(SID)), headerLine());
    await writeSession(abs(sessionRel(CHILD)), headerLine({ id: CHILD, parent: SID, seeded: true, depth: 0 }));
    const s = new DeepSeekFileSource(home);
    expect(await s.classify(key(sessionRel(CHILD)))).toEqual({ kind: 'session', projectId: PROJECT, sessionId: CHILD });
  });

  test('a subagent read after its parent: an agent thread of the parent', async () => {
    await writeSession(abs(sessionRel(SID)), headerLine());
    await writeSession(abs(sessionRel(CHILD)), headerLine({ id: CHILD, parent: SID, origin: 'subagent' }));
    const s = new DeepSeekFileSource(home);
    expect(await s.classify(key(sessionRel(SID)))).toEqual({ kind: 'session', projectId: PROJECT, sessionId: SID });
    expect(await s.classify(key(sessionRel(CHILD)))).toEqual({ kind: 'agent', projectId: PROJECT, sessionId: SID, agentId: CHILD });
    expect(s.mainSessionOf(key(sessionRel(CHILD)))).toBeNull();
  });

  test('a subagent whose parent file does not exist yet: null until it does', async () => {
    await writeSession(abs(sessionRel(CHILD)), headerLine({ id: CHILD, parent: SID, origin: 'subagent' }));
    const s = new DeepSeekFileSource(home);
    expect(await s.classify(key(sessionRel(CHILD)))).toBeNull();
    // A parent file with only part of its header frame is still unreadable.
    await fs.mkdir(path.dirname(abs(sessionRel(SID))), { recursive: true });
    await fs.writeFile(abs(sessionRel(SID)), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
    expect(await s.classify(key(sessionRel(CHILD)))).toBeNull();
    await writeSession(abs(sessionRel(SID)), headerLine());
    expect(await s.classify(key(sessionRel(CHILD)))).toEqual({ kind: 'agent', projectId: PROJECT, sessionId: SID, agentId: CHILD });
  });

  test('multi-level: a grandchild is a thread of the root, in every arrival order; a parent in another project directory is found', async () => {
    const otherCwd = 'D:\\Projects\\Elsewhere';
    const files = {
      root: () => writeSession(abs(sessionRel(SID)), headerLine()),
      child: () => writeSession(abs(sessionRel(CHILD, otherCwd)), headerLine({ id: CHILD, parent: SID, origin: 'subagent', cwd: otherCwd })),
      grand: () => writeSession(abs(sessionRel(GRANDCHILD)), headerLine({ id: GRANDCHILD, parent: CHILD, origin: 'subagent', depth: 2 })),
    };
    const orders: (keyof typeof files)[][] = [['grand', 'child', 'root'], ['child', 'grand', 'root'], ['root', 'grand', 'child'], ['root', 'child', 'grand']];
    for (const order of orders) {
      await fs.rm(root, { recursive: true, force: true });
      await fs.mkdir(root, { recursive: true });
      const s = new DeepSeekFileSource(home);
      for (const [i, which] of order.entries()) {
        await files[which]();
        await s.listFiles();
        const complete = i === order.length - 1;
        const grand = await s.classify(key(sessionRel(GRANDCHILD)));
        const present = order.slice(0, i + 1);
        if (present.includes('grand')) expect(grand, `${order.join(',')} @${i}`).toEqual(complete ? { kind: 'agent', projectId: PROJECT, sessionId: SID, agentId: GRANDCHILD } : null);
      }
      expect(await s.classify(key(sessionRel(CHILD, otherCwd)))).toEqual({ kind: 'agent', projectId: 'D--Projects-Elsewhere', sessionId: SID, agentId: CHILD });
    }
  });

  test('a cycle, or a chain longer than 16 links, is never classified', async () => {
    await writeSession(abs(sessionRel('a')), headerLine({ id: 'a', parent: 'b', origin: 'subagent' }));
    await writeSession(abs(sessionRel('b')), headerLine({ id: 'b', parent: 'a', origin: 'subagent' }));
    const s = new DeepSeekFileSource(home);
    expect(await s.classify(key(sessionRel('a')))).toBeNull();
    for (let i = 0; i <= 17; i++) await writeSession(abs(sessionRel(`n${i}`)), headerLine({ id: `n${i}`, ...(i === 0 ? {} : { parent: `n${i - 1}`, origin: 'subagent' as const }) }));
    expect(await s.classify(key(sessionRel('n16')))).toEqual({ kind: 'agent', projectId: PROJECT, sessionId: 'n0', agentId: 'n16' });
    expect(await s.classify(key(sessionRel('n17')))).toBeNull();
  });

  test('an id with characters dsh escapes is found by its encoded directory name', async () => {
    const odd = 'root id~1';
    expect(encodeSegment(odd)).toBe('root~0020id~007E1');
    await writeSession(abs(sessionRel(odd)), headerLine({ id: odd }));
    await writeSession(abs(sessionRel(CHILD)), headerLine({ id: CHILD, parent: odd, origin: 'subagent' }));
    const s = new DeepSeekFileSource(home);
    expect(await s.classify(key(sessionRel(CHILD)))).toEqual({ kind: 'agent', projectId: PROJECT, sessionId: odd, agentId: CHILD });
  });

  test('the class is cached; a stored file is placed from the lookup without reading anything', async () => {
    await writeSession(abs(sessionRel(SID)), headerLine());
    const s = new DeepSeekFileSource(home);
    expect(await s.classify(key(sessionRel(SID)))).toEqual({ kind: 'session', projectId: PROJECT, sessionId: SID });
    await fs.rm(abs(sessionRel(SID)));
    expect(await s.classify(key(sessionRel(SID)))).toEqual({ kind: 'session', projectId: PROJECT, sessionId: SID });

    const lookup: DeepSeekLookup = {
      storedFile: (k) => (k === key(sessionRel(CHILD)) ? { sessionId: SID, agentId: CHILD, projectId: PROJECT } : null),
      knownProjectIds: () => [],
    };
    const fresh = new DeepSeekFileSource(home, lookup);
    // No file on disk: the stored owner answers.
    expect(fresh.classify(key(sessionRel(CHILD)))).toEqual({ kind: 'agent', projectId: PROJECT, sessionId: SID, agentId: CHILD });
  });

  test('project ids reuse a known one that differs only in letter case', async () => {
    await writeSession(abs(sessionRel(SID, 'd:\\projects\\demo')), headerLine({ cwd: 'd:\\projects\\demo' }));
    const s = new DeepSeekFileSource(home, { storedFile: () => null, knownProjectIds: () => [PROJECT] });
    expect(await s.classify(key(sessionRel(SID, 'd:\\projects\\demo')))).toEqual({ kind: 'session', projectId: PROJECT, sessionId: SID });
  });
});

describe('fileSources: the DeepSeek source', () => {
  const configFor = (deepseekDir: string | null) =>
    loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, cursorDbPath: null, geminiDir: null, grokDir: null, copilotDir: null, deepseekDir, workbuddyDirs: [], codebuddyDir: null, doubaoDirs: [] });

  test('created when <home>/sessions exists and zstd is available', () => {
    const sources = fileSources(configFor(home), undefined, { zstd: true });
    const ds = sources.find((s) => s.origin === 'deepseek');
    expect(ds).toBeInstanceOf(DeepSeekFileSource);
    expect(ds!.rootDir).toBe(root);
  });

  test('not created without zstd, without a sessions directory, or when disabled; nothing created', async () => {
    expect(fileSources(configFor(home), undefined, { zstd: false }).map((s) => s.origin)).not.toContain('deepseek');
    expect(fileSources(configFor(null), undefined, { zstd: true }).map((s) => s.origin)).not.toContain('deepseek');
    const empty = path.join(tmp, 'empty-home');
    await fs.mkdir(empty);
    expect(fileSources(configFor(empty), undefined, { zstd: true }).map((s) => s.origin)).not.toContain('deepseek');
    await expect(fs.stat(path.join(empty, 'sessions'))).rejects.toThrow();
  });

  test('by default it follows this Node', () => {
    expect(fileSources(configFor(home)).some((s) => s.origin === 'deepseek')).toBe(HAS_ZSTD);
  });
});

describe.skipIf(!HAS_ZSTD)('through the pipeline (no DeepSeek normaliser yet: raw lines stored only)', () => {
  test('lines stored by ordinal under the root session; appends go on; a rewrite stores a new generation', async () => {
    const config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, cursorDbPath: null, geminiDir: null, grokDir: null, copilotDir: null, deepseekDir: home, workbuddyDirs: [], codebuddyDir: null, doubaoDirs: [] });
    const store = openStore(':memory:');
    const pipeline = new Pipeline(store, config, { sources: fileSources(config, store, { zstd: true }) });
    try {
      const main = abs(sessionRel(SID));
      await writeSession(main, headerLine(), [events(0, 2)]);
      await writeSession(abs(sessionRel(CHILD)), headerLine({ id: CHILD, parent: SID, origin: 'subagent' }), [events(0, 1)]);
      await pipeline.scanAll();
      await pipeline.idle();
      const stored = () =>
        store.rawForSession(SID).flatMap((e) => (e.source === 'transcript' ? [[e.file, e.agentId, e.offset, e.line] as const] : []));
      expect(stored()).toEqual([
        [key(sessionRel(SID)), null, 0, headerLine()],
        [key(sessionRel(SID)), null, 1, events(0, 2)[0]],
        [key(sessionRel(SID)), null, 2, events(0, 2)[1]],
        [key(sessionRel(CHILD)), CHILD, 0, headerLine({ id: CHILD, parent: SID, origin: 'subagent' })],
        [key(sessionRel(CHILD)), CHILD, 1, events(0, 1)[0]],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0])) || (a[2] as number) - (b[2] as number)));
      await appendBatch(main, events(2, 1));
      await pipeline.ingestFile(main);
      await pipeline.idle();
      expect(stored().filter((r) => r[0] === key(sessionRel(SID))).map((r) => r[2])).toEqual([0, 1, 2, 3]);
      // Rewritten shorter (an append rolled back): generation 1, the file stored again from ordinal 0.
      await writeSession(main, headerLine(), [events(0, 1)]);
      await pipeline.ingestFile(main);
      await pipeline.idle();
      expect(store.getMeta(`${LINE_GENERATION_PREFIX}${key(sessionRel(SID))}`)).toBe('1');
      expect(stored().filter((r) => r[0] === key(sessionRel(SID))).map((r) => r[2])).toEqual([0, 1, 2, 3, 0, 1]);
    } finally {
      await pipeline.close();
      await pipeline.idle();
      store.close();
    }
  });
});
