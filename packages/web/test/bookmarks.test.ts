import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test, vi } from 'vitest';
import type { Bookmark, BookmarkSnapshot } from '@agent-canvas/shared';
import {
  BOOKMARKS_EMPTY_TEXT, BOOKMARK_FILTER_PLACEHOLDER, BOOKMARK_UNDO_MS, NO_NOTE_TEXT, SESSION_GONE_NOTICE, STEP_GONE_NOTICE,
  bookmarkClick, bookmarkOpener, bookmarkRows, bookmarkTime, bookmarksTitle, createBookmarkPageController, filterBookmarkRows,
  nextSessionNotice, sessionNoticeFor, type ClickLike, type SessionNotice,
  type BookmarkWrites,
} from '../src/bookmarks';
import { api, openLiveBookmarks, type BookmarksLiveState } from '../src/client';
import { createPageMasker, IDENTITY_MASKER } from '../src/masking';
import { BookmarkRow, BookmarksView } from '../src/pages/Bookmarks';
import { parseHash } from '../src/route';
import { fakeSocket } from './helpers';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/** Invented bookmarks: local times, so `MM-DD HH:mm` is the same in every time zone. */
const at = (month: number, day: number, h: number, min: number): string => new Date(2026, month - 1, day, h, min).toISOString();

type BookmarkOver = Omit<Partial<Bookmark>, 'snapshot' | 'now'> & { snapshot?: Partial<BookmarkSnapshot>; now?: Partial<Bookmark['now']> };

const bm = (over: BookmarkOver = {}): Bookmark => {
  const { snapshot, now, ...rest } = over;
  const nodeId = rest.nodeId === undefined ? 'n1' : rest.nodeId;
  const step = nodeId !== null;
  return {
    id: 1, sessionId: 's1', note: '修好 CI 超时的那一步', createdAt: at(11, 22, 14, 5), noteUpdatedAt: null, ...rest, nodeId,
    snapshot: {
      sessionTitle: '修 CI 超时', origin: 'claude', projectId: 'D--work-agent-canvas', cwd: 'D:/work/agent-canvas',
      nodeKind: step ? 'tool' : null, toolName: step ? 'Bash' : null, stepLabel: step ? 'Bash · npm test -- --testTimeout=20000' : null,
      nodeAt: step ? at(11, 22, 14, 0) : null, ...snapshot,
    },
    now: { session: true, node: true, sessionTitle: '修 CI 超时（新标题）', sourceDeleted: false, projectName: 'agent-canvas', ...now },
  };
};

// ---- route, title, time ----

test('route: #/bookmarks 是书签页', () => {
  expect(parseHash('#/bookmarks')).toEqual({ page: 'bookmarks' });
  expect(parseHash('#/bookmarks/x')).toEqual({ page: 'home', projectId: null });
});

test('标题 书签（N）；时间是本地的 MM-DD HH:mm', () => {
  expect(bookmarksTitle(23)).toBe('书签（23）');
  expect(bookmarksTitle(0)).toBe('书签（0）');
  expect(bookmarkTime(at(11, 2, 9, 3))).toBe('11-02 09:03');
  expect(bookmarkTime('not a time')).toBe('');
});

// ---- view models ----

test('会话书签：种类 会话、备注、时间、项目 · 来源 · 当前标题，链接打开会话', () => {
  const [row] = bookmarkRows([bm({ id: 7, nodeId: null, note: '第一次接 Qwen 的会话', createdAt: at(11, 18, 9, 30) })], IDENTITY_MASKER);
  expect(row).toMatchObject({
    id: 7, kind: 'session', kindLabel: '会话', note: '第一次接 Qwen 的会话', noteText: '第一次接 Qwen 的会话', hasNote: true,
    time: '11-18 09:30', stepLabel: null, project: 'agent-canvas', originLabel: 'Claude Code', title: '修 CI 超时（新标题）',
    missing: null, badge: null, open: { kind: 'link', href: '#/s/s1' },
  });
});

test('步骤书签：种类 步骤、步骤摘要，链接打开会话并定位到那一步；没有备注写（没有备注）', () => {
  const [row] = bookmarkRows([bm({ sessionId: 'a b', nodeId: 'n/2', note: '' })], IDENTITY_MASKER);
  expect(row).toMatchObject({
    kind: 'step', kindLabel: '步骤', note: '', noteText: NO_NOTE_TEXT, hasNote: false, stepLabel: 'Bash · npm test -- --testTimeout=20000',
    open: { kind: 'link', href: '#/s/a%20b/n/n%2F2' },
  });
  expect(NO_NOTE_TEXT).toBe('（没有备注）');
});

