/**
 * The 书签 page's view logic (bookmarks spec 4 and 6): rows from the API's bookmarks (labels, order, the masked texts,
 * what a click does), the filter, the notice handed to the session page, and the page's writes (note edit, delete with
 * undo) as a controller that does not need React. Pure apart from the controller's timer; the page is pages/Bookmarks.tsx,
 * the live list client.ts openLiveBookmarks.
 */
import { normalizeBookmarkNote, projectDisplayName, type Bookmark, type Origin } from '@agent-canvas/shared';
import { writeErrorText } from './attention';
import { ORIGIN_LOOK } from './home';
import type { PageMasker } from './masking';
import { sessionHash, sessionNodeHash, type Route } from './route';
import type { SessionBookmarks } from './sessionSource';

export const NO_NOTE_TEXT = '（没有备注）';
export const BOOKMARKS_EMPTY_TEXT = '还没有书签。在会话页的工具栏收藏会话，在每一步的详情里收藏这一步。';
export const BOOKMARK_FILTER_PLACEHOLDER = '筛选：备注、标题、步骤…';
/** Shown by the session page after a click on a bookmark whose step is gone. */
export const STEP_GONE_NOTICE = '这一步已经不在了';
/** Shown on the 书签 page after a click on a bookmark whose session is gone (nothing is opened). */
export const SESSION_GONE_NOTICE = '这个会话已经不在了';
/** How long a deleted bookmark's 撤销 stays. */
export const BOOKMARK_UNDO_MS = 6_000;

export const bookmarksTitle = (count: number): string => `书签（${count}）`;

const pad = (n: number): string => String(n).padStart(2, '0');

/** When it was bookmarked, in local time: `MM-DD HH:mm` ('' when the time cannot be read). */
export function bookmarkTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** What a click on a row does. */
export type BookmarkOpen =
  /** Open the session, or the session at the step. */
  | { kind: 'link'; href: string }
  /** The step is gone: open the session and have it say `notice`. */
  /** `at`: the step's time from the snapshot (the session page shows the turn nearest it). */
  | { kind: 'missing-step'; href: string; notice: string; at: string | null }
  /** The session is gone: open nothing, say `notice` on this page. */
  | { kind: 'missing-session'; notice: string };

export interface BookmarkRowView {
  id: number;
  sessionId: string;
  nodeId: string | null;
  kind: 'session' | 'step';
  kindLabel: '会话' | '步骤';
  /** The note as stored (never masked: the user's own words; the editor starts from it). */
  note: string;
  /** The note, or NO_NOTE_TEXT. */
  noteText: string;
  hasNote: boolean;
  createdAt: string;
  /** createdAt as `MM-DD HH:mm`, local time. */
  time: string;
  /** A step's one-line label from the snapshot (masked with the switch on); null for a session bookmark. */
  stepLabel: string | null;
  /** The project's name: the current one, else the snapshot's (masked with the switch on). */
  project: string;
  /** The working directory from the snapshot (masked with the switch on), for the project's tooltip. */
  cwd: string | null;
  origin: Origin;
  originLabel: string;
  /** The session's current title when the session exists, else the snapshot's (masked with the switch on). */
  title: string;
  /** What cannot be found any more (spec 6); a deleted source file does not count. */
  missing: 'step' | 'session' | null;
  badge: '找不到这一步' | '找不到这个会话' | null;
  sourceDeleted: boolean;
  open: BookmarkOpen;
  /** The texts the filter matches (as displayed, so masked with the switch on, plus the note), ASCII lower-cased. */
  haystack: string;
}

/** ASCII letters only: no other character folds (so no Kelvin sign matching k, no dotless i matching i). */
const lowerAscii = (s: string): string => s.replace(/[A-Z]+/g, (c) => c.toLowerCase());

/** Between the fields of the haystack: a character no query typed in a one-line box contains. */
const FIELD_SEPARATOR = '\n';

