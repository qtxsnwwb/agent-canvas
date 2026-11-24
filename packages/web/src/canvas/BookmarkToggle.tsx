import { useSyncExternalStore, type KeyboardEvent } from 'react';
import {
  MARKED_TEXT, NOTE_GOES_TEXT, NO_SUBSCRIBE, SESSION_MARK_TEXT, STEP_MARK_TEXT, type MarkState, type SessionBookmarkController,
} from '../sessionBookmarks';

const NO_VERSION = (): number => 0;

/** The parts of a key event the note box reads. */
export type NoteKey = Pick<KeyboardEvent<HTMLInputElement>, 'key' | 'preventDefault' | 'stopPropagation'> & {
  nativeEvent: { isComposing: boolean };
};

/**
 * The note box's keys: Enter saves (once, see commitEdit); Escape puts the stored note back and goes no further — the
 * drawer closes on an Escape that reaches the window, and this one must not close it. Nothing while an input method is
 * composing.
 */
export function noteKeyDown(ctrl: Pick<SessionBookmarkController, 'commitEdit' | 'cancelEdit'>, e: NoteKey): void {
  if (e.nativeEvent.isComposing) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    void ctrl.commitEdit();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    ctrl.cancelEdit();
  }
}

/**
 * The note box beside a bookmarked place's button: Enter or leaving it saves (once), Escape puts the stored note back.
 * It takes the focus when the place was just marked here.
 */
function NoteBox({ ctrl, nodeId, s, label }: {
  ctrl: SessionBookmarkController; nodeId: string | null; s: MarkState; label: string;
}) {
  const editing = s.editing;
  return (
    <input className="bookmark-mark-note" aria-label={label} placeholder="写一句备注（可不填），回车保存"
      value={editing !== null ? editing.draft : s.bookmark?.note ?? ''} autoFocus={s.fresh}
      readOnly={editing?.saving === true} aria-invalid={editing?.error != null ? true : undefined}
      onFocus={() => ctrl.startEdit(nodeId)}
      onChange={(e) => { ctrl.startEdit(nodeId); ctrl.setDraft(e.target.value); }}
      onKeyDown={(e) => noteKeyDown(ctrl, e)} onBlur={() => void ctrl.commitEdit()} />
  );
}

/**
 * The session's (toolbar, `nodeId` null) or a step's (drawer) bookmark button (bookmarks spec 5): 收藏会话 /
 * 收藏这一步, 已收藏 while bookmarked (a click un-marks); once bookmarked, a note box beside it; after un-marking a
 * bookmark with a note, 「备注会一起删除」 and 撤销 for a few seconds. Nothing without bookmarks (`ctrl` null: the
 * exported viewer).
 */
export function BookmarkToggle({ ctrl, nodeId }: { ctrl: SessionBookmarkController | null; nodeId: string | null }) {
  const version = ctrl?.version ?? NO_VERSION;
  useSyncExternalStore(ctrl?.subscribe ?? NO_SUBSCRIBE, version, version);
  if (ctrl === null) return null;
  const s = ctrl.stateOf(nodeId);
  const marked = s.bookmark !== null;
  const step = nodeId !== null;
  const error = s.editing?.error ?? s.error;
  return (
    <span className={`bookmark-mark${step ? ' bookmark-mark-step' : ''}`}>
      <button type="button" className="files-toggle bookmark-toggle" aria-pressed={marked} disabled={!s.ready || s.busy}
        aria-busy={s.busy ? true : undefined}
        title={marked ? '再点一次取消收藏' : step ? '收藏这一步，以后在书签页找回来' : '收藏这个会话，以后在书签页找回来'}
        onClick={() => void ctrl.toggle(nodeId)}>
        <span className="bookmark-toggle-star" aria-hidden="true">{marked ? '★' : '☆'}</span>
        {marked ? MARKED_TEXT : step ? STEP_MARK_TEXT : SESSION_MARK_TEXT}
      </button>
      {marked && <NoteBox ctrl={ctrl} nodeId={nodeId} s={s} label={step ? '这一步的备注' : '会话的备注'} />}
      {s.undo && (
        <span className="bookmark-undo" role="status">
          {NOTE_GOES_TEXT}
          <button type="button" className="attention-btn" onClick={() => void ctrl.undo()}>撤销</button>
        </span>
      )}
      {error !== null && <span className="bookmark-mark-error" role="alert">{error}</span>}
    </span>
  );
}
