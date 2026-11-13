import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GraphSnapshot } from '@agent-canvas/shared';
import { rebuildReason } from '../src/cli.js';
import { loadConfig, type Config } from '../src/config.js';
import { NORMALIZER_VERSION } from '../src/normalize/version.js';
import { Pipeline } from '../src/pipeline.js';
import { ClaudeFileSource } from '../src/sources/claude.js';
import { KEY_PREFIXES, originOfKey, type FileClass, type FileSource } from '../src/sources/source.js';
import { classifyRelPath, relPath } from '../src/sources/transcript/paths.js';
import { startWatcher } from '../src/sources/transcript/watcher.js';
import { decodeBody } from '../src/store/codec.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';
import { assistantBlock, toolResult, userPrompt } from './fixtures.js';
import { SCHEMA_SQL_V13 } from './schema-v13.js';

const linesOf = (events: RawEvent[]): string => events.map((e) => (e.source === 'transcript' ? e.line : '') + '\n').join('');

/**
 * A stand-in for a second origin's source (the real Codex source comes later): `<root>/<dir>/<thread>.jsonl` whose first
 * line `{"meta":{session,thread,parent,project}}` says which session the file belongs to, so classification must read
 * the file (asynchronously). Keys are `codex:` + the path relative to the root.
 */
class ThreadFileSource implements FileSource {
  readonly origin = 'codex' as const;
  readonly watchDepth = 2;
  readonly mains = new Map<string, string>();
  classifyCalls = 0;
  constructor(readonly rootDir: string) {}
  async listFiles(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.rootDir, { recursive: true });
    } catch {
      return [];
    }
    return entries.filter((e) => e.endsWith('.jsonl')).map((e) => path.join(this.rootDir, e)).sort();
  }
  keyOf(absPath: string): string | null {
    const rel = relPath(this.rootDir, absPath);
    return rel === null || !rel.endsWith('.jsonl') ? null : `codex:${rel}`;
  }
  pathOf(key: string): string | null {
    return key.startsWith('codex:') ? path.join(this.rootDir, ...key.slice('codex:'.length).split('/')) : null;
  }
  async classify(key: string): Promise<FileClass | null> {
    this.classifyCalls += 1;
    const abs = this.pathOf(key);
    if (abs === null) return null;
    let first: string;
    try {
      const text = await fs.readFile(abs, 'utf8');
      const nl = text.indexOf('\n');
      if (nl < 0) return null;
      first = text.slice(0, nl);
    } catch {
      return null;
    }
    const meta = (JSON.parse(first) as { meta: { session: string; thread: string; parent: string | null; project: string } }).meta;
    if (meta.parent === null) {
      this.mains.set(key, meta.session);
      return { kind: 'session', projectId: meta.project, sessionId: meta.session };
    }
    return { kind: 'agent', projectId: meta.project, sessionId: meta.session, agentId: meta.thread };
  }
  projectOfKey(): string | null {
    return null;
  }
  projectOfTranscript(): string | null {
    return null;
  }
  mainSessionOf(key: string): string | null {
    return this.mains.get(key) ?? null;
  }
}