test('找不到这一步：标出来，点它打开会话并提示「这一步已经不在了」', () => {
  const [row] = bookmarkRows([bm({ now: { node: false } })], IDENTITY_MASKER);
  expect(row!.missing).toBe('step');
  expect(row!.badge).toBe('找不到这一步');
  expect(row!.open).toEqual({ kind: 'missing-step', href: '#/s/s1', notice: '这一步已经不在了', at: at(11, 22, 14, 0) });
  expect(STEP_GONE_NOTICE).toBe('这一步已经不在了');
  expect(row!.title).toBe('修 CI 超时（新标题）');
});

test('找不到这个会话：标出来，显示快照的标题和项目，点它不跳转只提示', () => {
  const [row] = bookmarkRows([bm({
    snapshot: { cwd: null, projectId: 'cursor-abc', origin: 'cursor' },
    now: { session: false, node: false, sessionTitle: null, projectName: null },
  })], IDENTITY_MASKER);
  expect(row!.missing).toBe('session');
  expect(row!.badge).toBe('找不到这个会话');
  expect(row!.open).toEqual({ kind: 'missing-session', notice: '这个会话已经不在了' });
  expect(SESSION_GONE_NOTICE).toBe('这个会话已经不在了');
  expect(row!.title).toBe('修 CI 超时');
  expect(row!.project).toBe('Cursor（未知目录）');
  expect(row!.originLabel).toBe('Cursor');
});

test('源文件已删除的会话照常打开，不算找不到', () => {
  const [row] = bookmarkRows([bm({ now: { sourceDeleted: true } })], IDENTITY_MASKER);
  expect(row!.missing).toBeNull();
  expect(row!.sourceDeleted).toBe(true);
  expect(row!.open.kind).toBe('link');
});

test('排序：按标记时间倒序，同一时间 id 大的在前', () => {
  const rows = bookmarkRows([
    bm({ id: 1, createdAt: at(11, 17, 21, 12) }),
    bm({ id: 2, createdAt: at(11, 22, 14, 5) }),
    bm({ id: 3, createdAt: at(11, 18, 9, 30) }),
    bm({ id: 4, createdAt: at(11, 22, 14, 5) }),
  ], IDENTITY_MASKER);
  expect(rows.map((r) => r.id)).toEqual([4, 2, 3, 1]);
});

// ---- masking ----

const KEY = 'sk-' + 'proj-' + 'FAKEFAKE0123456789abcdefTEST';
const TERM = 'Falcon' + 'Project';
const secretBookmark = (): Bookmark => bm({
  note: `别忘了 ${TERM}`,
  snapshot: { stepLabel: `Bash · curl -H "Authorization: Bearer ${KEY}"`, cwd: `D:/work/${TERM}`, sessionTitle: `部署 ${TERM}` },
  now: { sessionTitle: `部署 ${TERM}`, projectName: TERM },
});

test('遮蔽开着：会话标题、步骤摘要、工作目录、项目名遮蔽；备注不遮蔽', () => {
  const on = createPageMasker({ customTerms: [TERM], numbered: false });
  const [row] = bookmarkRows([secretBookmark()], on);
  expect(row!.title).not.toContain(TERM);
  expect(row!.title).toContain('已遮蔽');
  expect(row!.stepLabel).not.toContain(KEY);
  expect(row!.stepLabel!.startsWith('Bash · ')).toBe(true);
  expect(row!.cwd).not.toContain(TERM);
  expect(row!.project).not.toContain(TERM);
  expect(row!.note).toBe(`别忘了 ${TERM}`);
  expect(row!.noteText).toBe(`别忘了 ${TERM}`);
  const [plain] = bookmarkRows([secretBookmark()], IDENTITY_MASKER);
  expect(plain!.title).toBe(`部署 ${TERM}`);
  expect(plain!.stepLabel).toContain(KEY);
  expect(plain!.cwd).toBe(`D:/work/${TERM}`);
  expect(plain!.project).toBe(TERM);
});

// ---- filter ----

