import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test, vi } from 'vitest';
import type { Bookmark, BookmarkSnapshot, ExportBundle } from '@agent-canvas/shared';
import {
  BOOKMARK_UNDO_MS, MARKED_TEXT, NOTE_GOES_TEXT, SESSION_MARK_TEXT, STEP_MARK_TEXT, createSessionBookmarkController,
} from '../src/bookmarks';
import { BookmarkToggle } from '../src/canvas/BookmarkToggle';
import { Drawer } from '../src/canvas/Drawer';
import { EMPTY_CHAIN } from '../src/canvas/chain';
import { buildView } from '../src/canvas/view';
import { createDisplaySource, IDENTITY_MASKER } from '../src/masking';
import type { SessionBookmarks, SessionSource } from '../src/sessionSource';
import { embeddedSource } from '../src/viewer/data';
import { baseSession, mkNode } from './helpers';

afterEach(() => { vi.useRealTimers(); });

// Invented bookmarks only.
const snap = (nodeId: string | null): BookmarkSnapshot => ({
  sessionTitle: '接入 Qwen Code', origin: 'claude', projectId: 'D--work-demo', cwd: 'D:/work/demo',
  nodeKind: nodeId === null ? null : 'tool', toolName: nodeId === null ? null : 'Bash', stepLabel: nodeId === null ? null : 'Bash · npm test',
  nodeAt: nodeId === null ? null : '2026-01-01T00:00:00.000Z',
});
const bm = (id: number, nodeId: string | null, note = ''): Bookmark => ({
  id, sessionId: 's1', nodeId, note, createdAt: '2026-01-01T00:00:00.000Z', noteUpdatedAt: null, snapshot: snap(nodeId),
  now: { session: true, node: true, sessionTitle: '接入 Qwen Code', sourceDeleted: false, projectName: 'demo' },
});

/** A fake SessionSource.bookmarks: answers at once, records the calls, pushes lists by hand. */
function fakeBookmarks() {
  const calls: string[] = [];
  let nextId = 10;
  let onList: ((l: readonly Bookmark[] | null) => void) | null = null;
  let failNext: Error | null = null;
  const settle = <T>(name: string, value: () => T): Promise<T> => {
    calls.push(name);
    const err = failNext;
    failNext = null;
    return err === null ? Promise.resolve(value()) : Promise.reject(err);
  };
  const existing = new Map<string, Bookmark>();
  const b: SessionBookmarks = {
    watch(fn) { onList = fn; return () => { onList = null; }; },
    create: (nodeId, note) => settle(`create ${nodeId ?? 'session'}`, () => {
      const old = existing.get(nodeId ?? '');
      return old !== undefined ? { created: false, bookmark: old } : { created: true, bookmark: bm(nextId++, nodeId, note ?? '') };
    }),
    patch: (id, note) => settle(`patch ${id} ${note}`, () => ({ ...bm(id, null, note.trim()), noteUpdatedAt: '2026-01-02T00:00:00.000Z' })),
    remove: (id) => settle(`delete ${id}`, () => ({ ok: true })),
    restore: (id) => settle(`restore ${id}`, () => bm(id, 'n1', '为什么标它')),
  };
  return {
    b, calls,
    push: (l: readonly Bookmark[] | null) => onList?.(l),
    watching: () => onList !== null,
    exists: (x: Bookmark) => existing.set(x.nodeId ?? '', x),
    fail: (e: Error) => { failNext = e; },
  };
}

test('按钮的字：收藏会话 / 收藏这一步 / 已收藏；撤销提示「备注会一起删除」', () => {
  expect(SESSION_MARK_TEXT).toBe('收藏会话');
  expect(STEP_MARK_TEXT).toBe('收藏这一步');
  expect(MARKED_TEXT).toBe('已收藏');
  expect(NOTE_GOES_TEXT).toBe('备注会一起删除');
});

test('列表到之前按钮不可点；列表里有就是已收藏，没有就是未收藏', () => {
  const f = fakeBookmarks();
  const c = createSessionBookmarkController(f.b);
  expect(c.stateOf(null)).toMatchObject({ ready: false, bookmark: null });
  c.setList([bm(1, null), bm(2, 'n1', '修好 CI 的那一步')]);
  expect(c.stateOf(null)).toMatchObject({ ready: true, bookmark: { id: 1 } });
  expect(c.stateOf('n1').bookmark).toMatchObject({ id: 2, note: '修好 CI 的那一步' });
  expect(c.stateOf('n2')).toMatchObject({ ready: true, bookmark: null, busy: false });
  c.close();
});