describe('ClaudeFileSource', () => {
  const root = path.join(os.tmpdir(), 'cc-claude-source-root');
  const src = new ClaudeFileSource(root);

  test('origin、根目录、监视深度', () => {
    expect([src.origin, src.rootDir, src.watchDepth]).toEqual(['claude', root, 3]);
  });

  test('键属于哪个来源由前缀决定：Claude 的键不带前缀，Codex 的键以 codex: 开头', () => {
    expect(KEY_PREFIXES).toEqual({ claude: '', codex: 'codex:', cursor: 'cursor:' });
    expect(originOfKey('proj/abc.jsonl')).toBe('claude');
    expect(originOfKey('codex:2026/11/11/rollout-x.jsonl')).toBe('codex');
  });

  test.each([
    'proj/abc.jsonl',
    'proj/abc/subagents/agent-a1.jsonl',
    'proj/abc/subagents/agent-a1.meta.json',
    'proj/abc/custom-title.json',
    'proj/abc/subagents/agent-a1.prefix.json',
    'proj/abc/tool-results/x.jpg',
    'proj/sub dir/abc.jsonl',
  ])('与原有路径规则逐字一致：%s', (rel) => {
    const abs = path.join(root, ...rel.split('/'));
    const key = src.keyOf(abs);
    expect(key).toBe(relPath(root, abs));
    const cls = src.classify(key!);
    expect(cls).not.toBeInstanceOf(Promise); // the Claude source classifies synchronously
    expect(cls).toEqual(classifyRelPath(key!));
    const expected = classifyRelPath(key!);
    expect(src.projectOfKey(key!)).toBe(expected?.projectId ?? null);
    expect(src.mainSessionOf(key!)).toBe(expected?.kind === 'session' ? expected.sessionId : null);
    expect(src.projectOfTranscript(abs)).toBe(expected?.kind === 'session' || expected?.kind === 'agent' ? expected.projectId : null);
    expect(src.pathOf(key!)).toBe(abs);
  });

  test('根目录之外的路径没有键', () => {
    expect(src.keyOf(path.join(os.tmpdir(), 'elsewhere', 'x.jsonl'))).toBeNull();
    expect(src.keyOf(root)).toBeNull();
    expect(src.projectOfTranscript(path.join(os.tmpdir(), 'elsewhere', 'p', 'x.jsonl'))).toBeNull();
  });
});