test('筛选：字面匹配备注、标题、步骤摘要、项目名，不区分 ASCII 大小写；空的不筛', () => {
  const rows = bookmarkRows([
    bm({ id: 1, note: 'Qwen 接入', nodeId: null }),
    bm({ id: 2, note: '', snapshot: { stepLabel: 'Edit · src/Store.ts' } }),
    bm({ id: 3, note: '看这里', now: { sessionTitle: '修登录 BUG', projectName: 'web-shop' } }),
  ], IDENTITY_MASKER);
  const ids = (q: string): number[] => filterBookmarkRows(rows, q).map((r) => r.id);
  expect(ids('')).toEqual([3, 2, 1]); // same time: the higher id first
  expect(ids('  ')).toEqual([3, 2, 1]);
  expect(ids('qwen')).toEqual([1]);
  expect(ids('STORE.TS')).toEqual([2]);
  expect(ids('bug')).toEqual([3]);
  expect(ids('WEB-SHOP')).toEqual([3]);
  expect(ids('看这')).toEqual([3]);
  expect(ids('s*.ts')).toEqual([]); // no wildcards
  expect(ids('src.Store')).toEqual([]); // `.` is literal
  // Only ASCII letters fold: a Kelvin sign or the dotless i do not match k or i.
  expect(ids('\u212Aw')).toEqual([]);
  // Matching never runs across two fields.
  expect(ids('接入修')).toEqual([]);
});

