import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Origin } from '@agent-canvas/shared';
import { loadConfig, type Config } from '../src/config.js';
import { NORMALIZER_FACTORIES, type NormalizerFactories } from '../src/normalize/registry.js';
import type { AgentNormalizer, NormalizeResult } from '../src/normalize/types.js';
import { LINE_GENERATION_PREFIX, Pipeline, READER_STATE_PREFIX } from '../src/pipeline.js';
import { KEY_PREFIXES, type FileClass, type FileSource, type SourceRead } from '../src/sources/source.js';
import { startWatcher, watchRootsOf } from '../src/sources/transcript/watcher.js';
import { openStore, transcriptLineHash, type RawEvent, type Store } from '../src/store/store.js';

// Task 2 of plan more-sources-cn: a source may decode its own container into lines (readLines, with an opaque reader
// state persisted with the offset) and may watch several roots (watchRoots). Sources that define neither take the
// exact existing path.

const sha1 = (b: Buffer | string): string => createHash('sha1').update(b).digest('hex');
const RS = 0x1e;

/** Records every event a normalizer is given (no derived output). */
class Recorder implements AgentNormalizer {
  readonly applied: RawEvent[] = [];
  apply(event: RawEvent): NormalizeResult {
    this.applied.push(event);
    return { changes: [] };
  }
  dropSession(): void {}
  needsPreSessionReplay(): boolean {
    return false;
  }
  restorePreSession(): void {}
  hasSession(): boolean {
    return false;
  }
  sessionCount(): number {
    return 0;
  }
  toolInputCount(): number {
    return 0;
  }
}

interface Call {
  from: number;
  state: string | null;
}

/**
 * Files directly inside one of `roots`, keyed `<prefix><root index>/<name>`, each its own session `<origin>-<name>`.
 * With `container`, the files are not JSONL but records ended by 0x1E; readLines decodes them, gives each record its
 * sequence number as offset, and keeps `{seq, sum}` (SHA-1 of the bytes read) as its state: a mismatch is a rewrite.
 */
class FakeSource implements FileSource {
  readonly rootDir: string;
  readonly watchDepth = 0;
  readonly lineIdentity?: 'content' | 'offset';
  readonly watchRoots?: readonly { dir: string; depth: number }[];
  readLines?: (absPath: string, fromOffset: number, maxBytes: number, state: string | null) => Promise<SourceRead>;
  readonly calls: Call[] = [];
  private readonly prefix: string;
  /** Records decoded per readLines call at most (a stand-in for the byte budget). */
  private readonly perCall: number;

  constructor(
    readonly origin: Origin,
    private readonly roots: string[],
    opts: { lineIdentity?: 'content' | 'offset'; container?: boolean; watchRoots?: boolean; perCall?: number } = {},
  ) {
    this.perCall = opts.perCall ?? Infinity;
    this.rootDir = roots[0]!;
    this.prefix = KEY_PREFIXES[origin];
    if (opts.lineIdentity !== undefined) this.lineIdentity = opts.lineIdentity;
    if (opts.watchRoots) this.watchRoots = roots.map((dir) => ({ dir, depth: 0 }));
    if (opts.container) this.readLines = (a, f, m, s) => this.decode(a, f, m, s);
  }

  private async decode(absPath: string, from: number, _max: number, state: string | null): Promise<SourceRead> {
    this.calls.push({ from, state });
    let buf: Buffer;
    try {
      buf = await fs.readFile(absPath);
    } catch {
      return { lines: [], newOffset: 0, truncated: false };
    }
    const st = state === null ? null : (JSON.parse(state) as { seq: number; sum: string });
    const truncated = buf.length < from || (st !== null && sha1(buf.subarray(0, from)) !== st.sum);
    let pos = truncated ? 0 : from;
    let seq = truncated || st === null ? 0 : st.seq;
    const lines: SourceRead['lines'] = [];
    while (lines.length < this.perCall) {
      const end = buf.indexOf(RS, pos);
      if (end < 0) break;
      lines.push({ offset: seq, text: buf.toString('utf8', pos, end) });
      seq += 1;
      pos = end + 1;
    }
    if (pos === from && !truncated) return { lines, newOffset: pos, truncated };
    return { lines, newOffset: pos, truncated, state: JSON.stringify({ seq, sum: sha1(buf.subarray(0, pos)) }) };
  }

