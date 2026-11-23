import { useEffect, useMemo, useState } from 'react';
import type { AttentionHidden, AttentionResponse } from '@agent-canvas/shared';
import {
  attentionRows, emptyText, footerText, hiddenRows, parseAutoHideInput, undeterminableRows, writeErrorText, type AttentionRowView,
  type HiddenRowView,
} from '../attention';
import { api, type AttentionLiveState, type LiveAttention } from '../client';
import { useMask } from '../MaskContext';
import { OriginBadge } from '../OriginBadge';
import { useNow } from '../useNow';

function fullTime(iso: string): string | undefined {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString('zh-CN', { hour12: false });
}

/** A row button's click: acts without following the row's link or reaching any handler around it. */
export function dismissClick(act: () => void) {
  return (e: { preventDefault(): void; stopPropagation(): void }): void => {
    e.preventDefault();
    e.stopPropagation();
    act();
  };
}

/** The row's link (its text is its name): kind, origin, project, title and time, then the explanation line. */
function RowLink({ row }: { row: AttentionRowView }) {
  return (
    <a className="attention-link" href={row.href}>
      <span className="attention-line">
        <span className={`status status-${row.statusClass}`}>{row.kindLabel}</span>
        <OriginBadge origin={row.origin} />
        <span className="attention-project">{row.project}</span>
        <span className="attention-title">{row.title}</span>
        <span className="attention-time" title={fullTime(row.at)}>{row.time}</span>
      </span>
      {row.explanation !== null && <span className="attention-explanation">{row.explanation}</span>}
    </a>
  );
}

/** One item of the main list. “知道了” sits next to the link, not inside it: pressing it never opens the session. */
export function AttentionRow({ row, onDismiss, busy }: { row: AttentionRowView; onDismiss(): void; busy: boolean }) {
  return (
    <li className="attention-row">
      <RowLink row={row} />
      <button type="button" className="attention-btn" disabled={busy} onClick={dismissClick(onDismiss)}>知道了</button>
    </li>
  );
}

/** One item of the hidden list: why it is hidden, and “撤销” for a “知道了”. */
function HiddenRow({ row, onRestore, busy }: { row: HiddenRowView; onRestore(): void; busy: boolean }) {
  return (
    <li className="attention-row">
      <RowLink row={row} />
      <span className="attention-reason">{row.reasonText}</span>
      {row.canRestore && (
        <button type="button" className="attention-btn" disabled={busy} onClick={dismissClick(onRestore)}>撤销</button>
      )}
    </li>
  );
}

/**
 * The auto-hide limit, edited in place (1..720 hours). `save` sends it (rejects with the server's text). The browser's
 * own validation is off (noValidate) so the page's message is the one shown.
 */
export function AutoHideSetting({ hours, save: send }: { hours: number; save(hours: number): Promise<void> }) {
  const [text, setText] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const shown = text ?? String(hours);
  const save = (): void => {
    const parsed = parseAutoHideInput(shown);
    if (!parsed.ok) { setNote({ ok: false, text: parsed.error }); return; }
    setSaving(true);
    setNote(null);
    send(parsed.value).then(
      () => { setText(null); setNote({ ok: true, text: '已保存' }); },
      (e: unknown) => setNote({ ok: false, text: writeErrorText(e) }),
    ).finally(() => setSaving(false));
  };
  return (
    <form className="notify-field attention-setting" noValidate onSubmit={(e) => { e.preventDefault(); save(); }}>
      <label htmlFor="attention-hours">超过</label>
      <input id="attention-hours" type="number" inputMode="numeric" min={1} max={720} step={1} value={shown}
        aria-invalid={note !== null && !note.ok ? true : undefined}
        onChange={(e) => { setText(e.target.value); setNote(null); }} />
      <span>小时没处理的，自动移出列表</span>
      <button type="submit" className="notify-btn" disabled={saving || text === null}>保存</button>
      {note !== null && <span className={note.ok ? 'notify-save ok' : 'notify-field-error'} role="status">{note.text}</span>}
    </form>
  );
}

/**
 * `#/attention` (spec 5): the sessions waiting for the user, live. `live` is the app's attention state (it also feeds the
 * header's count); `actions` runs the writes and the hidden-list fetch so that an answer older than a push is not applied.
 */