test('收藏会话：点一下就是已收藏（不等列表刷新），备注框拿到焦点；列表跟上之后也还是它', async () => {
  const f = fakeBookmarks();
  const c = createSessionBookmarkController(f.b);
  c.setList([]);
  const changes = vi.fn();
  c.subscribe(changes);
  const marking = c.toggle(null);
  expect(c.stateOf(null).busy).toBe(true);
  await marking;
  expect(f.calls).toEqual(['create session']);
  expect(c.stateOf(null)).toMatchObject({ busy: false, bookmark: { id: 10, nodeId: null }, fresh: true });
  expect(changes).toHaveBeenCalled();
  c.setList([]); // an older list without it: still shown
  expect(c.stateOf(null).bookmark?.id).toBe(10);
  c.setList([bm(10, null)]);
  expect(c.shown().map((x) => x.id)).toEqual([10]);
  c.startEdit(null);
  expect(c.stateOf(null).fresh).toBe(false);
  c.close();
});

test('已经被别处收藏了（409）：当成已收藏，用那条书签', async () => {
  const f = fakeBookmarks();
  f.exists(bm(7, 'n1', '别处写的'));
  const c = createSessionBookmarkController(f.b);
  c.setList([]);
  await c.toggle('n1');
  expect(c.stateOf('n1').bookmark).toMatchObject({ id: 7, note: '别处写的' });
  c.close();
});

test('收藏失败：按钮旁说明原因，还是未收藏', async () => {
  const f = fakeBookmarks();
  const c = createSessionBookmarkController(f.b);
  c.setList([]);
  f.fail(Object.assign(new Error('找不到这一步'), { status: 404 }));
  await c.toggle('n1');
  expect(c.stateOf('n1')).toMatchObject({ bookmark: null, busy: false, error: '找不到这一步' });
  expect(c.stateOf(null).error).toBeNull();
  c.close();
});

test('取消收藏（没有备注）：马上变回未收藏，不出撤销', async () => {
  vi.useFakeTimers();
  const f = fakeBookmarks();
  const c = createSessionBookmarkController(f.b);
  c.setList([bm(2, 'n1')]);
  await c.toggle('n1');
  expect(f.calls).toEqual(['delete 2']);
  expect(c.stateOf('n1')).toMatchObject({ bookmark: null, undo: false });
  c.close();
});

test('取消收藏（有备注）：提示「备注会一起删除」带撤销 6 秒；撤销走恢复，书签和备注回来', async () => {
  vi.useFakeTimers();
  const f = fakeBookmarks();
  const c = createSessionBookmarkController(f.b);
  c.setList([bm(2, 'n1', '为什么标它')]);
  await c.toggle('n1');
  expect(c.stateOf('n1')).toMatchObject({ bookmark: null, undo: true });
  expect(c.stateOf(null).undo).toBe(false); // shown beside this step's button only
  c.setList([]); // the list after the delete
  await c.undo();
  expect(f.calls).toEqual(['delete 2', 'restore 2']);
  // Shown again at once (the restore's answer), before the list catches up.
  expect(c.stateOf('n1')).toMatchObject({ bookmark: { id: 2, note: '为什么标它' }, undo: false });

  await c.toggle('n1');
  expect(c.stateOf('n1').undo).toBe(true);
  await vi.advanceTimersByTimeAsync(BOOKMARK_UNDO_MS);
  expect(c.stateOf('n1').undo).toBe(false);
  c.close();
});

test('删除还没回来时按钮不可点；再收藏同一处会去掉旧的撤销', async () => {
  vi.useFakeTimers();
  const f = fakeBookmarks();
  let finish: (() => void) | null = null;
  const b: SessionBookmarks = {
    ...f.b,
    remove: (id) => { f.calls.push(`delete ${id}`); return new Promise((r) => { finish = () => r({ ok: true }); }); },
  };
  const c = createSessionBookmarkController(b);
  c.setList([bm(2, 'n1', '有备注')]);
  const removing = c.toggle('n1');
  expect(c.stateOf('n1').busy).toBe(true);
  await c.toggle('n1'); // ignored while the delete is in flight
  expect(f.calls).toEqual(['delete 2']);
  finish!();
  await removing;
  expect(c.stateOf('n1')).toMatchObject({ busy: false, undo: true });
  await c.toggle('n1');
  expect(f.calls).toEqual(['delete 2', 'create n1']);
  expect(c.stateOf('n1')).toMatchObject({ undo: false, bookmark: { id: 10 } });
  c.close();
});

test('备注：回车和离开只发一次；规范化后没变不发；Escape 取消', async () => {
  const f = fakeBookmarks();
  const c = createSessionBookmarkController(f.b);
  c.setList([bm(1, null, '旧的')]);
  c.startEdit(null);
  expect(c.stateOf(null).editing).toMatchObject({ draft: '旧的' });
  expect(c.stateOf('n1').editing).toBeNull();
  c.setDraft(' 旧的\n');
  await c.commitEdit();
  expect(f.calls).toEqual([]);
  c.startEdit(null);
  c.setDraft('第一次接 Qwen 的会话');
  const saving = c.commitEdit();
  await c.commitEdit();
  await saving;
  expect(f.calls).toEqual(['patch 1 第一次接 Qwen 的会话']);
  expect(c.stateOf(null)).toMatchObject({ editing: null, bookmark: { note: '第一次接 Qwen 的会话' } });
  c.startEdit(null);
  c.setDraft('不要了');
  c.cancelEdit();
  await c.commitEdit();
  expect(f.calls).toHaveLength(1);
  c.close();
});