test('文字步骤的摘要在密钥中间被截断（服务端按 79 个字加 … 截）：遮蔽开着时不露出密钥的开头，筛选也找不到这一行', () => {
  // Invented key, assembled at run time; the cut falls inside it, as the server's stepLabel cuts (79 code points + …).
  const key = ['sk', 'proj', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'].join('-');
  const summary = `${'已经把超时调好了，'.repeat(7)}令牌 ${key}`;
  const label = `${[...summary].slice(0, 79).join('')}…`;
  const fragment = [...label].slice([...summary].indexOf('s', 60), 79).join('');
  expect(fragment.startsWith('sk-proj-')).toBe(true); // the label holds the key's first characters
  const on = createPageMasker({ customTerms: [], numbered: false });
  const text = bm({ id: 3, note: '', snapshot: { nodeKind: 'text', toolName: null, stepLabel: label } });
  const rows = bookmarkRows([text, bm({ id: 4, note: '别的' })], on);
  const row = rows.find((r) => r.id === 3)!;
  expect(row.stepLabel).not.toContain('sk-proj');
  expect(row.stepLabel).toContain('已遮蔽');
  expect(filterBookmarkRows(rows, fragment.slice(0, 11))).toEqual([]);
  expect(filterBookmarkRows(rows, 'sk-proj')).toEqual([]);
  // Off: shown as stored, found by it.
  const plain = bookmarkRows([text], IDENTITY_MASKER);
  expect(filterBookmarkRows(plain, fragment.slice(0, 11)).map((r) => r.id)).toEqual([3]);
});

test('筛选匹配页面上显示出来的文字：遮蔽开着时猜密钥试不出哪一行含有它；备注照样能搜', () => {
  const on = createPageMasker({ customTerms: [TERM], numbered: false });
  const rows = bookmarkRows([bm({ ...secretBookmark(), note: '部署那次' }), bm({ id: 2, note: '别的' })], on);
  expect(filterBookmarkRows(rows, TERM)).toEqual([]);
  expect(filterBookmarkRows(rows, KEY.slice(0, 12))).toEqual([]);
  expect(filterBookmarkRows(rows, '已遮蔽').map((r) => r.id)).toEqual([1]);
  expect(filterBookmarkRows(rows, '部署那次').map((r) => r.id)).toEqual([1]);
  const plain = bookmarkRows([bm({ ...secretBookmark(), note: '部署那次' })], IDENTITY_MASKER);
  expect(filterBookmarkRows(plain, TERM.toLowerCase()).map((r) => r.id)).toEqual([1]);
  // The note is never masked, so a term in the note is found with the switch on.
  const noted = bookmarkRows([bm({ note: `记得 ${TERM}` })], on);
  expect(filterBookmarkRows(noted, TERM).map((r) => r.id)).toEqual([1]);
});

// ---- the notice handed to the session page ----

test('提示交给会话页一次：到那个会话时留着，之后任何跳转都清掉', () => {
  const notice: SessionNotice = { sessionId: 's1', text: STEP_GONE_NOTICE, at: at(11, 22, 14, 0), arrived: false };
  const arrived = nextSessionNotice(notice, { page: 'session', sessionId: 's1' });
  expect(arrived).toEqual({ ...notice, arrived: true });
  expect(nextSessionNotice(arrived, { page: 'session', sessionId: 's1' })).toBeNull();
  expect(nextSessionNotice(arrived, { page: 'bookmarks' })).toBeNull();
  expect(nextSessionNotice(notice, { page: 'session', sessionId: 'other' })).toBeNull();
  expect(nextSessionNotice(null, { page: 'session', sessionId: 's1' })).toBeNull();
});

const plainClick: ClickLike = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

test('点击：会话不在了只在本页提示；步骤不在了普通点击把提示和时间交给会话页，带修饰键或中键的点击不交', () => {
  const [gone, stepGone, fine] = bookmarkRows([
    bm({ id: 3, createdAt: at(11, 23, 0, 0), now: { session: false, node: false, sessionTitle: null, projectName: null } }),
    bm({ id: 2, createdAt: at(11, 22, 0, 0), now: { node: false } }),
    bm({ id: 1, createdAt: at(11, 21, 0, 0) }),
  ], IDENTITY_MASKER);
  expect(bookmarkClick(gone!, plainClick)).toEqual({ kind: 'page-notice', text: SESSION_GONE_NOTICE });
  expect(bookmarkClick(gone!, { ...plainClick, ctrlKey: true })).toEqual({ kind: 'page-notice', text: SESSION_GONE_NOTICE });
  expect(bookmarkClick(stepGone!, plainClick)).toEqual({
    kind: 'session-notice', notice: { sessionId: 's1', text: STEP_GONE_NOTICE, at: at(11, 22, 14, 0) },
  });
  for (const mod of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    expect(bookmarkClick(stepGone!, { ...plainClick, ...mod }), JSON.stringify(mod)).toBeNull();
  }
  expect(bookmarkClick(fine!, plainClick)).toBeNull();
});

test('容器的点击：行上的链接和按钮把点击交给 bookmarkOpener，提示去本页或交给 App', () => {
  const [gone, stepGone] = bookmarkRows([
    bm({ id: 3, createdAt: at(11, 23, 0, 0), now: { session: false, node: false, sessionTitle: null, projectName: null } }),
    bm({ id: 2, createdAt: at(11, 22, 0, 0), now: { node: false } }),
  ], IDENTITY_MASKER);
  const pageNotices: string[] = [];
  const handed: Omit<SessionNotice, 'arrived'>[] = [];
  const onOpen = bookmarkOpener((t) => pageNotices.push(t), (n) => handed.push(n));
  // The row's clickable element, called the way React calls it.
  const clickRow = (row: typeof gone, click: ClickLike): void => {
    const li = BookmarkRow({ ...viewProps({ rows: [row!], total: 1, onOpen }), row: row! });
    const target = (li.props as { children: { props: { onClick?: (e: ClickLike) => void } }[] }).children[0]!;
    target.props.onClick!(click);
  };
  clickRow(gone, plainClick);
  expect(pageNotices).toEqual([SESSION_GONE_NOTICE]);
  expect(handed).toEqual([]);
  clickRow(stepGone, { ...plainClick, ctrlKey: true });
  expect(handed).toEqual([]);
  clickRow(stepGone, plainClick);
  expect(handed).toEqual([{ sessionId: 's1', text: STEP_GONE_NOTICE, at: at(11, 22, 14, 0) }]);
  expect(pageNotices).toEqual([SESSION_GONE_NOTICE]);
});

test('提示到达会话页一次：交出后，只有到了那个会话时会话页才拿到它（同一个对象），再跳一次就没了', () => {
  let notice: SessionNotice | null = { sessionId: 's1', text: STEP_GONE_NOTICE, at: at(11, 22, 14, 0), arrived: false };
  // Handed on the 书签 page: nothing for a session page yet.
  expect(sessionNoticeFor(notice, { page: 'bookmarks' })).toBeNull();
  notice = nextSessionNotice(notice, { page: 'session', sessionId: 's1' }); // the link's navigation
  const shown = sessionNoticeFor(notice, { page: 'session', sessionId: 's1' });
  expect(shown).toMatchObject({ text: STEP_GONE_NOTICE, at: at(11, 22, 14, 0) });
  expect(sessionNoticeFor(notice, { page: 'session', sessionId: 's1' })).toBe(shown); // re-renders: the same object
  expect(sessionNoticeFor(notice, { page: 'session', sessionId: 's2' })).toBeNull();
  notice = nextSessionNotice(notice, { page: 'session', sessionId: 's1', nodeId: 'n9' }); // any later navigation
  expect(sessionNoticeFor(notice, { page: 'session', sessionId: 's1' })).toBeNull();
});

// ---- edit / delete / undo against a fake api ----

function fakeWrites() {
  const calls: string[] = [];
  let failNext: Error | null = null;
  const settle = <T>(name: string, value: T): Promise<T> => {
    calls.push(name);
    const e = failNext;
    failNext = null;
    return e === null ? Promise.resolve(value) : Promise.reject(e);
  };
  const writes: BookmarkWrites = {
    patchBookmark: (id, note) => settle(`patch ${id} ${note}`, bm({ id, note, noteUpdatedAt: at(11, 24, 10, 0) })),
    deleteBookmark: (id) => settle(`delete ${id}`, { ok: true }),
    restoreBookmark: (id) => settle(`restore ${id}`, bm({ id })),
  };
  return { writes, calls, fail: (e: Error) => { failNext = e; } };
}

const httpError = (status: number, message: string): Error => Object.assign(new Error(message), { status });

test('改备注：回车或离开时保存，保存后马上显示新备注；没改不发请求；Escape 取消', async () => {
  const f = fakeWrites();
  const c = createBookmarkPageController(f.writes);
  const list = [bm({ id: 1, note: '旧的' })];
  c.startEdit(1, '旧的');
  expect(c.state().editing).toMatchObject({ id: 1, draft: '旧的' });
  c.setDraft('  旧的 ');
  await c.commitEdit();
  expect(f.calls).toEqual([]); // the same note once normalized
  expect(c.state().editing).toBeNull();

  c.startEdit(1, '旧的');
  c.setDraft('新的');
  const saving = c.commitEdit();
  await c.commitEdit(); // the blur after Enter: one request only
  await saving;
  expect(f.calls).toEqual(['patch 1 新的']);
  expect(c.state().editing).toBeNull();
  expect(c.visible(list).map((b) => b.note)).toEqual(['新的']);
  // The list catches up (its note changed at or after the save): the list's value is used from then on.
  c.listChanged([bm({ id: 1, note: '新的', noteUpdatedAt: at(11, 24, 10, 0) })]);
  expect(c.visible([bm({ id: 1, note: '别处又改了', noteUpdatedAt: at(11, 24, 11, 0) })])[0]!.note).toBe('别处又改了');

  c.startEdit(1, '新的');
  c.setDraft('不要了');
  c.cancelEdit();
  await c.commitEdit(); // the blur after Escape
  expect(f.calls).toEqual(['patch 1 新的']);
  expect(c.state().editing).toBeNull();
  c.close();
});

test('改备注：服务端 400 的提示显示在行里，编辑框留着', async () => {
  const f = fakeWrites();
  const c = createBookmarkPageController(f.writes);
  c.startEdit(1, '');
  c.setDraft('长'.repeat(201));
  f.fail(httpError(400, '备注最多 200 个字，现在有 201 个'));
  await c.commitEdit();
  expect(c.state().editing).toMatchObject({ id: 1, draft: '长'.repeat(201), saving: false, error: '备注最多 200 个字，现在有 201 个' });
  c.setDraft('短');
  expect(c.state().editing!.error).toBeNull();
  c.close();
});

test('删除的行：新列表里没有它了就不再记着，之后别处恢复了它会重新显示；列表里还有它（旧的）时仍藏着', async () => {
  const f = fakeWrites();
  const c = createBookmarkPageController(f.writes);
  await c.remove(1);
  const before = c.revision();
  c.listChanged([bm({ id: 1 }), bm({ id: 2 })]); // an older list that still has it
  expect(c.visible([bm({ id: 1 }), bm({ id: 2 })]).map((b) => b.id)).toEqual([2]);
  expect(c.revision()).toBe(before);
  c.listChanged([bm({ id: 2 })]); // the list after the delete
  expect(c.revision()).toBe(before + 1);
  // Restored in another tab: the next list has it again, and it shows.
  expect(c.visible([bm({ id: 1 }), bm({ id: 2 })]).map((b) => b.id)).toEqual([1, 2]);
  c.close();
});

test('删除：行马上消失，出现撤销 6 秒；撤销调 restore，行回来', async () => {
  vi.useFakeTimers();
  const f = fakeWrites();
  const c = createBookmarkPageController(f.writes);
  const changes = vi.fn();
  c.subscribe(changes);
  const list = [bm({ id: 1 }), bm({ id: 2 })];
  const removing = c.remove(1);
  expect(c.visible(list).map((b) => b.id)).toEqual([2]);
  expect(c.state().toast).toEqual({ id: 1 });
  await removing;
  expect(f.calls).toEqual(['delete 1']);
  await c.undo();
  expect(f.calls).toEqual(['delete 1', 'restore 1']);
  expect(c.state().toast).toBeNull();
  expect(c.visible(list).map((b) => b.id)).toEqual([1, 2]);
  expect(changes).toHaveBeenCalled();

  await c.remove(2);
  expect(BOOKMARK_UNDO_MS).toBe(6_000);
  await vi.advanceTimersByTimeAsync(5_999);
  expect(c.state().toast).toEqual({ id: 2 });
  await vi.advanceTimersByTimeAsync(1);
  expect(c.state().toast).toBeNull();
  await c.undo(); // nothing to undo any more
  expect(f.calls).toEqual(['delete 1', 'restore 1', 'delete 2']);
  c.close();
});

test('撤销时列表已经没有它了：恢复的回答先显示，下一份有它的列表接手；add 的书签列表有了就不再单独记着', async () => {
  const f = fakeWrites();
  const c = createBookmarkPageController(f.writes);
  await c.remove(1);
  c.listChanged([bm({ id: 2 })]); // the list after the delete
  await c.undo();
  expect(c.visible([bm({ id: 2 })]).map((b) => b.id)).toEqual([2, 1]);
  c.listChanged([bm({ id: 1 }), bm({ id: 2 })]);
  expect(c.visible([bm({ id: 2 })]).map((b) => b.id)).toEqual([2]); // the list rules from here
  c.add(bm({ id: 3 }));
  expect(c.visible([bm({ id: 2 })]).map((b) => b.id)).toEqual([2, 3]);
  await c.remove(3, false); // no 撤销 for this one
  expect(c.state().toast).toBeNull();
  c.listChanged([bm({ id: 2 })]);
  expect(c.visible([bm({ id: 2 })]).map((b) => b.id)).toEqual([2]);
  c.close();
});

test('第二次删除替换第一个撤销；第一个仍是删除的', async () => {
  vi.useFakeTimers();
  const f = fakeWrites();
  const c = createBookmarkPageController(f.writes);
  const list = [bm({ id: 1 }), bm({ id: 2 }), bm({ id: 3 })];
  await c.remove(1);
  await vi.advanceTimersByTimeAsync(4_000);
  await c.remove(2);
  expect(c.state().toast).toEqual({ id: 2 });
  await vi.advanceTimersByTimeAsync(4_000); // the first toast's time is over, the second's is not
  expect(c.state().toast).toEqual({ id: 2 });
  await c.undo();
  expect(f.calls).toEqual(['delete 1', 'delete 2', 'restore 2']);
  expect(c.visible(list).map((b) => b.id)).toEqual([2, 3]);
  c.close();
});

test('撤销等删除的请求先回来；删除失败时行回来并说明', async () => {
  const f = fakeWrites();
  let finish: (() => void) | null = null;
  const writes: BookmarkWrites = {
    ...f.writes,
    deleteBookmark: (id) => { f.calls.push(`delete ${id}`); return new Promise((r) => { finish = () => r({ ok: true }); }); },
  };
  const c = createBookmarkPageController(writes);
  const removing = c.remove(1);
  const undoing = c.undo();
  await Promise.resolve();
  expect(f.calls).toEqual(['delete 1']);
  finish!();
  await removing;
  await undoing;
  expect(f.calls).toEqual(['delete 1', 'restore 1']);

  const g = fakeWrites();
  const d = createBookmarkPageController(g.writes);
  g.fail(httpError(404, '找不到这个书签'));
  await d.remove(5);
  expect(d.visible([bm({ id: 5 })]).map((b) => b.id)).toEqual([5]);
  expect(d.state().toast).toBeNull();
  expect(d.state().error).toBe('找不到这个书签');
  c.close();
  d.close();
});

// ---- the page's markup ----

test('空的：一句话说明怎么标', () => {
  expect(BOOKMARKS_EMPTY_TEXT).toBe('还没有书签。在会话页的工具栏收藏会话，在每一步的详情里收藏这一步。');
  const html = renderToStaticMarkup(createElement(BookmarksView, viewProps({ rows: [], total: 0 })));
  expect(html).toContain('书签（0）');
  expect(html).toContain(BOOKMARKS_EMPTY_TEXT);
});

function viewProps(over: Partial<Parameters<typeof BookmarksView>[0]> = {}): Parameters<typeof BookmarksView>[0] {
  return {
    rows: [], total: 0, loading: false, failed: false, query: '', onQuery: () => {}, editing: null, toast: null, error: null,
    notice: null, onOpen: () => {}, onEdit: () => {}, onDraft: () => {}, onCommit: () => {}, onCancel: () => {},
    onDelete: () => {}, onUndo: () => {}, ...over,
  };
}

test('行：备注、种类、时间、步骤摘要、项目 · 来源 · “标题”、找不到的标记；筛选框的提示', () => {
  const rows = bookmarkRows([
    bm({ id: 1, nodeId: null, note: '', createdAt: at(11, 18, 9, 30) }),
    bm({ id: 2, now: { node: false } }),
    bm({ id: 3, now: { session: false, node: false, sessionTitle: null, projectName: null } }),
  ], IDENTITY_MASKER);
  const html = renderToStaticMarkup(createElement(BookmarksView, viewProps({ rows, total: 3 })));
  expect(html).toContain('书签（3）');
  expect(html).toContain(`placeholder="${BOOKMARK_FILTER_PLACEHOLDER}"`);
  expect(BOOKMARK_FILTER_PLACEHOLDER).toBe('筛选：备注、标题、步骤…');
  expect(html).toContain('（没有备注）');
  expect(html).toContain('会话');
  expect(html).toContain('步骤');
  expect(html).toContain('11-18 09:30');
  expect(html).toContain('Bash · npm test -- --testTimeout=20000');
  expect(html).toContain('agent-canvas · Claude Code · “修 CI 超时（新标题）”');
  expect(html).toContain('找不到这一步');
  expect(html).toContain('找不到这个会话');
  expect(html).toContain('href="#/s/s1"');
  expect(html).toContain('改备注');
  expect(html).toContain('删除');
  // The missing session is not a link.
  expect(html.match(/<a /g)?.length).toBe(2);
});

test('筛不出时说明；撤销提示；页面提示', () => {
  const rows = bookmarkRows([bm()], IDENTITY_MASKER);
  const html = renderToStaticMarkup(createElement(BookmarksView, viewProps({
    rows: [], total: rows.length, query: 'zzz', toast: { id: 1 }, notice: SESSION_GONE_NOTICE,
  })));
  expect(html).toContain('没有符合筛选的书签');
  expect(html).toContain('撤销');
  expect(html).toContain(SESSION_GONE_NOTICE);
  expect(html).not.toContain(BOOKMARKS_EMPTY_TEXT);
});

test('编辑中：行里是输入框，带服务端的提示', () => {
  const rows = bookmarkRows([bm({ id: 4 })], IDENTITY_MASKER);
  const html = renderToStaticMarkup(createElement(BookmarksView, viewProps({
    rows, total: 1, editing: { id: 4, original: '修好 CI 超时的那一步', draft: '草稿', saving: false, error: '备注最多 200 个字，现在有 201 个' },
  })));
  expect(html).toMatch(/<input[^>]*value="草稿"/);
  expect(html).toContain('备注最多 200 个字，现在有 201 个');
});

// ---- the api calls and the live list ----

test('api：每个写请求都带 JSON 体（没有内容时是 {}）和 Content-Type', async () => {
  const seen: { url: string; method: string; type: string | null; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    seen.push({ url, method: init.method ?? 'GET', type: headers.get('content-type'), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
    if (url === '/api/bookmarks' && init.method === 'POST') {
      return new Response(JSON.stringify({ error: '已经收藏过了', bookmark: bm({ id: 9 }) }), { status: 409 });
    }
    if (init.method === 'PATCH') return new Response(JSON.stringify({ error: '备注最多 200 个字，现在有 201 个' }), { status: 400 });
    if (init.method === undefined) return new Response(JSON.stringify({ bookmarks: [bm({ id: 3 })] }), { status: 200 });
    return new Response(JSON.stringify(init.method === 'DELETE' ? { ok: true } : bm({ id: 3 })), { status: 200 });
  }));
  expect((await api.bookmarks()).map((b) => b.id)).toEqual([3]);
  await api.bookmarks('a b');
  expect(await api.createBookmark('s1', null, '记一下')).toMatchObject({ created: false, bookmark: { id: 9 } });
  await expect(api.patchBookmark(3, '长')).rejects.toMatchObject({ status: 400, message: '备注最多 200 个字，现在有 201 个' });
  await api.deleteBookmark(3);
  await api.restoreBookmark(3);
  expect(seen).toEqual([
    { url: '/api/bookmarks', method: 'GET', type: null, body: undefined },
    { url: '/api/bookmarks?sessionId=a%20b', method: 'GET', type: null, body: undefined },
    { url: '/api/bookmarks', method: 'POST', type: 'application/json', body: { sessionId: 's1', nodeId: null, note: '记一下' } },
    { url: '/api/bookmarks/3', method: 'PATCH', type: 'application/json', body: { note: '长' } },
    { url: '/api/bookmarks/3', method: 'DELETE', type: 'application/json', body: {} },
    { url: '/api/bookmarks/3/restore', method: 'POST', type: 'application/json', body: {} },
  ]);
});

test('api：409 没带书签时，错误用服务端的文字', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: '已经收藏过了' }), { status: 409 })));
  await expect(api.createBookmark('s1', 'n1')).rejects.toMatchObject({ status: 409, message: '已经收藏过了' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 409 })));
  await expect(api.createBookmark('s1', 'n1')).rejects.toMatchObject({ status: 409, message: '/api/bookmarks: HTTP 409' });
});