function rowOf(b: Bookmark, m: PageMasker): BookmarkRowView {
  const s = b.snapshot;
  const step = b.nodeId !== null;
  const missing = !b.now.session ? 'session' : step && !b.now.node ? 'step' : null;
  const rawTitle = b.now.session && b.now.sessionTitle !== null ? b.now.sessionTitle : s.sessionTitle;
  const rawProject = b.now.projectName ?? projectDisplayName({ id: s.projectId, cwd: s.cwd });
  const title = m.title(rawTitle);
  const stepLabel = step && s.stepLabel !== null ? m.summary(s.stepLabel) : null;
  const project = m.text(rawProject);
  const open: BookmarkOpen = missing === 'session'
    ? { kind: 'missing-session', notice: SESSION_GONE_NOTICE }
    : missing === 'step'
      ? { kind: 'missing-step', href: sessionHash(b.sessionId), notice: STEP_GONE_NOTICE, at: s.nodeAt }
      : { kind: 'link', href: b.nodeId === null ? sessionHash(b.sessionId) : sessionNodeHash(b.sessionId, b.nodeId) };
  return {
    id: b.id,
    sessionId: b.sessionId,
    nodeId: b.nodeId,
    kind: step ? 'step' : 'session',
    kindLabel: step ? '步骤' : '会话',
    note: b.note,
    noteText: b.note === '' ? NO_NOTE_TEXT : b.note,
    hasNote: b.note !== '',
    createdAt: b.createdAt,
    time: bookmarkTime(b.createdAt),
    stepLabel,
    project,
    cwd: s.cwd === null ? null : m.text(s.cwd),
    origin: s.origin,
    originLabel: ORIGIN_LOOK[s.origin]?.label ?? s.origin,
    title,
    missing,
    badge: missing === 'session' ? '找不到这个会话' : missing === 'step' ? '找不到这一步' : null,
    sourceDeleted: b.now.sourceDeleted,
    open,
    haystack: lowerAscii([b.note, title, stepLabel ?? '', project].join(FIELD_SEPARATOR)),
  };
}

/** Newest first: by createdAt descending, then id descending (the server's order, kept whatever the list's order). */
function newestFirst(a: Bookmark, b: Bookmark): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return b.id - a.id;
}

/** The page's rows, newest first; `m` masks the session title, step label, cwd and project name, never the note. */
export function bookmarkRows(list: readonly Bookmark[], m: PageMasker): BookmarkRowView[] {
  return [...list].sort(newestFirst).map((b) => rowOf(b, m));
}

/**
 * The rows whose note, title, step label or project name (as displayed) contains `query` literally, ASCII letters
 * compared without case; a blank query keeps every row. A match never runs across two fields.
 */
export function filterBookmarkRows(rows: readonly BookmarkRowView[], query: string): BookmarkRowView[] {
  const q = lowerAscii(query.trim());
  if (q === '') return [...rows];
  return rows.filter((r) => r.haystack.includes(q));
}

/**
 * A notice for the session page (a bookmark's step was gone): set before the app navigates to `sessionId`, kept by the
 * navigation that arrives there (`arrived` true: the session page shows it), dropped by any other navigation and by the
 * next one after arriving. So it is shown once.
 */
export interface SessionNotice {
  sessionId: string;
  text: string;
  /** The gone step's time (the snapshot's nodeAt): the session page shows the turn nearest it. */
  at: string | null;
  arrived: boolean;
}

export function nextSessionNotice(notice: SessionNotice | null, route: Route): SessionNotice | null {
  if (notice === null || notice.arrived) return null;
  return route.page === 'session' && route.sessionId === notice.sessionId ? { ...notice, arrived: true } : null;
}

/** What the session page at `route` gets: the notice once it has arrived there (the same object), else null. */
export function sessionNoticeFor(notice: SessionNotice | null, route: Route): SessionNotice | null {
  return notice !== null && notice.arrived && route.page === 'session' && route.sessionId === notice.sessionId ? notice : null;
}

