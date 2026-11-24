import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { BOOKMARK_NOTE_MAX, normalizeBookmarkNote, type Bookmark, type GraphNode } from '@agent-canvas/shared';
import { BOOKMARK_PURGE_AFTER_MS, BookmarksService } from '../src/bookmarks/service.js';
import { loadConfig, type Config } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { DERIVED_TABLES } from '../src/store/schema.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';
import { assistantBlock, toolResult, userPrompt } from './fixtures.js';

// Invented data only: an in-memory store (a temp-dir file database for the upgrade test), session files in a temp dir.

const T0 = Date.parse('2026-11-20T10:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const linesOf = (events: RawEvent[]): string => events.map((e) => (e.source === 'transcript' ? e.line : '') + '\n').join('');
const REPLY = '已经改好了：把超时从五秒调到二十秒，然后重新跑了一遍全部测试，四百二十个用例都通过了，CI 上那一步也不会再超时，可以合并了。顺手把重试次数也从一次改成了两次，日志里能看到每次重试的原因。';

function configFor(tmp: string): Config {
  return loadConfig({}, { deepseekDir: null, workbuddyDirs: [], codebuddyDir: null, doubaoDirs: [], qwenDir: null, geminiDir: null, grokDir: null, copilotDir: null, projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, cursorDbPath: null });
}

describe('书签：存储与快照', () => {
  let tmp: string;
  let config: Config;
  let store: Store;
  let pipeline: Pipeline;
  let nowMs: number;
  let svc: BookmarksService;
  let pushed: string[][];

  /** Session s1 in project `-work-demo` (cwd /work/demo): a prompt, a Bash call (npm test) and a long reply. */
  async function ingestSession(): Promise<void> {
    const file = path.join(config.projectsDir, '-work-demo', 's1.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      linesOf([
        userPrompt('u1', null, '跑一下测试'),
        assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test', description: '跑测试' } }),
        toolResult('u2', 'a1', 'tu1', 'ok'),
        assistantBlock('a2', 'u2', { type: 'text', text: REPLY }),
      ]),
    );
    await pipeline.ingestFile(file);
  }
  const nodeOf = (kind: GraphNode['kind']): GraphNode => store.getGraph('s1')!.nodes.find((n) => n.kind === kind)!;
  const create = (body: unknown) => svc.create(body);
  const created = (body: unknown): Bookmark => {
    const r = svc.create(body);
    if (!r.ok) throw new Error(`create failed: ${r.status} ${r.error}`);
    expect(r.status).toBe(201);
    return r.bookmark;
  };

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-bookmarks-'));
    config = configFor(tmp);
    await fs.mkdir(config.projectsDir, { recursive: true });
    store = openStore(':memory:');
    pipeline = new Pipeline(store, config);
    nowMs = T0;
    svc = new BookmarksService({ store, now: () => nowMs });
    pushed = [];
    svc.onUpdate((ids) => pushed.push(ids));
    await ingestSession();
  });
  afterEach(async () => {
    store.close();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  test('收藏会话：快照来自库里的会话，现状齐全', () => {
    const session = store.getSession('s1')!;
    expect(session.title).toBe('跑一下测试');
    const b = created({ sessionId: 's1', nodeId: null });
    expect(b).toEqual({
      id: expect.any(Number),
      sessionId: 's1',
      nodeId: null,
      note: '',
      createdAt: iso(T0),
      noteUpdatedAt: null,
      snapshot: { sessionTitle: '跑一下测试', origin: 'claude', projectId: '-work-demo', cwd: '/work/demo', nodeKind: null, toolName: null, stepLabel: null, nodeAt: null },
      now: { session: true, node: true, sessionTitle: '跑一下测试', sourceDeleted: false, projectName: 'demo' },
    });
    expect(svc.list()).toEqual([b]);
    expect(pushed).toEqual([['s1']]);
  });

  test('收藏工具步骤：一行摘要是 “Bash · npm test”，带种类、工具名和那一步的时间', () => {
    const tool = nodeOf('tool');
    const b = created({ sessionId: 's1', nodeId: tool.id, note: '修 CI 超时' });
    expect(b.nodeId).toBe(tool.id);
    expect(b.note).toBe('修 CI 超时');
    expect(b.snapshot).toEqual({
      sessionTitle: '跑一下测试',
      origin: 'claude',
      projectId: '-work-demo',
      cwd: '/work/demo',
      nodeKind: 'tool',
      toolName: 'Bash',
      stepLabel: 'Bash · npm test',
      nodeAt: tool.timestamp,
    });
    expect(b.now).toEqual({ session: true, node: true, sessionTitle: '跑一下测试', sourceDeleted: false, projectName: 'demo' });
  });

  test('收藏文字步骤：一行摘要是摘要的前 80 个字符', () => {
    const text = nodeOf('text');
    expect([...REPLY].length).toBeGreaterThan(80);
    const b = created({ sessionId: 's1', nodeId: text.id });
    expect(b.snapshot).toMatchObject({ nodeKind: 'text', toolName: null, stepLabel: [...REPLY].slice(0, 80).join(''), nodeAt: text.timestamp });
  });

  test('请求里带的 snapshot 不算数', () => {
    const tool = nodeOf('tool');
    const fake = { sessionTitle: '假的', origin: 'codex', projectId: 'x', cwd: 'C:\\x', nodeKind: 'text', toolName: 'Evil', stepLabel: '假的', nodeAt: iso(0) };
    const b = created({ sessionId: 's1', nodeId: tool.id, snapshot: fake });
    expect(b.snapshot).toMatchObject({ sessionTitle: '跑一下测试', origin: 'claude', toolName: 'Bash', stepLabel: 'Bash · npm test' });
  });

  test('找不到会话或这一步：404，不存', () => {
    expect(create({ sessionId: 'nope', nodeId: null })).toMatchObject({ ok: false, status: 404 });
    expect(create({ sessionId: 's1', nodeId: 'no-such-node' })).toMatchObject({ ok: false, status: 404 });
    expect(svc.list()).toEqual([]);
    expect(pushed).toEqual([]);
  });

  test.each([
    ['不是对象', 'x'],
    ['数组', [{ sessionId: 's1', nodeId: null }]],
    ['没有 sessionId', { nodeId: null }],
    ['sessionId 为空', { sessionId: '', nodeId: null }],
    ['nodeId 不是字符串', { sessionId: 's1', nodeId: 5 }],
    ['nodeId 为空串', { sessionId: 's1', nodeId: '' }],
    ['备注不是字符串', { sessionId: 's1', nodeId: null, note: 3 }],
    ['备注太长', { sessionId: 's1', nodeId: null, note: 'x'.repeat(BOOKMARK_NOTE_MAX + 1) }],
  ])('新建的请求不合法（%s）：400', (_name, body) => {
    const r = create(body);
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(svc.list()).toEqual([]);
  });

  test('列表按标记时间倒序，同一时间按 id 倒序；可以只列一个会话的', () => {
    const tool = nodeOf('tool');
    const text = nodeOf('text');
    const a = created({ sessionId: 's1', nodeId: null });
    const b = created({ sessionId: 's1', nodeId: tool.id });
    nowMs = T0 + 1000;
    const c = created({ sessionId: 's1', nodeId: text.id });
    expect(b.id).toBeGreaterThan(a.id);
    expect(svc.list().map((x) => x.id)).toEqual([c.id, b.id, a.id]);
    expect(svc.list('s1').map((x) => x.id)).toEqual([c.id, b.id, a.id]);
    expect(svc.list('other')).toEqual([]);
  });

  test('同一处只能收藏一次：409 带着已有的那个', () => {
    const first = created({ sessionId: 's1', nodeId: null, note: '第一次' });
    nowMs += 1000;
    const again = create({ sessionId: 's1', nodeId: null, note: '第二次' });
    expect(again).toMatchObject({ ok: false, status: 409, bookmark: first });
    expect(svc.list()).toEqual([first]);
    // A step of the same session is another place.
    expect(create({ sessionId: 's1', nodeId: nodeOf('tool').id }).ok).toBe(true);
  });

  test('改备注：规整后存下，记下修改时间；推送这个会话', () => {
    const b = created({ sessionId: 's1', nodeId: null });
    pushed = [];
    nowMs = T0 + 5000;
    const r = svc.updateNote(b.id, { note: '  第一行\r\n\n   第二行  ' });
    expect(r).toMatchObject({ ok: true, status: 200 });
    const updated = svc.list()[0]!;
    expect(updated).toMatchObject({ id: b.id, note: '第一行 第二行', createdAt: iso(T0), noteUpdatedAt: iso(T0 + 5000) });
    expect(r.ok && r.bookmark).toEqual(updated);
    expect(pushed).toEqual([['s1']]);
    expect(svc.updateNote(b.id, { note: 'x'.repeat(201) })).toMatchObject({ ok: false, status: 400 });
    expect(svc.updateNote(b.id, {})).toMatchObject({ ok: false, status: 400 });
    expect(svc.updateNote(9999, { note: 'x' })).toMatchObject({ ok: false, status: 404 });
    expect(svc.list()[0]!.note).toBe('第一行 第二行');
  });

  test('删除是软删除：列表里没有了，撤销后原样回来', () => {
    const b = created({ sessionId: 's1', nodeId: nodeOf('tool').id, note: '留着' });
    pushed = [];
    expect(svc.remove(b.id)).toEqual({ ok: true });
    expect(svc.list()).toEqual([]);
    expect(svc.list('s1')).toEqual([]);
    expect(store.bookmarkById(b.id)).toMatchObject({ id: b.id, deletedAt: iso(T0) });
    expect(svc.remove(b.id)).toMatchObject({ ok: false, status: 404 });
    expect(svc.updateNote(b.id, { note: 'x' })).toMatchObject({ ok: false, status: 404 });
    nowMs = T0 + 3000;
    const restored = svc.restore(b.id);
    expect(restored).toMatchObject({ ok: true, status: 200, bookmark: b });
    expect(svc.list()).toEqual([b]);
    expect(pushed).toEqual([['s1'], ['s1']]);
  });

  test('删除超过 24 小时的行在下一次写入时清掉，之后不能撤销', () => {
    const b = created({ sessionId: 's1', nodeId: null });
    const keep = created({ sessionId: 's1', nodeId: nodeOf('tool').id });
    svc.remove(b.id);
    svc.remove(keep.id);
    nowMs = T0 + BOOKMARK_PURGE_AFTER_MS - 1;
    expect(svc.restore(keep.id).ok).toBe(true); // within 24 h: still there
    nowMs = T0 + BOOKMARK_PURGE_AFTER_MS + 1;
    expect(store.bookmarkById(b.id)).not.toBeNull(); // reads do not purge
    svc.list();
    expect(store.bookmarkById(b.id)).not.toBeNull();
    created({ sessionId: 's1', nodeId: nodeOf('text').id }); // a write
    expect(store.bookmarkById(b.id)).toBeNull();
    expect(svc.restore(b.id)).toMatchObject({ ok: false, status: 404 });
    expect(store.bookmarkById(keep.id)).not.toBeNull();
  });

  test('超过 24 小时后直接撤销：先清掉，404', () => {
    const b = created({ sessionId: 's1', nodeId: null });
    svc.remove(b.id);
    nowMs = T0 + BOOKMARK_PURGE_AFTER_MS + 1;
    expect(svc.restore(b.id)).toMatchObject({ ok: false, status: 404 });
    expect(store.bookmarkById(b.id)).toBeNull();
  });

  test('在已软删除的地方重新收藏：旧行清掉，新行是新的 id；旧的撤销 404', () => {
    const old = created({ sessionId: 's1', nodeId: null, note: '旧的' });
    svc.remove(old.id);
    nowMs = T0 + 1000;
    const fresh = created({ sessionId: 's1', nodeId: null, note: '新的' });
    expect(fresh.id).not.toBe(old.id);
    expect(fresh).toMatchObject({ note: '新的', createdAt: iso(T0 + 1000) });
    expect(store.bookmarkById(old.id)).toBeNull();
    expect(svc.restore(old.id)).toMatchObject({ ok: false, status: 404 });
    expect(svc.list()).toEqual([fresh]);
  });

  test('id 不复用：清掉最大的一行后新建，id 仍然更大', () => {
    const a = created({ sessionId: 's1', nodeId: null });
    svc.remove(a.id);
    nowMs = T0 + BOOKMARK_PURGE_AFTER_MS + 1;
    const b = created({ sessionId: 's1', nodeId: null });
    expect(b.id).toBeGreaterThan(a.id);
  });

  test('rebuild 之后书签都在，那一步还能找到', () => {
    const s = created({ sessionId: 's1', nodeId: null, note: '会话' });
    const t = created({ sessionId: 's1', nodeId: nodeOf('tool').id, note: '步骤' });
    expect(DERIVED_TABLES as readonly string[]).not.toContain('bookmark');
    pipeline.rebuild();
    expect(store.getSession('s1')).not.toBeNull();
    const after = svc.list();
    expect(after).toEqual([t, s]);
    expect(after.every((b) => b.now.node && b.now.session)).toBe(true);
  });

  test('clearDerived 不动书签：会话和步骤找不到了，快照不变', () => {
    const s = created({ sessionId: 's1', nodeId: null });
    const t = created({ sessionId: 's1', nodeId: nodeOf('tool').id });
    store.clearDerived();
    const after = svc.list();
    expect(after.map((b) => b.id)).toEqual([t.id, s.id]);
    expect(after.map((b) => b.snapshot)).toEqual([t.snapshot, s.snapshot]);
    for (const b of after) expect(b.now).toEqual({ session: false, node: false, sessionTitle: null, sourceDeleted: false, projectName: null });
  });

  test('那一步在重建后不在了：now.node 为 false，会话还在，快照不变', () => {
    const tool = nodeOf('tool');
    const t = created({ sessionId: 's1', nodeId: tool.id });
    const s = created({ sessionId: 's1', nodeId: null });
    pipeline.rebuild();
    store.applyChanges([{ type: 'node_removed', sessionId: 's1', id: tool.id }]);
    const after = svc.list();
    const step = after.find((b) => b.id === t.id)!;
    expect(step.now).toMatchObject({ session: true, node: false, sessionTitle: '跑一下测试' });
    expect(step.snapshot).toEqual(t.snapshot);
    expect(after.find((b) => b.id === s.id)!.now.node).toBe(true);
  });

  test('会话改名、源文件删除：现状跟着变，快照不变', () => {
    const b = created({ sessionId: 's1', nodeId: null });
    const session = store.getSession('s1')!;
    store.applyChanges([{ type: 'session_upserted', session: { ...session, title: '修 CI 超时', sourceDeleted: true } }]);
    const [now] = svc.list();
    expect(now!.now).toEqual({ session: true, node: true, sessionTitle: '修 CI 超时', sourceDeleted: true, projectName: 'demo' });
    expect(now!.snapshot.sessionTitle).toBe('跑一下测试');
    expect(now!.snapshot).toEqual(b.snapshot);
  });

  test('没有标题的会话：标题按首页的写法取 id 的前 8 个字符', () => {
    const session = store.getSession('s1')!;
    store.applyChanges([{ type: 'session_upserted', session: { ...session, id: 'abcdef0123456789', title: null } }]);
    const b = created({ sessionId: 'abcdef0123456789', nodeId: null });
    expect(b.snapshot.sessionTitle).toBe('abcdef01');
    expect(b.now.sessionTitle).toBe('abcdef01');
  });

  test('写入的推送：新建、改备注、删除、撤销各一次；被拒的不推', () => {
    const b = created({ sessionId: 's1', nodeId: null });
    create({ sessionId: 's1', nodeId: null });
    svc.updateNote(b.id, { note: '备注' });
    svc.remove(b.id);
    svc.restore(b.id);
    svc.restore(9999);
    expect(pushed).toEqual([['s1'], ['s1'], ['s1'], ['s1']]);
  });

  test('getNode：按主键读一个节点，不存在时为 null', () => {
    const tool = nodeOf('tool');
    expect(store.getNode('s1', tool.id)).toEqual(tool);
    expect(store.getNode('s1', 'nope')).toBeNull();
    expect(store.getNode('nope', tool.id)).toBeNull();
  });
});