test('api：新建成功是 created true', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(bm({ id: 4 })), { status: 201 })));
  expect(await api.createBookmark('s1', 'n1')).toMatchObject({ created: true, bookmark: { id: 4 } });
});

test('live：订阅后取一次，收到 bookmarks 推送就重新取；断线重连后再取', async () => {
  vi.useFakeTimers();
  const sock = fakeSocket();
  let n = 0;
  const fetchBookmarks = vi.fn(async () => { n += 1; return [bm({ id: n })]; });
  const states: BookmarksLiveState[] = [];
  const live = openLiveBookmarks((s) => states.push(s), { fetchBookmarks, createSocket: () => sock });
  await vi.advanceTimersByTimeAsync(0);
  expect(sock.sent[0]).toEqual({ type: 'subscribe', scope: 'sessions' });
  expect(states.at(-1)).toEqual({ bookmarks: [bm({ id: 1 })], failed: false });
  sock.receive({ type: 'today', usage: {} });
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchBookmarks).toHaveBeenCalledTimes(1);
  sock.receive({ type: 'bookmarks', sessionIds: ['s9'] });
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchBookmarks).toHaveBeenCalledTimes(2);
  expect(states.at(-1)!.bookmarks!.map((b) => b.id)).toEqual([2]);
  sock.drop();
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetchBookmarks).toHaveBeenCalledTimes(3);
  live.close();
});