/** The parts of a click that say whether it opens the link here (a plain left click) or elsewhere. */
export interface ClickLike {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * What a click on a row does besides following its link: a gone session says its notice on this page; a gone step hands
 * its notice (and the step's time) to the session page, but only for a plain left click (a click that opens the link in
 * another tab or window leaves this tab where it is). null: nothing.
 */
export function bookmarkClick(
  row: BookmarkRowView, click: ClickLike,
): { kind: 'page-notice'; text: string } | { kind: 'session-notice'; notice: Omit<SessionNotice, 'arrived'> } | null {
  if (row.open.kind === 'missing-session') return { kind: 'page-notice', text: row.open.notice };
  if (row.open.kind !== 'missing-step') return null;
  if (click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return null;
  return { kind: 'session-notice', notice: { sessionId: row.sessionId, text: row.open.notice, at: row.open.at } };
}

/** The 书签 page's row click handler: bookmarkClick's answer sent to the page's notice or to the app (onStepGone). */
export function bookmarkOpener(
  setPageNotice: (text: string) => void, onStepGone: (notice: Omit<SessionNotice, 'arrived'>) => void,
): (row: BookmarkRowView, click: ClickLike) => void {
  return (row, click) => {
    const r = bookmarkClick(row, click);
    if (r?.kind === 'page-notice') setPageNotice(r.text);
    else if (r?.kind === 'session-notice') onStepGone(r.notice);
  };
}

// ---- the page's writes ----

/** The API calls the page's writes use (client.ts api). */
export interface BookmarkWrites {
  patchBookmark(id: number, note: string): Promise<Bookmark>;
  deleteBookmark(id: number): Promise<unknown>;
  restoreBookmark(id: number): Promise<Bookmark>;
}

export interface BookmarkEditing {
  id: number;
  /** The note when editing started: a draft that normalizes to it is not sent. */
  original: string;
  draft: string;
  saving: boolean;
  /** The server's message for a rejected note (or why the request failed). */
  error: string | null;
}

export interface BookmarkPageState {
  editing: BookmarkEditing | null;
  /** The last delete's 撤销, for BOOKMARK_UNDO_MS. */
  toast: { id: number } | null;
  /** A delete or an undo that failed. */
  error: string | null;
}

export interface BookmarkPageController {
  state(): BookmarkPageState;
  subscribe(fn: () => void): () => void;
  /** Grows whenever visible() would answer differently for the same list (a row hidden or back, a note saved). */
  revision(): number;
  /**
   * The list as shown: without the rows deleted here, with the notes saved here that the list does not have yet, then
   * the bookmarks made or restored here that it does not have yet (see add).
   */
  visible(list: readonly Bookmark[]): Bookmark[];
  /**
   * A new list arrived: the saved notes it already has (or whose bookmark it no longer has) are forgotten, and so are the
   * rows deleted here that it no longer has (so one restored elsewhere later shows again) and the bookmarks added here
   * that it has.
   */
  listChanged(list: readonly Bookmark[]): void;
  /** A bookmark made here (or found made already): shown until a list has it. */
  add(b: Bookmark): void;
  startEdit(id: number, note: string): void;
  setDraft(text: string): void;
  cancelEdit(): void;
  /** Enter or leaving the box: saves the draft (once, even when both happen); a draft equal to the note is not sent. */
  commitEdit(): Promise<void>;
  /**
   * Hides the row at once, shows 撤销 (replacing an earlier one; that delete stays), deletes on the server. `undoable`
   * false: no 撤销 (an earlier one stays).
   */
  remove(id: number, undoable?: boolean): Promise<void>;
  /** Restores the bookmark of the 撤销 shown, after its delete has been answered; shown again at once (see add). */
  undo(): Promise<void>;
  dismissToast(): void;
  /** Stops the 撤销 timer and drops the listeners (not final: React's development double mount subscribes again). */
  close(): void;
}

/**
 * The page's writes. A delete hides its row at once (back with an error if the server refuses); a saved note is shown
 * at once and kept over the list until the list has it (its noteUpdatedAt at or after the saved one). The list itself
 * comes from the live watcher, which refetches on the push every write causes.
 */
export function createBookmarkPageController(api: BookmarkWrites): BookmarkPageController {
  let state: BookmarkPageState = { editing: null, toast: null, error: null };
  const removed = new Set<number>();
  /** Delete requests in flight, by id: an undo waits for its delete. */
  const deleting = new Map<number, Promise<boolean>>();
  const saved = new Map<number, Bookmark>();
  /** Made or restored here, until a list has them (by id). */
  const added = new Map<number, Bookmark>();
  const listeners = new Set<() => void>();
  let revision = 0;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  const set = (next: Partial<BookmarkPageState>): void => {
    state = { ...state, ...next };
    for (const fn of [...listeners]) fn();
  };
  const clearToastTimer = (): void => {
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = null;
  };
  /** The list has caught up with a saved note: its own note changed at or after the save. */
  const caughtUp = (b: Bookmark, mine: Bookmark): boolean =>
    b.noteUpdatedAt !== null && mine.noteUpdatedAt !== null && b.noteUpdatedAt >= mine.noteUpdatedAt;
  return {
    state: () => state,
    revision: () => revision,
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    visible(list) {
      const out: Bookmark[] = [];
      const inList = new Set<number>();
      const shown = (b: Bookmark): void => {
        if (removed.has(b.id)) return;
        const mine = saved.get(b.id);
        out.push(mine !== undefined && !caughtUp(b, mine) ? { ...b, note: mine.note, noteUpdatedAt: mine.noteUpdatedAt } : b);
      };
      for (const b of list) {
        inList.add(b.id);
        shown(b);
      }
      for (const b of added.values()) if (!inList.has(b.id)) shown(b);
      return out;
    },
    listChanged(list) {
      const byId = new Map(list.map((b) => [b.id, b]));
      for (const [id, mine] of saved) {
        const b = byId.get(id);
        // A bookmark only added here is in no list yet: its saved note stays until one has it.
        if (b === undefined ? !added.has(id) : caughtUp(b, mine)) saved.delete(id);
      }
      let dropped = false;
      for (const id of added.keys()) {
        if (byId.has(id)) { added.delete(id); dropped = true; }
      }
      for (const id of removed) {
        if (!byId.has(id)) { removed.delete(id); dropped = true; }
      }
      if (dropped) revision += 1;
    },
    add(b) {
      added.set(b.id, b);
      revision += 1;
      set({});
    },
    startEdit(id, note) {
      set({ editing: { id, original: note, draft: note, saving: false, error: null } });
    },
    setDraft(text) {
      if (state.editing === null || state.editing.saving) return;
      set({ editing: { ...state.editing, draft: text, error: null } });
    },
    cancelEdit() {
      set({ editing: null });
    },
    async commitEdit() {
      const e = state.editing;
      if (e === null || e.saving) return;
      const normalized = normalizeBookmarkNote(e.draft);
      if (normalized.ok && normalized.note === e.original) { set({ editing: null }); return; }
      set({ editing: { ...e, saving: true, error: null } });
      try {
        const b = await api.patchBookmark(e.id, e.draft);
        saved.set(b.id, b);
        revision += 1;
        if (state.editing?.id === e.id) set({ editing: null });
        else set({});
      } catch (err) {
        if (state.editing?.id === e.id) set({ editing: { ...state.editing, saving: false, error: writeErrorText(err) } });
        else set({ error: writeErrorText(err) }); // another row is being edited now: say it on the page
      }
    },
    async remove(id, undoable = true) {
      if (removed.has(id)) return;
      removed.add(id);
      // Hidden by `removed` until a list without it arrives; then gone (an undo adds the restored one back).
      const wasAdded = added.get(id);
      added.delete(id);
      revision += 1;
      if (state.editing?.id === id) set({ editing: null });
      if (undoable) {
        clearToastTimer();
        set({ toast: { id }, error: null });
        toastTimer = setTimeout(() => {
          toastTimer = null;
          if (state.toast?.id === id) set({ toast: null });
        }, BOOKMARK_UNDO_MS);
      } else {
        set({ error: null });
      }
      const request = api.deleteBookmark(id).then(() => true, (err: unknown) => {
        removed.delete(id);
        if (wasAdded !== undefined && !added.has(id)) added.set(id, wasAdded);
        revision += 1;
        if (state.toast?.id === id) { clearToastTimer(); set({ toast: null }); }
        set({ error: writeErrorText(err) });
        return false;
      });
      deleting.set(id, request);
      await request;
      if (deleting.get(id) === request) deleting.delete(id);
    },
    async undo() {
      const toast = state.toast;
      if (toast === null) return;
      clearToastTimer();
      set({ toast: null, error: null });
      const pending = deleting.get(toast.id);
      if (pending !== undefined && !(await pending)) return; // the delete failed: the row is back already
      try {
        const restored = await api.restoreBookmark(toast.id);
        removed.delete(toast.id);
        // Shown at once, also when the list without it arrived already (until the next list has it again).
        added.set(restored.id, restored);
        revision += 1;
        set({});
      } catch (err) {
        set({ error: `没能撤销：${writeErrorText(err)}` });
      }
    },
    dismissToast() {
      clearToastTimer();
      set({ toast: null });
    },
    close() {
      clearToastTimer();
      listeners.clear();
    },
  };
}

// ---- marking on the session page (bookmarks spec 5) ----

export const SESSION_MARK_TEXT = '收藏会话';
export const STEP_MARK_TEXT = '收藏这一步';
export const MARKED_TEXT = '已收藏';
/** Beside the button after un-marking a bookmark that had a note, with 撤销 (BOOKMARK_UNDO_MS). */
export const NOTE_GOES_TEXT = '备注会一起删除';

/** What the session page's toolbar and drawer read and write: its source's bookmarks (sessionSource.ts). */
export type SessionBookmarkWrites = Pick<SessionBookmarks, 'create' | 'patch' | 'remove' | 'restore'>;

/** One place's button and note box (the session: nodeId null; a step: its node id). */
export interface MarkState {
  /** The first list has arrived (until then the button cannot tell, and is disabled). */
  ready: boolean;
  /** The bookmark shown (null: not bookmarked). */
  bookmark: Bookmark | null;
  /** Marking or un-marking is in flight. */
  busy: boolean;
  /** The note box's edit, while it is this bookmark's. */
  editing: BookmarkEditing | null;
  /** 「备注会一起删除」 with 撤销 shows beside this button. */
  undo: boolean;
  /** Why marking, un-marking or undoing failed. */
  error: string | null;
  /** Marked here just now: the note box takes the focus when it appears. */
  fresh: boolean;
}

export interface SessionBookmarkController {
  subscribe(fn: () => void): () => void;
  /** Grows with every change (for useSyncExternalStore: read stateOf after it). */
  version(): number;
  /** The session's bookmarks as shown (the list with what was done here); the same array until that changes. */
  shown(): readonly Bookmark[];
  /** A list from SessionBookmarks.watch (null: none yet). */
  setList(list: readonly Bookmark[] | null): void;
  stateOf(nodeId: string | null): MarkState;
  /**
   * The button: marks the place, or un-marks it (at once; with a note, 「备注会一起删除」 and 撤销 show beside the
   * button). Ignored while the place's request is in flight or before the first list.
   */
  toggle(nodeId: string | null): Promise<void>;
  /** The note box got the focus (or a key) while not editing: edit its bookmark's note. */
  startEdit(nodeId: string | null): void;
  setDraft(text: string): void;
  /** Enter or leaving the box: saves once; a note equal to the stored one once normalized is not sent. */
  commitEdit(): Promise<void>;
  cancelEdit(): void;
  /** 撤销: restores the bookmark un-marked last (the 书签 page's restore path). */
  undo(): Promise<void>;
  /** Stops the 撤销 timer and drops the listeners (not final: a later subscribe listens again). */
  close(): void;
}

/** A place's key: the step's node id, '' for the session. */
const placeKey = (nodeId: string | null): string => nodeId ?? '';

/**
 * The session page's marking, on top of the 书签 page's controller (createBookmarkPageController: note edits, delete
 * with undo, the overlay of what was done here until the list has it). The list comes from SessionBookmarks.watch.
 */
export function createSessionBookmarkController(b: SessionBookmarkWrites): SessionBookmarkController {
  const page = createBookmarkPageController({ patchBookmark: b.patch, deleteBookmark: b.remove, restoreBookmark: b.restore });
  let list: readonly Bookmark[] | null = null;
  /** Places whose create or delete is in flight. */
  const busy = new Set<string>();
  /** The place of the page's 撤销 (its toast's id is that place's bookmark). */
  let undoPlace: string | null = null;
  /** The place whose last delete or undo went through the page (its error belongs there). */
  let pagePlace: string | null = null;
  let failure: { place: string; text: string } | null = null;
  let fresh: string | null = null;
  let version = 0;
  let cache: { list: readonly Bookmark[] | null; revision: number; out: readonly Bookmark[] } | null = null;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    version += 1;
    for (const fn of [...listeners]) fn();
  };
  let unhook: (() => void) | null = null;
  const shown = (): readonly Bookmark[] => {
    const revision = page.revision();
    if (cache === null || cache.list !== list || cache.revision !== revision) {
      cache = { list, revision, out: page.visible(list ?? []) };
    }
    return cache.out;
  };
  const bookmarkOf = (place: string): Bookmark | null => shown().find((x) => placeKey(x.nodeId) === place) ?? null;
  return {
    subscribe(fn) {
      listeners.add(fn);
      unhook ??= page.subscribe(notify);
      return () => void listeners.delete(fn);
    },
    version: () => version,
    shown,
    setList(next) {
      list = next;
      if (next !== null) page.listChanged(next);
      notify();
    },
    stateOf(nodeId) {
      const place = placeKey(nodeId);
      const bookmark = bookmarkOf(place);
      const s = page.state();
      return {
        ready: list !== null,
        bookmark,
        busy: busy.has(place),
        editing: bookmark !== null && s.editing?.id === bookmark.id ? s.editing : null,
        undo: undoPlace === place && s.toast !== null,
        error: failure?.place === place ? failure.text : pagePlace === place ? s.error : null,
        fresh: fresh === place,
      };
    },
    async toggle(nodeId) {
      const place = placeKey(nodeId);
      if (list === null || busy.has(place)) return;
      failure = null;
      fresh = null;
      const current = bookmarkOf(place);
      busy.add(place);
      notify();
      try {
        if (current !== null) {
          const withNote = current.note !== '';
          pagePlace = place;
          if (withNote) undoPlace = place;
          await page.remove(current.id, withNote);
        } else {
          // Marking again where 撤销 still shows: that bookmark is gone for good (the server purges it).
          if (undoPlace === place) page.dismissToast();
          const r = await b.create(nodeId);
          fresh = place; // before the note box appears (page.add re-renders)
          page.add(r.bookmark);
        }
      } catch (err) {
        failure = { place, text: writeErrorText(err) };
      } finally {
        busy.delete(place);
        notify();
      }
    },
    startEdit(nodeId) {
      const place = placeKey(nodeId);
      if (fresh === place) fresh = null;
      const bookmark = bookmarkOf(place);
      if (bookmark === null || page.state().editing?.id === bookmark.id) return;
      page.startEdit(bookmark.id, bookmark.note);
    },
    setDraft: (text) => page.setDraft(text),
    commitEdit: () => page.commitEdit(),
    cancelEdit: () => page.cancelEdit(),
    async undo() {
      pagePlace = undoPlace;
      await page.undo();
    },
    close() {
      page.close();
      unhook = null;
      listeners.clear();
    },
  };
}