describe('备注规则', () => {
  test('去掉首尾空白，含换行的空白折成一个空格，其余空白不动', () => {
    expect(normalizeBookmarkNote('  a\n\n  b  ')).toEqual({ ok: true, note: 'a b' });
    expect(normalizeBookmarkNote('a\r\nb\u2028c')).toEqual({ ok: true, note: 'a b c' });
    expect(normalizeBookmarkNote('a  b\tc')).toEqual({ ok: true, note: 'a  b\tc' });
    expect(normalizeBookmarkNote('   ')).toEqual({ ok: true, note: '' });
    expect(normalizeBookmarkNote('')).toEqual({ ok: true, note: '' });
  });

  test('最多 200 个字符，按码点数（一个表情算 1 个）；201 个被拒，中文说明', () => {
    expect(BOOKMARK_NOTE_MAX).toBe(200);
    const emoji = '😀'.repeat(200);
    expect(emoji.length).toBe(400);
    expect(normalizeBookmarkNote(emoji)).toEqual({ ok: true, note: emoji });
    expect(normalizeBookmarkNote('字'.repeat(200))).toEqual({ ok: true, note: '字'.repeat(200) });
    const tooLong = normalizeBookmarkNote('字'.repeat(201));
    expect(tooLong.ok).toBe(false);
    expect(!tooLong.ok && tooLong.error).toMatch(/200/);
    expect(!tooLong.ok && tooLong.error).toMatch(/[\u4e00-\u9fff]/);
    expect(normalizeBookmarkNote('😀'.repeat(201)).ok).toBe(false);
    // Counted after trimming and folding.
    expect(normalizeBookmarkNote(`  ${'字'.repeat(200)}  \n`).ok).toBe(true);
  });
});