  async listFiles(): Promise<string[]> {
    const out: string[] = [];
    for (const root of this.roots) {
      try {
        for (const e of await fs.readdir(root, { withFileTypes: true })) if (e.isFile()) out.push(path.join(root, e.name));
      } catch {
        // missing root
      }
    }
    return out.sort();
  }
  keyOf(absPath: string): string | null {
    const i = this.roots.findIndex((r) => path.resolve(path.dirname(absPath)) === path.resolve(r));
    return i < 0 ? null : `${this.prefix}${i}/${path.basename(absPath)}`;
  }
  pathOf(key: string): string | null {
    if (!key.startsWith(this.prefix)) return null;
    const [i, name] = key.slice(this.prefix.length).split('/');
    const root = this.roots[Number(i)];
    return root === undefined || name === undefined ? null : path.join(root, name);
  }
  /** `<session>.title` is the title of session `<session>`, `<session>.meta` the agent_meta of its agent `ag`. */
  classify(key: string): FileClass | null {
    const p = this.pathOf(key);
    if (p === null) return null;
    if (key.endsWith('.title')) return { kind: 'title', projectId: 'p', sessionId: this.sessionOf(key.slice(0, -'.title'.length)) };
    if (key.endsWith('.meta')) return { kind: 'agent_meta', projectId: 'p', sessionId: this.sessionOf(key.slice(0, -'.meta'.length)), agentId: 'ag' };
    return { kind: 'session', projectId: 'p', sessionId: this.sessionOf(key) };
  }
  sessionOf(key: string): string {
    return `${this.origin}-${key.slice(this.prefix.length).replace('/', '-')}`;
  }
  projectOfKey(): string | null {
    return null;
  }
  projectOfTranscript(): string | null {
    return null;
  }
  mainSessionOf(key: string): string | null {
    return this.pathOf(key) === null ? null : this.sessionOf(key);
  }
}

