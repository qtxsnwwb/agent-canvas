/**
 * The writes of a list of bookmarks (bookmarks spec 4 and 5) as a controller that does not need React: note edits,
 * delete with undo, and the overlay of what was done here until the live list has it. Used by the 书签 page
 * (pages/Bookmarks.tsx) and, through sessionBookmarks.ts, by the session page. Pure apart from the 撤销 timer.
 */
import { normalizeBookmarkNote, type Bookmark } from '@agent-canvas/shared';
import { writeErrorText } from './attention';

/** How long a deleted bookmark's 撤销 stays. */
export const BOOKMARK_UNDO_MS = 6_000;

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
   * A new list arrived: the saved notes it already has (or whose bookmark it no longer has) are forgotten, and so are
   * the rows deleted here that it no longer has (so one restored elsewhere later shows again) and the bookmarks added
   * here that it has.
   */
  listChanged(list: readonly Bookmark[]): void;
  /** A bookmark made here (or found made already): shown until a list has it. */
  add(b: Bookmark): void;
  startEdit(id: number, note: string): void;
  setDraft(text: string): void;
  cancelEdit(): void;
  /**
   * Enter or leaving the box: saves the draft (once, even when both happen: while a save is in flight it settles with
   * that one); a draft equal to the note is not sent.
   */
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
  /** The note save in flight, if any. */
  let committing: Promise<void> | null = null;
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
      if (e === null) return;
      if (e.saving) { await committing; return; } // the save in flight (Enter, then the blur) is the one
      const normalized = normalizeBookmarkNote(e.draft);
      if (normalized.ok && normalized.note === e.original) { set({ editing: null }); return; }
      set({ editing: { ...e, saving: true, error: null } });
      const run = (async (): Promise<void> => {
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
      })();
      committing = run;
      await run;
      if (committing === run) committing = null;
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