describe('老数据库', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-bookmarks-upgrade-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  test('上一版本的数据库（没有 bookmark 表）打开后有了这张表，其他表的行不变', () => {
    const file = path.join(tmp, 'old.db');
    const first = openStore(file);
    first.insertRaw({ source: 'hook', receivedAt: iso(T0), eventName: 'Stop', sessionId: 's1', payload: '{"session_id":"s1"}' });
    first.setMeta('poll:example', '1');
    first.close();
    // The previous schema: the same tables without bookmark.
    const raw = new Database(file);
    raw.exec('DROP TABLE bookmark');
    const counts = (db: Database.Database) =>
      Object.fromEntries(
        (db.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_fts%'`).pluck().all() as string[]).map(
          (t) => [t, db.prepare(`SELECT COUNT(*) FROM "${t}"`).pluck().get()],
        ),
      );
    const before = counts(raw);
    expect(before).not.toHaveProperty('bookmark');
    raw.close();

    const s = openStore(file);
    try {
      expect(s.listBookmarks()).toEqual([]);
      expect(s.rawForSession('s1')).toHaveLength(1);
      expect(s.getMeta('poll:example')).toBe('1');
    } finally {
      s.close();
    }
    const again = new Database(file, { readonly: true });
    try {
      const after = counts(again);
      expect(after).toEqual({ ...before, bookmark: 0 });
    } finally {
      again.close();
    }
  });
});