test('live：取的过程中又来推送，旧的答复不用，再取一次', async () => {
  vi.useFakeTimers();
  const sock = fakeSocket();
  const pending: ((v: Bookmark[]) => void)[] = [];
  const fetchBookmarks = vi.fn(() => new Promise<Bookmark[]>((r) => pending.push(r)));
  const states: BookmarksLiveState[] = [];
  const live = openLiveBookmarks((s) => states.push(s), { fetchBookmarks, createSocket: () => sock });
  await vi.advanceTimersByTimeAsync(0);
  expect(pending).toHaveLength(1);
  sock.receive({ type: 'bookmarks', sessionIds: ['s1'] });
  pending[0]!([bm({ id: 1, note: '旧' })]);
  await vi.advanceTimersByTimeAsync(0);
  expect(states).toEqual([]);
  expect(pending).toHaveLength(2);
  pending[1]!([bm({ id: 1, note: '新' })]);
  await vi.advanceTimersByTimeAsync(0);
  expect(states.at(-1)!.bookmarks![0]!.note).toBe('新');
  live.close();
});

test('live：只看一个会话时，只有这个会话的推送才重新取；失败时留着上一次的并重试', async () => {
  vi.useFakeTimers();
  const sock = fakeSocket();
  let fail = false;
  const fetchBookmarks = vi.fn(async () => { if (fail) throw new Error('down'); return [bm()]; });
  const states: BookmarksLiveState[] = [];
  const live = openLiveBookmarks((s) => states.push(s), { fetchBookmarks, sessionId: 's1', createSocket: () => sock });
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchBookmarks).toHaveBeenCalledTimes(1);
  sock.receive({ type: 'bookmarks', sessionIds: ['other'] });
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchBookmarks).toHaveBeenCalledTimes(1);
  fail = true;
  sock.receive({ type: 'bookmarks', sessionIds: ['other', 's1'] });
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchBookmarks).toHaveBeenCalledTimes(2);
  expect(states.at(-1)).toEqual({ bookmarks: [bm()], failed: true });
  fail = false;
  await vi.advanceTimersByTimeAsync(500);
  expect(fetchBookmarks).toHaveBeenCalledTimes(3);
  expect(states.at(-1)).toEqual({ bookmarks: [bm()], failed: false });
  live.close();
});

test('live：默认取的是 api.bookmarks(sessionId)', async () => {
  vi.useFakeTimers();
  const sock = fakeSocket();
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return new Response(JSON.stringify({ bookmarks: [] }), { status: 200 }); }));
  const live = openLiveBookmarks(() => {}, { sessionId: 's 1', createSocket: () => sock });
  await vi.advanceTimersByTimeAsync(0);
  expect(urls).toEqual(['/api/bookmarks?sessionId=s%201']);
  live.close();
});