test('shown() 在没变时是同一个数组（打字不重算星标）；close 后停止听页面的改动，再订阅又能听到', () => {
  const f = fakeBookmarks();
  const c = createSessionBookmarkController(f.b);
  const list = [bm(1, 'n1')];
  c.setList(list);
  const a = c.shown();
  c.startEdit('n1');
  c.setDraft('打字');
  expect(c.shown()).toBe(a);
  const fn = vi.fn();
  c.subscribe(fn);
  c.close();
  c.setDraft('再打');
  expect(fn).not.toHaveBeenCalled();
  const again = vi.fn();
  c.subscribe(again); // React's development double mount
  c.setDraft('又打');
  expect(again).toHaveBeenCalled();
  c.close();
});

// ---- the markup ----

test('工具栏：未收藏「收藏会话」，已收藏「已收藏」带备注框；没有书签功能时什么都不画', () => {
  const f = fakeBookmarks();
  const c = createSessionBookmarkController(f.b);
  c.setList([]);
  const off = renderToStaticMarkup(createElement(BookmarkToggle, { ctrl: c, nodeId: null }));
  expect(off).toContain('收藏会话');
  expect(off).toContain('aria-pressed="false"');
  expect(off).not.toContain('<input');
  c.setList([bm(1, null, '第一次接 Qwen 的会话')]);
  const on = renderToStaticMarkup(createElement(BookmarkToggle, { ctrl: c, nodeId: null }));
  expect(on).toContain('已收藏');
  expect(on).toContain('aria-pressed="true"');
  expect(on).toContain('value="第一次接 Qwen 的会话"');
  expect(renderToStaticMarkup(createElement(BookmarkToggle, { ctrl: null, nodeId: null }))).toBe('');
  c.close();
});

test('有备注的取消收藏：按钮旁出「备注会一起删除」和撤销', async () => {
  vi.useFakeTimers();
  const f = fakeBookmarks();
  const c = createSessionBookmarkController(f.b);
  c.setList([bm(2, 'n1', '为什么标它')]);
  await c.toggle('n1');
  const html = renderToStaticMarkup(createElement(BookmarkToggle, { ctrl: c, nodeId: 'n1' }));
  expect(html).toContain('收藏这一步');
  expect(html).toContain(NOTE_GOES_TEXT);
  expect(html).toContain('撤销');
  c.close();
});

const drawerProps = (ctrl: ReturnType<typeof createSessionBookmarkController> | null) => {
  const n = { ...mkNode('n1'), kind: 'tool' as const, title: 'Bash' };
  const g = { nodes: { n1: n }, edges: {} };
  return {
    loadDetail: () => new Promise<never>(() => {}), node: n, chain: EMPTY_CHAIN, view: buildView(g, new Map()),
    onSelect: () => {}, onExpandCut: () => {}, onClose: () => {}, bookmarks: ctrl,
  };
};

test('抽屉：顶上有「收藏这一步」，已收藏时「已收藏」；没有书签功能（导出的查看器）时没有', () => {
  const f = fakeBookmarks();
  const c = createSessionBookmarkController(f.b);
  c.setList([]);
  expect(renderToStaticMarkup(createElement(Drawer, drawerProps(c)))).toContain('收藏这一步');
  c.setList([bm(3, 'n1')]);
  const on = renderToStaticMarkup(createElement(Drawer, drawerProps(c)));
  expect(on).toContain('已收藏');
  expect(on).toContain('aria-label="这一步的备注"');
  const viewer = renderToStaticMarkup(createElement(Drawer, drawerProps(null)));
  expect(viewer).not.toContain('收藏');
  c.close();
});

test('导出的查看器没有书签：embeddedSource 和套上遮蔽之后都是 null；应用里的源原样传过去', () => {
  const bundle = { session: baseSession, nodes: [mkNode('n1')], edges: [], details: {}, truncations: {}, unreadable: [] } as unknown as ExportBundle;
  const viewer = embeddedSource(bundle, () => { throw new Error('no layout here'); });
  expect(viewer.bookmarks).toBeNull();
  expect(createDisplaySource(viewer, IDENTITY_MASKER).bookmarks).toBeNull();
  const f = fakeBookmarks();
  const live: SessionSource = { ...viewer, bookmarks: f.b };
  expect(createDisplaySource(live, IDENTITY_MASKER).bookmarks).toBe(f.b);
});