describe('pipeline 与来源', () => {
  let tmp: string;
  let store: Store;
  let config: Config;
  let codexDir: string;

  const abs = (rel: string): string => path.join(config.projectsDir, ...rel.split('/'));
  const cabs = (rel: string): string => path.join(codexDir, ...rel.split('/'));
  async function writeAt(file: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  const threadMeta = (session: string, thread: string, parent: string | null, project = 'D--work-app'): string =>
    JSON.stringify({ meta: { session, thread, parent, project } }) + '\n';

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-pipeline-origin-'));
    config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, cursorDbPath: null });
    codexDir = path.join(tmp, 'codex');
    await fs.mkdir(config.projectsDir, { recursive: true });
    await fs.mkdir(codexDir, { recursive: true });
    store = openStore(':memory:');
  });
  afterEach(async () => {
    store.close();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
  });

  test('Claude 会话带 origin claude；项目列出来源', async () => {
    const p = new Pipeline(store, config);
    await writeAt(abs('proj/s1.jsonl'), linesOf([userPrompt('u1', null, 'x')]));
    await p.ingestFile(abs('proj/s1.jsonl'));
    expect(store.getSession('s1')!.origin).toBe('claude');
    expect(store.listProjects(Date.now())).toEqual([expect.objectContaining({ id: 'proj', origins: ['claude'] })]);
    expect(store.rawForSession('s1').map((e) => e.origin)).toEqual(['claude']);
  });

  test('显式传入的 Claude 来源列表与默认构造结果一致', async () => {
    await writeAt(abs('proj/s1.jsonl'), linesOf([userPrompt('u1', null, 'x'), assistantBlock('a1', 'u1', { type: 'text', text: 'hi' })]));
    await new Pipeline(store, config, { sources: [new ClaudeFileSource(config.projectsDir)] }).scanAll();
    const other = openStore(':memory:');
    try {
      await new Pipeline(other, config).scanAll();
      const strip = (g: GraphSnapshot) => ({ session: g.session, nodes: g.nodes, edges: g.edges });
      expect(strip(store.getGraph('s1')!)).toEqual(strip(other.getGraph('s1')!));
    } finally {
      other.close();
    }
  });

  test('hook 默认记为 claude；指定来源时原样保存并按来源计数', async () => {
    const p = new Pipeline(store, config);
    p.ingestHook('Stop', 's1', JSON.stringify({ session_id: 's1' }));
    p.ingestHook('Stop', 'c1', JSON.stringify({ session_id: 'c1' }), null, 'codex');
    await p.idle();
    expect(store.rawForSession('s1').map((e) => e.origin)).toEqual(['claude']);
    expect(store.rawForSession('c1').map((e) => e.origin)).toEqual(['codex']);
    expect(store.allHookEventStats().map((e) => [e.origin, e.eventName, e.count])).toEqual([
      ['claude', 'Stop', 1],
      ['codex', 'Stop', 1],
    ]);
    // No normalizer for codex yet: stored, nothing derived, nothing failed.
    expect(store.getSession('c1')).toBeNull();
    expect(p.ingestFailures()).toEqual([]);
  });

  test('第二个来源：异步分类、带前缀的键、事件带 origin 和 projectId；没有归一器时只存不推导', async () => {
    const codex = new ThreadFileSource(codexDir);
    const p = new Pipeline(store, config, { sources: [new ClaudeFileSource(config.projectsDir), codex] });
    await writeAt(abs('proj/s1.jsonl'), linesOf([userPrompt('u1', null, 'x')]));
    // The agent thread's file sorts before its root thread's file.
    await writeAt(cabs('a/0-child.jsonl'), threadMeta('root1', 'child', 'root1') + '{"type":"x","n":1}\n');
    await writeAt(cabs('a/1-root.jsonl'), threadMeta('root1', 'root1', null) + '{"type":"x","n":2}\n');
    await p.scanAll();
    expect(store.getSession('s1')!.origin).toBe('claude');
    expect(store.getSession('root1')).toBeNull();
    const raw = store.rawForSession('root1');
    expect(raw.map((e) => [e.source, e.origin, e.source === 'transcript' ? [e.file, e.agentId, e.projectId] : null])).toEqual([
      ['transcript', 'codex', ['codex:a/0-child.jsonl', 'child', 'D--work-app']],
      ['transcript', 'codex', ['codex:a/0-child.jsonl', 'child', 'D--work-app']],
      ['transcript', 'codex', ['codex:a/1-root.jsonl', null, 'D--work-app']],
      ['transcript', 'codex', ['codex:a/1-root.jsonl', null, 'D--work-app']],
    ]);
    // Claude transcript rows keep a null project_id (their project comes from the path, as before).
    expect(store.rawForSession('s1')[0]).toMatchObject({ origin: 'claude', projectId: null });
    expect(store.diagnostics().files.map((f) => f.path)).toEqual(['codex:a/0-child.jsonl', 'codex:a/1-root.jsonl', 'proj/s1.jsonl']);
    expect(p.ingestFailures()).toEqual([]);

    // A second full scan finds nothing new (sizes match): no re-read.
    const before = store.rawForSession('root1').length;
    await p.scanAll();
    expect(store.rawForSession('root1')).toHaveLength(before);

    // Rebuild replays both origins without error and keeps the raw log.
    p.rebuild();
    expect(store.getSession('s1')!.origin).toBe('claude');
    expect(store.rawForSession('root1')).toHaveLength(before);

    // The second source's main file disappears: no crash; the Claude session is unaffected.
    await fs.rm(cabs('a/1-root.jsonl'));
    await p.scanAll();
    expect(store.getSession('s1')!.sourceDeleted).toBe(false);
    expect(codex.mainSessionOf('codex:a/1-root.jsonl')).toBe('root1');

    // Later run with that source switched off: its recorded keys are left alone (never read as Claude paths).
    const claudeOnly = new Pipeline(store, config);
    await claudeOnly.scanAll();
    expect(store.getSession('s1')!.sourceDeleted).toBe(false);
    expect(claudeOnly.ingestFailures()).toEqual([]);
  });

  test('首行未写完的文件先不导入，写完后导入', async () => {
    const codex = new ThreadFileSource(codexDir);
    const p = new Pipeline(store, config, { sources: [new ClaudeFileSource(config.projectsDir), codex] });
    const full = threadMeta('r2', 'r2', null);
    await writeAt(cabs('b/r2.jsonl'), full.slice(0, 10));
    await p.scanAll();
    expect(store.rawForSession('r2')).toEqual([]);
    await writeAt(cabs('b/r2.jsonl'), full);
    await p.ingestFile(cabs('b/r2.jsonl'));
    expect(store.rawForSession('r2')).toHaveLength(1);
  });

  test('startWatcher 监视每个来源的目录', async () => {
    const codex = new ThreadFileSource(codexDir);
    const p = new Pipeline(store, config, { sources: [new ClaudeFileSource(config.projectsDir), codex] });
    const w = startWatcher(p, { ...config, rescanMs: 50, fullScanMs: 300 });
    try {
      await w.ready;
      await writeAt(abs('proj/s9.jsonl'), linesOf([userPrompt('u1', null, 'x')]));
      await writeAt(cabs('c/r3.jsonl'), threadMeta('r3', 'r3', null));
      await vi.waitFor(
        () => {
          expect(store.getSession('s9')).not.toBeNull();
          expect(store.rawForSession('r3')).toHaveLength(1);
        },
        { timeout: 5000 },
      );
    } finally {
      await w.close();
    }
  });

  test('迁移：上一版本的数据库自动重建一次，Claude 会话与新库推导结果一致（多了 origin）', async () => {
    // The reference: the same transcripts ingested by the current code into a fresh database.
    await writeAt(
      abs('proj/s1.jsonl'),
      linesOf([
        userPrompt('u1', null, 'x'),
        assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Read', input: {} }),
        toolResult('u2', 'a1', 'tu1', 'ok'),
      ]),
    );
    await writeAt(abs('proj/s1/custom-title.json'), JSON.stringify({ customTitle: 'T' }));
    const freshFile = path.join(tmp, 'fresh.db');
    const fresh = openStore(freshFile);
    const p1 = new Pipeline(fresh, config);
    await p1.scanAll();
    p1.ingestHook('Stop', 's1', JSON.stringify({ session_id: 's1', hook_event_name: 'Stop' }));
    await p1.idle();
    const strip = (g: GraphSnapshot) => ({ session: g.session, nodes: g.nodes, edges: g.edges });
    const reference = strip(fresh.getGraph('s1')!);
    expect(reference.session.origin).toBe('claude');
    fresh.close();

    // The same data as the previous version would have stored it: old schema, no origin anywhere, version 13.
    const oldFile = path.join(tmp, 'old.db');
    const old = new Database(oldFile);
    old.exec(SCHEMA_SQL_V13);
    old.exec(`ATTACH DATABASE '${freshFile.replace(/'/g, "''")}' AS f`);
    const cols = `ingest_id, source, file, project_id, "offset", line_hash, record_type, session_id, agent_id, event_name, received_at, body`;
    // The previous version stored bodies as plain text: decode what this version stored (compressed rows, enc 1).
    old.function('decode_body', (body: unknown, enc: unknown) => decodeBody(body, Number(enc)));
    old.exec(`INSERT INTO raw_event (${cols}) SELECT ${cols.replace(/body$/, 'decode_body(body, enc)')} FROM f.raw_event ORDER BY ingest_id`);
    old.exec(`INSERT INTO file_offset SELECT * FROM f.file_offset`);
    old.exec(`INSERT INTO hook_stat (event_name, count, last_at) SELECT event_name, count, last_at FROM f.hook_stat`);
    old.exec(`INSERT INTO session (id, project_id, status, last_activity_at, body)
      SELECT id, project_id, status, last_activity_at, json_remove(body, '$.origin') FROM f.session`);
    old.exec(`INSERT INTO node SELECT * FROM f.node`);
    old.exec(`INSERT INTO edge SELECT * FROM f.edge`);
    old.exec(`INSERT INTO meta SELECT * FROM f.meta WHERE key <> 'normalizer_version'`);
    old.exec(`INSERT INTO meta (key, value) VALUES ('normalizer_version', '13')`);
    old.exec(`DETACH DATABASE f`);
    old.close();

    const s = openStore(oldFile);
    try {
      expect(rebuildReason(s)).toBe(`normalizer version 13 -> ${NORMALIZER_VERSION}`);
      const p2 = new Pipeline(s, config);
      p2.rebuild();
      expect(strip(s.getGraph('s1')!)).toEqual(reference);
      expect(s.getSession('s1')!.title).toBe('T');
      expect(s.hookEventStats()).toEqual([expect.objectContaining({ eventName: 'Stop', count: 1 })]);
      expect(rebuildReason(s)).toBeNull(); // once
      // The live path keeps working on the migrated database: nothing is re-ingested.
      const rawBefore = s.rawForSession('s1').length;
      await p2.scanAll();
      expect(s.rawForSession('s1')).toHaveLength(rawBefore);
    } finally {
      s.close();
    }
    expect(fsSync.existsSync(oldFile)).toBe(true);
  });
});