export function Attention({ live, actions }: { live: AttentionLiveState; actions: Pick<LiveAttention, 'write' | 'hidden'> }) {
  const now = useNow(30_000);
  const { list: m } = useMask();
  const r = live.response;
  const rows = useMemo(() => (r === null ? [] : attentionRows(r.items, m, now)), [r, m, now]);
  const undeterminable = useMemo(() => (r === null ? [] : undeterminableRows(r.undeterminable, m)), [r, m]);
  const [busy, setBusy] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const write = (key: string, call: () => Promise<AttentionResponse>): void => {
    setBusy(key);
    setWriteError(null);
    actions.write(call).catch((e: unknown) => setWriteError(writeErrorText(e))).finally(() => setBusy(null));
  };

  // The hidden list is fetched only while shown, and again on every new state (a push, this page's own writes): the
  // pushes carry its count, not its items. Only the latest request's answer is used, and none older than a push (null).
  const [showHidden, setShowHidden] = useState(false);
  const [hidden, setHidden] = useState<{ list: AttentionHidden[] | null; failed: boolean }>({ list: null, failed: false });
  const [hiddenAttempt, setHiddenAttempt] = useState(0);
  useEffect(() => {
    if (!showHidden || r === null) return;
    let alive = true;
    actions.hidden().then(
      (list) => { if (alive && list !== null) setHidden({ list, failed: false }); },
      () => { if (alive) setHidden((h) => ({ list: h.list, failed: true })); },
    );
    return () => { alive = false; };
  }, [showHidden, r, hiddenAttempt, actions]);
  const hiddenView = useMemo(
    () => (hidden.list === null || r === null ? null : hiddenRows(hidden.list, r.autoHideHours, m, now)),
    [hidden.list, r, m, now],
  );
  const [showUndeterminable, setShowUndeterminable] = useState(false);

  if (r === null) {
    return (
      <div className="stats attention-page">
        <div className="stats-head"><h1>待处理</h1></div>
        <p className={live.problem?.kind === 'failed' ? 'error stats-state' : 'muted stats-state'} role="status">
          {live.problem?.text ?? '加载中…'}
        </p>
      </div>
    );
  }

  const empty = rows.length === 0 ? emptyText(r) : null;
  const footer = footerText(r, empty === null);
  return (
    <div className="stats attention-page">
      <div className="stats-head attention-head">
        <div>
          <h1>待处理{rows.length > 0 && `（${rows.length}）`}</h1>
          <p className="muted">在等你批准、出错停下、卡住了、跑完一轮的会话。点一行打开会话，定位到相关的那一步。</p>
        </div>
        <button type="button" className="attention-btn" aria-expanded={showHidden}
          disabled={!showHidden && r.hiddenCount === 0} onClick={() => setShowHidden((v) => !v)}>
          {showHidden ? '收起已移出的' : `显示已移出的（${r.hiddenCount}）`}
        </button>
      </div>
      {live.problem !== null && <p className="error stats-state" role="status">{live.problem.text}下面是上一次的结果。</p>}
      {writeError !== null && <p className="error stats-state" role="alert">{writeError}</p>}
      {empty !== null ? (
        <section className="stats-empty">
          <p className="stats-empty-title">{empty.title}</p>
          <p className="muted">{empty.sub}</p>
        </section>
      ) : (
        <section className="files-card attention-card" aria-label="待处理列表">
          <ul className="attention-items">
            {rows.map((row) => (
              <AttentionRow key={row.key} row={row} busy={busy === row.key}
                onDismiss={() => write(row.key, () => api.dismissAttention(row.key))} />
            ))}
          </ul>
        </section>
      )}
      {footer !== null && (
        <div className="attention-footer">
          <span>{footer}</span>
          {undeterminable.length > 0 && (
            <button type="button" className="attention-btn" aria-expanded={showUndeterminable} onClick={() => setShowUndeterminable((v) => !v)}>
              {showUndeterminable ? '收起' : '展开'}
            </button>
          )}
        </div>
      )}
      {showUndeterminable && undeterminable.length > 0 && (
        <section className="files-card attention-card" aria-label="无法判断状态的会话">
          <p className="stats-caption">这几个来源分不清“跑完了”和“还在跑”，不放进上面的列表。</p>
          <ul className="attention-items">
            {undeterminable.map((u) => (
              <li key={u.sessionId}>
                <a className="attention-link" href={u.href}>
                  <span className="attention-line">
                    <OriginBadge origin={u.origin} />
                    <span className="attention-title">{u.title}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      <AutoHideSetting hours={r.autoHideHours} save={(hours) => actions.write(() => api.saveAttentionSettings(hours))} />
      {showHidden && (
        <section className="files-card attention-card" aria-label="已移出的">
          <h2>已移出的</h2>
          <p className="stats-caption">点过“知道了”的，和超过时限没处理的（只留 30 天内的）。会话再次需要你时会回到上面。</p>
          {hidden.failed && (
            <p className="error stats-state">
              已移出的没能加载出来。
              <button type="button" className="notify-btn stats-retry" onClick={() => setHiddenAttempt((x) => x + 1)}>再试一次</button>
            </p>
          )}
          {hiddenView === null ? (
            !hidden.failed && <p className="muted stats-state">加载中…</p>
          ) : hiddenView.length === 0 ? (
            <p className="muted stats-state">没有移出的项</p>
          ) : (
            <ul className="attention-items">
              {hiddenView.map((row) => (
                <HiddenRow key={row.key} row={row} busy={busy === row.key}
                  onRestore={() => write(row.key, () => api.restoreAttention(row.key))} />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
