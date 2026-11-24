/**
 * Marking on the session page (bookmarks spec 5): the toolbar's and the drawer's bookmark buttons and note boxes, as a
 * controller over SessionSource.bookmarks built on the 书签 page's writes (bookmarkWrites.ts). Kept apart from
 * bookmarks.ts (the 书签 page's rows and filter): the exported viewer's build takes what the session page imports.
 */
import { normalizeBookmarkNote, type Bookmark } from '@agent-canvas/shared';
import { writeErrorText } from './attention';
import { createBookmarkPageController, type BookmarkEditing } from './bookmarkWrites';
import type { SessionBookmarks } from './sessionSource';

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
   * The button: marks the place, or un-marks it (at once; with a note — stored, or typed into its box and being
   * saved — 「备注会一起删除」 and 撤销 show beside the button). Ignored while the place's request is in flight or
   * before the first list.
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

/** useSyncExternalStore's subscribe for a page without bookmarks (the exported viewer): nothing ever changes. */
export const NO_SUBSCRIBE = (): (() => void) => () => {};

/**
 * Wires a controller to its source's live list (SessionBookmarks.watch: the app's sessions-scope socket, refetched on
 * each `bookmarks` push naming the session). Returns the stop, which also closes the controller.
 */
export function connectSessionBookmarks(b: Pick<SessionBookmarks, 'watch'>, ctrl: SessionBookmarkController): () => void {
  const stop = b.watch((list) => ctrl.setList(list));
  return () => { stop(); ctrl.close(); };
}

/** A place's key: the step's node id, '' for the session. */
const placeKey = (nodeId: string | null): string => nodeId ?? '';

/**
 * The session page's marking, on top of the 书签 page's controller (createBookmarkPageController: note edits, delete
 * with undo, the overlay of what was done here until the list has it). The list comes from SessionBookmarks.watch.
 */
export function createSessionBookmarkController(b: SessionBookmarkWrites): SessionBookmarkController {
  const page = createBookmarkPageController({
    patchBookmark: b.patch, deleteBookmark: b.remove, restoreBookmark: b.restore,
  });
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
      pagePlace = null; // an earlier delete's or undo's failure is old news here
      fresh = null;
      let current = bookmarkOf(place);
      busy.add(place);
      notify();
      try {
        if (current !== null) {
          // A note typed into its box counts: clicking the button blurred the box, which started the save. Let that
          // save land first, so the note goes with the bookmark and 撤销 brings both back.
          const editing = page.state().editing;
          if (editing !== null && editing.id === current.id && editing.saving) {
            await page.commitEdit();
            current = bookmarkOf(place) ?? current;
          }
          const left = page.state().editing; // still there: the save failed, the typed note is not stored
          const typed = left !== null && left.id === current.id ? normalizeBookmarkNote(left.draft) : null;
          const withNote = current.note !== '' || (typed !== null && (!typed.ok || typed.note !== ''));
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