let tmp: string;
let config: Config;
let dbFile: string;
let store: Store;
let recorders: Partial<Record<Origin, Recorder>>;
let normalizers: NormalizerFactories;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-reader-ext-'));
  config = loadConfig(
    {},
    {
      projectsDir: path.join(tmp, 'projects'),
      dataDir: path.join(tmp, 'data'),
      codexSessionsDir: null,
      cursorDbPath: null,
      geminiDir: null,
      grokDir: null,
      copilotDir: null,
      deepseekDir: null,
      workbuddyDirs: [],
      codebuddyDir: null,
      doubaoDirs: [], qwenDir: null,
    },
  );
  dbFile = path.join(tmp, 'store.sqlite');
  store = openStore(dbFile);
  recorders = { deepseek: new Recorder(), workbuddy: new Recorder(), codebuddy: new Recorder() };
  normalizers = { ...NORMALIZER_FACTORIES, deepseek: () => recorders.deepseek!, workbuddy: () => recorders.workbuddy!, codebuddy: () => recorders.codebuddy! };
});
afterEach(async () => {
  store.close();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

async function mkroot(name: string): Promise<string> {
  const dir = path.join(tmp, name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
const records = (...texts: string[]): Buffer => Buffer.concat(texts.map((t) => Buffer.concat([Buffer.from(t), Buffer.from([RS])])));
/** Sets a file's mtime well away from its current one (a rewrite in the same clock tick is not what is tested). */
async function bumpMtime(file: string, seconds: number): Promise<void> {
  const st = await fs.stat(file);
  const t = new Date(st.mtimeMs + seconds * 1000);
  await fs.utimes(file, t, t);
}

interface RawRow {
  source: string;
  origin: string;
  file: string;
  offset: number | null;
  line_hash: string | null;
  record_type: string | null;
  session_id: string | null;
  agent_id: string | null;
  project_id: string | null;
}
function rawRows(): RawRow[] {
  const db = new Database(dbFile, { readonly: true });
  try {
    return db
      .prepare(`SELECT source, origin, file, "offset", line_hash, record_type, session_id, agent_id, project_id FROM raw_event ORDER BY ingest_id`)
      .all() as RawRow[];
  } finally {
    db.close();
  }
}
function offsetRows(): { file: string; offset: number; size: number }[] {
  const db = new Database(dbFile, { readonly: true });
  try {
    return db.prepare(`SELECT file, "offset", size FROM file_offset ORDER BY file`).all() as { file: string; offset: number; size: number }[];
  } finally {
    db.close();
  }
}
const lineTexts = (sessionId: string): [number, string][] =>
  store.rawForSession(sessionId).flatMap((e) => (e.source === 'transcript' ? [[e.offset, e.line] as [number, string]] : []));

describe('readLines: lines decoded by the source', () => {
  test('lines from readLines are stored and applied; the state is persisted with the offset', async () => {
    const root = await mkroot('ds');
    const src = new FakeSource('deepseek', [root], { lineIdentity: 'offset', container: true });
    const file = path.join(root, 'a.zst');
    const content = records('{"type":"one"}', '{"type":"two"}', '{"type":"three"}');
    await fs.writeFile(file, Buffer.concat([content, Buffer.from('{"type":"partial"')]));
    const p = new Pipeline(store, config, { sources: [src], normalizers });
    await p.scanAll();
    await p.idle();

    const sid = 'deepseek-0-a.zst';
    expect(lineTexts(sid)).toEqual([
      [0, '{"type":"one"}'],
      [1, '{"type":"two"}'],
      [2, '{"type":"three"}'],
    ]);
    expect(store.rawForSession(sid).map((e) => (e.source === 'transcript' ? e.recordType : null))).toEqual(['one', 'two', 'three']);
    expect(recorders.deepseek!.applied.map((e) => (e.source === 'transcript' ? e.line : null))).toEqual(['{"type":"one"}', '{"type":"two"}', '{"type":"three"}']);
    expect(store.getOffset('deepseek:0/a.zst')).toBe(content.length);
    expect(JSON.parse(store.getMeta(`${READER_STATE_PREFIX}deepseek:0/a.zst`)!)).toEqual({ seq: 3, sum: sha1(content) });
    // The first read of a file gets offset 0 and state null.
    expect(src.calls[0]).toEqual({ from: 0, state: null });
    expect(p.ingestFailures()).toEqual([]);
  });

  test('the state round-trips across a new Pipeline on the same store', async () => {
    const root = await mkroot('ds');
    const file = path.join(root, 'a.zst');
    await fs.writeFile(file, records('{"type":"one"}', '{"type":"two"}'));
    const src1 = new FakeSource('deepseek', [root], { lineIdentity: 'offset', container: true });
    const p1 = new Pipeline(store, config, { sources: [src1], normalizers });
    await p1.scanAll();
    await p1.idle();
    await p1.close();
    const stored = store.getMeta(`${READER_STATE_PREFIX}deepseek:0/a.zst`);
    const offset = store.getOffset('deepseek:0/a.zst');
    expect(stored).not.toBeNull();

    await fs.appendFile(file, records('{"type":"three"}'));
    const src2 = new FakeSource('deepseek', [root], { lineIdentity: 'offset', container: true });
    const p2 = new Pipeline(store, config, { sources: [src2], normalizers });
    await p2.scanAll();
    await p2.idle();
    expect(src2.calls[0]).toEqual({ from: offset, state: stored });
    expect(lineTexts('deepseek-0-a.zst')).toEqual([
      [0, '{"type":"one"}'],
      [1, '{"type":"two"}'],
      [2, '{"type":"three"}'],
    ]);
    expect(JSON.parse(store.getMeta(`${READER_STATE_PREFIX}deepseek:0/a.zst`)!).seq).toBe(3);
    await p2.close();
  });

  test('truncated: true bumps the generation and every line is stored again', async () => {
    const root = await mkroot('ds');
    const file = path.join(root, 'a.zst');
    await fs.writeFile(file, records('{"type":"one"}', '{"type":"two"}', '{"type":"three"}'));
    const src = new FakeSource('deepseek', [root], { lineIdentity: 'offset', container: true });
    const p = new Pipeline(store, config, { sources: [src], normalizers });
    await p.scanAll();
    await p.idle();
    expect(store.getMeta(`${LINE_GENERATION_PREFIX}deepseek:0/a.zst`)).toBeNull();

    // Torn tail rolled back and re-appended: shorter than what was read.
    const shorter = records('{"type":"one"}', '{"type":"2"}');
    await fs.writeFile(file, shorter);
    await p.scanAll();
    await p.idle();
    expect(store.getMeta(`${LINE_GENERATION_PREFIX}deepseek:0/a.zst`)).toBe('1');
    expect(lineTexts('deepseek-0-a.zst')).toEqual([
      [0, '{"type":"one"}'],
      [1, '{"type":"two"}'],
      [2, '{"type":"three"}'],
      [0, '{"type":"one"}'],
      [1, '{"type":"2"}'],
    ]);
    expect(store.getOffset('deepseek:0/a.zst')).toBe(shorter.length);
    expect(JSON.parse(store.getMeta(`${READER_STATE_PREFIX}deepseek:0/a.zst`)!)).toEqual({ seq: 2, sum: sha1(shorter) });
  });

  test('a rewrite that leaves the size unchanged reaches the reader on the next scan and is re-read', async () => {
    const root = await mkroot('ds');
    const file = path.join(root, 'a.zst');
    const first = records('{"type":"aaa"}', '{"type":"bbb"}');
    await fs.writeFile(file, first);
    const src = new FakeSource('deepseek', [root], { lineIdentity: 'offset', container: true });
    const p = new Pipeline(store, config, { sources: [src], normalizers });
    await p.scanAll();
    await p.idle();
    const callsAfterFirst = src.calls.length;

    // Nothing changed: the scans do not call the reader again.
    await p.scanAll();
    await p.rescan();
    await p.idle();
    expect(src.calls.length).toBe(callsAfterFirst);

    const second = records('{"type":"aaa"}', '{"type":"ccc"}');
    expect(second.length).toBe(first.length);
    await fs.writeFile(file, second);
    await bumpMtime(file, 5);
    await p.scanAll();
    await p.idle();
    expect(store.getMeta(`${LINE_GENERATION_PREFIX}deepseek:0/a.zst`)).toBe('1');
    expect(lineTexts('deepseek-0-a.zst').slice(2)).toEqual([
      [0, '{"type":"aaa"}'],
      [1, '{"type":"ccc"}'],
    ]);

    // After a restart the modification time last seen is not known: each such file is read once more, then skipped.
    await p.close();
    const src2 = new FakeSource('deepseek', [root], { lineIdentity: 'offset', container: true });
    const p2 = new Pipeline(store, config, { sources: [src2], normalizers });
    await p2.scanAll();
    await p2.idle();
    expect(src2.calls).toHaveLength(1);
    await p2.scanAll();
    await p2.rescan();
    await p2.idle();
    expect(src2.calls).toHaveLength(1);
    expect(lineTexts('deepseek-0-a.zst')).toHaveLength(4);
    await p2.close();
  });

  test('a reader that returns no state leaves the stored one as is; null removes it', async () => {
    const root = await mkroot('ds');
    const file = path.join(root, 'a.zst');
    await fs.writeFile(file, records('{"type":"one"}'));
    const src = new FakeSource('deepseek', [root], { lineIdentity: 'offset', container: true });
    const p = new Pipeline(store, config, { sources: [src], normalizers });
    await p.scanAll();
    await p.idle();
    const key = `${READER_STATE_PREFIX}deepseek:0/a.zst`;
    const kept = store.getMeta(key);
    expect(kept).not.toBeNull();

    await fs.appendFile(file, records('{"type":"two"}'));
    const size1 = (await fs.stat(file)).size;
    src.readLines = async (_a, from) =>
      from >= size1 ? { lines: [], newOffset: from, truncated: false } : { lines: [{ offset: 1, text: '{"type":"two"}' }], newOffset: size1, truncated: false };
    await p.ingestFile(file);
    await p.idle();
    expect(store.getMeta(key)).toBe(kept);
    expect(lineTexts('deepseek-0-a.zst').map(([, t]) => t)).toEqual(['{"type":"one"}', '{"type":"two"}']);

    await fs.appendFile(file, 'x');
    const size2 = (await fs.stat(file)).size;
    src.readLines = async (_a, from) => (from >= size2 ? { lines: [], newOffset: from, truncated: false } : { lines: [], newOffset: size2, truncated: false, state: null });
    await p.ingestFile(file);
    await p.idle();
    expect(store.getMeta(key)).toBeNull();
    expect(store.getOffset('deepseek:0/a.zst')).toBe((await fs.stat(file)).size);
  });
});

describe('readLines: review fix round 1', () => {
  test('title and agent_meta files of a readLines source are judged by size only: unchanged scans read and write nothing', async () => {
    const root = await mkroot('ds');
    await fs.writeFile(path.join(root, 'a.zst'), records('{"type":"one"}'));
    await fs.writeFile(path.join(root, 'a.zst.title'), '{"title":"T"}');
    await fs.writeFile(path.join(root, 'a.zst.meta'), '{"agentType":"x"}');
    const src = new FakeSource('deepseek', [root], { lineIdentity: 'offset', container: true });
    const p = new Pipeline(store, config, { sources: [src], normalizers });
    await p.scanAll();
    await p.idle();
    const sid = 'deepseek-0-a.zst';
    expect(store.rawForSession(sid).map((e) => e.source)).toEqual(expect.arrayContaining(['transcript', 'meta', 'meta']));
    const rows = rawRows().length;

    const latestMeta = vi.spyOn(store, 'latestMeta');
    const setOffset = vi.spyOn(store, 'setOffset');
    const insertRaw = vi.spyOn(store, 'insertRaw');
    const readFile = vi.spyOn(fs, 'readFile');
    const calls = src.calls.length;
    for (let i = 0; i < 3; i++) {
      await p.scanAll();
      await p.rescan();
      await p.idle();
    }
    expect(latestMeta).not.toHaveBeenCalled();
    expect(setOffset).not.toHaveBeenCalled();
    expect(insertRaw).not.toHaveBeenCalled();
    expect(readFile.mock.calls.filter(([f]) => String(f).endsWith('.title') || String(f).endsWith('.meta'))).toEqual([]);
    expect(src.calls.length).toBe(calls);
    expect(rawRows()).toHaveLength(rows);
    readFile.mockRestore();
    await p.close();
  });

  test('at most one restart per ingest: a second truncated read in the same call is discarded and left for the next scan', async () => {
    const root = await mkroot('ds');
    const file = path.join(root, 'a.zst');
    await fs.writeFile(file, records('{"type":"one"}', '{"type":"two"}'));
    const src = new FakeSource('deepseek', [root], { lineIdentity: 'offset', container: true });
    const p = new Pipeline(store, config, { sources: [src], normalizers });
    await p.scanAll();
    await p.idle();
    const key = 'deepseek:0/a.zst';

    // A reader whose file keeps being rewritten: every read reports a truncation and returns one record from the start.
    let n = 0;
    const always: NonNullable<FakeSource['readLines']> = async () => {
      n += 1;
      return { lines: [{ offset: 0, text: `{"type":"r${n}"}` }], newOffset: 15, truncated: true, state: `s${n}` };
    };
    src.readLines = always;
    await p.ingestFile(file);
    await p.idle();
    expect(n).toBe(2); // the second truncation ends the call
    expect(store.getMeta(`${LINE_GENERATION_PREFIX}${key}`)).toBe('1');
    expect(lineTexts('deepseek-0-a.zst').map(([, t]) => t)).toEqual(['{"type":"one"}', '{"type":"two"}', '{"type":"r1"}']);
    expect(store.getMeta(`${READER_STATE_PREFIX}${key}`)).toBe('s1');
    expect(store.getOffset(key)).toBe(15);

    // The next scan comes back to the file (once more: one restart, then stop).
    await p.scanAll();
    await p.idle();
    expect(n).toBe(4);
    expect(store.getMeta(`${LINE_GENERATION_PREFIX}${key}`)).toBe('2');
    expect(lineTexts('deepseek-0-a.zst').map(([, t]) => t)).toEqual(['{"type":"one"}', '{"type":"two"}', '{"type":"r1"}', '{"type":"r3"}']);
    await p.close();
  });

  test('a truncated read that ends at the old offset goes on reading the rest of the file in the same call', async () => {
    const root = await mkroot('ds');
    const file = path.join(root, 'a.zst');
    const first = records('{"type":"aaaa"}', '{"type":"bbbb"}');
    await fs.writeFile(file, first);
    const src = new FakeSource('deepseek', [root], { lineIdentity: 'offset', container: true, perCall: 2 });
    const p = new Pipeline(store, config, { sources: [src], normalizers });
    await p.ingestFile(file);
    await p.idle();
    const key = 'deepseek:0/a.zst';
    expect(store.getOffset(key)).toBe(first.length);

    // Rewritten: the first two records end exactly at the old offset, a third follows.
    const head = records('{"type":"cccc"}', '{"type":"dddd"}');
    expect(head.length).toBe(first.length);
    await fs.writeFile(file, Buffer.concat([head, records('{"type":"eeee"}')]));
    await p.ingestFile(file);
    await p.idle();
    expect(store.getMeta(`${LINE_GENERATION_PREFIX}${key}`)).toBe('1');
    expect(lineTexts('deepseek-0-a.zst').slice(2)).toEqual([
      [0, '{"type":"cccc"}'],
      [1, '{"type":"dddd"}'],
      [2, '{"type":"eeee"}'],
    ]);
    expect(store.getOffset(key)).toBe((await fs.stat(file)).size);
    await p.close();
  });

  test('the modification time last seen is forgotten when the file is gone', async () => {
    const root = await mkroot('ds');
    const a = path.join(root, 'a.zst');
    const b = path.join(root, 'b.zst');
    await fs.writeFile(a, records('{"type":"one"}'));
    await fs.writeFile(b, records('{"type":"one"}'));
    const src = new FakeSource('deepseek', [root], { lineIdentity: 'offset', container: true });
    const p = new Pipeline(store, config, { sources: [src], normalizers });
    await p.scanAll();
    await p.idle();
    const mtimes = (p as unknown as { readMtimes: Map<string, number> }).readMtimes;
    expect([...mtimes.keys()].sort()).toEqual(['deepseek:0/a.zst', 'deepseek:0/b.zst']);
    await fs.rm(a);
    await p.scanAll();
    await p.idle();
    expect([...mtimes.keys()]).toEqual(['deepseek:0/b.zst']);
    await fs.rm(b);
    await p.ingestFile(b);
    await p.idle();
    expect(mtimes.size).toBe(0);
    await p.close();
  });
});

describe('sources without readLines: the exact existing path', () => {
  // Fixture: CRLF, a blank line, a repeated line, a partial last line; then the partial line completed plus one more;
  // then a shorter rewrite; then a rewrite of the same size.
  const step1 = '{"type":"a"}\r\n\n{"type":"b"}\n{"type":"a"}\n{"type":"c"';
  const step2 = '}\n{"type":"d"}\n';
  const step3 = '{"type":"a"}\n';
  const step4 = '{"type":"z"}\n';

  async function drive(src: FakeSource, file: string): Promise<void> {
    const p = new Pipeline(store, config, { sources: [src], normalizers });
    await fs.writeFile(file, step1);
    await p.scanAll();
    await p.idle();
    await fs.appendFile(file, step2);
    await p.scanAll();
    await p.idle();
    await fs.writeFile(file, step3);
    await p.scanAll();
    await p.idle();
    await fs.writeFile(file, step4);
    await bumpMtime(file, 5);
    await p.scanAll();
    await p.rescan();
    await p.idle();
    await p.close();
  }
  const row = (origin: string, file: string, sessionId: string, offset: number, type: string, hash: string): RawRow => ({
    source: 'transcript',
    origin,
    file,
    offset,
    line_hash: hash,
    record_type: type,
    session_id: sessionId,
    agent_id: null,
    project_id: 'p',
  });
  const line = (t: string): string => `{"type":"${t}"}`;

  test("lineIdentity 'offset': raw rows, offsets and meta are those written before this change", async () => {
    const root = await mkroot('wb');
    const src = new FakeSource('workbuddy', [root], { lineIdentity: 'offset' });
    expect('readLines' in src && src.readLines !== undefined).toBe(false);
    const file = path.join(root, 'f.jsonl');
    await drive(src, file);
    const k = 'workbuddy:0/f.jsonl';
    const s = 'workbuddy-0-f.jsonl';
    expect(rawRows()).toEqual([
      row('workbuddy', k, s, 0, 'a', transcriptLineHash(line('a'), '0:0')),
      row('workbuddy', k, s, 15, 'b', transcriptLineHash(line('b'), '0:15')),
      row('workbuddy', k, s, 28, 'a', transcriptLineHash(line('a'), '0:28')),
      row('workbuddy', k, s, 41, 'c', transcriptLineHash(line('c'), '0:41')),
      row('workbuddy', k, s, 54, 'd', transcriptLineHash(line('d'), '0:54')),
      row('workbuddy', k, s, 0, 'a', transcriptLineHash(line('a'), '1:0')),
    ]);
    // The same-size rewrite is not noticed (size-only change detection, as before).
    expect(offsetRows()).toEqual([{ file: k, offset: 13, size: 13 }]);
    expect(store.getMeta(`${LINE_GENERATION_PREFIX}${k}`)).toBe('1');
    expect(store.metaWithPrefix(READER_STATE_PREFIX)).toEqual([]);
    expect(recorders.workbuddy!.applied.map((e) => (e.source === 'transcript' ? e.offset : null))).toEqual([0, 15, 28, 41, 54, 0]);
  });

  test("lineIdentity 'content' (default): raw rows, offsets and meta are those written before this change", async () => {
    const root = await mkroot('cb');
    const src = new FakeSource('codebuddy', [root]);
    const file = path.join(root, 'f.jsonl');
    await drive(src, file);
    const k = 'codebuddy:0/f.jsonl';
    const s = 'codebuddy-0-f.jsonl';
    expect(rawRows()).toEqual([
      row('codebuddy', k, s, 0, 'a', transcriptLineHash(line('a'))),
      row('codebuddy', k, s, 15, 'b', transcriptLineHash(line('b'))),
      row('codebuddy', k, s, 41, 'c', transcriptLineHash(line('c'))),
      row('codebuddy', k, s, 54, 'd', transcriptLineHash(line('d'))),
    ]);
    expect(offsetRows()).toEqual([{ file: k, offset: 13, size: 13 }]);
    expect(store.getMeta(`${LINE_GENERATION_PREFIX}${k}`)).toBeNull();
    expect(store.metaWithPrefix(READER_STATE_PREFIX)).toEqual([]);
  });
});

describe('watchRoots', () => {
  test('every watchRoots entry is watched; rootDir/watchDepth only when there is none', async () => {
    const a = await mkroot('a');
    const b = await mkroot('b');
    expect(watchRootsOf(new FakeSource('workbuddy', [a, b], { watchRoots: true }))).toEqual([
      { dir: a, depth: 0 },
      { dir: b, depth: 0 },
    ]);
    expect(watchRootsOf(new FakeSource('workbuddy', [a, b]))).toEqual([{ dir: a, depth: 0 }]);
  });

  test('the watcher picks up new files in each root', async () => {
    const a = await mkroot('a');
    const b = await mkroot('b');
    const src = new FakeSource('workbuddy', [a, b], { watchRoots: true });
    const p = new Pipeline(store, config, { sources: [src], normalizers });
    const w = startWatcher(p, { ...config, rescanMs: 60_000, fullScanMs: 60_000 });
    try {
      await w.ready;
      await fs.writeFile(path.join(a, 'x.jsonl'), '{"type":"x"}\n');
      await fs.writeFile(path.join(b, 'y.jsonl'), '{"type":"y"}\n');
      await vi.waitFor(
        () => {
          expect(lineTexts('workbuddy-0-x.jsonl')).toEqual([[0, '{"type":"x"}']]);
          expect(lineTexts('workbuddy-1-y.jsonl')).toEqual([[0, '{"type":"y"}']]);
        },
        { timeout: 5000 },
      );
    } finally {
      await w.close();
      await p.close();
    }
  });
});
