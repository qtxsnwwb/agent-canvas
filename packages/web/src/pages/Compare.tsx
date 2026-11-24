import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { COMPARE_FILES_MAX, COMPARE_TOOLS_MAX } from '@agent-canvas/shared';
import { api } from '../client';
import {
  CHANGE_TEXT, CWDS_DIFFER_TEXT, LOAD_FAILED_TEXT, NO_PROMPT_TEXT, NO_TURN_TEXT, REFRESH_FAILED_TEXT, SAME_SESSION_TEXT, SWAP_TEXT,
  TURNS_TRUNCATED_TEXT, compareView, createComparePoller, type CellPart, type CompareState, type CompareView, type LinkCell, type SideHead,
  type TurnCellView,
} from '../compare';
import { ComparePicker } from '../ComparePicker';
import { useMask } from '../MaskContext';
import { OriginBadge } from '../OriginBadge';
import { compareHash } from '../route';
import { useNow } from '../useNow';

function Parts({ parts }: { parts: CellPart[] }) {
  return <>{parts.map((p, i) => (p.better ? <strong key={i}>{p.text}</strong> : <span key={i}>{p.text}</span>))}</>;
}

function Link({ cell }: { cell: LinkCell }) {
  return cell.href === null ? <span className="muted">{cell.text}</span> : <a href={cell.href} title="打开这个会话">{cell.text}</a>;
}

/** A column head: 左 / 右, the session's name (a link), origin and status; or 「找不到这个会话」 and the id asked for. */
function Head({ head }: { head: SideHead }) {
  return (
    <th scope="col" className="compare-side">
      <span className="compare-side-label">{head.label}：</span>
      {head.href === null ? (
        <span className="compare-side-title compare-missing" title={head.id}>{head.title}</span>
      ) : (
        <a className="compare-side-title" href={head.href} title={head.cwd === null ? head.title : `${head.title}\n${head.cwd}`}>{head.title}</a>
      )}
      {head.origin !== null && (
        <span className="compare-side-meta">
          <OriginBadge origin={head.origin} />
          <span className="muted">{head.statusLabel}</span>
        </span>
      )}
    </th>
  );
}

function Turn({ cell }: { cell: TurnCellView | null }) {
  if (cell === null) return <td className="compare-turn muted">{NO_TURN_TEXT}</td>;
  return (
    <td className="compare-turn">
      <a href={cell.href} title="打开这个会话，并定位到这一轮">
        <span className={cell.head === '' ? 'compare-turn-head muted' : 'compare-turn-head'}>{cell.head === '' ? NO_PROMPT_TEXT : `“${cell.head}”`}</span>
      </a>
      <span className="compare-turn-meta">{cell.meta}</span>
    </td>
  );
}

function Section({ id, title, caption, note, children }: { id: string; title: string; caption?: string; note?: string | null; children: ReactNode }) {
  return (
    <section aria-labelledby={id}>
      <h2 id={id}>{title}{note != null && <span className="compare-h-note">{note}</span>}</h2>
      {caption !== undefined && <p className="stats-caption">{caption}</p>}
      {children}
    </section>
  );
}

function Body({ view }: { view: CompareView }) {
  const [left, right] = view.heads;
  return (
    <>
      {view.sameSession && <p className="bookmarks-notice compare-notice" role="status"><span>{SAME_SESSION_TEXT}</span></p>}
      <Section id="compare-totals-h" title="总览"
        caption="口径和统计页一样；更好的一边加粗（用时短、调用少、失败少、token 少），只是提示，不下结论。">
        <div className="stats-table-wrap">
          <table className="stats-table compare-table">
            <thead><tr><th scope="col"><span className="visually-hidden">项目</span></th><Head head={left} /><Head head={right} /></tr></thead>
            <tbody>
              {view.totals.map((r) => (
                <tr key={r.label}>
                  <th scope="row">{r.label}</th>
                  <td className="num"><Parts parts={r.left} /></td>
                  <td className="num"><Parts parts={r.right} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Section id="compare-tools-h" title="按工具"
        caption={`按工具名原样配对：不同工具的工具名不一样（例如 Claude Code 的 Bash、Codex 的 exec_command），这时多数行只有一边有数。最多列 ${COMPARE_TOOLS_MAX} 个。`}>
        {view.tools.length === 0 ? <p className="muted stats-state">两边都没有调用工具</p> : (
          <div className="stats-table-wrap">
            <table className="stats-table compare-table">
              <thead><tr><th scope="col">工具</th><th scope="col" className="num">左</th><th scope="col" className="num">右</th></tr></thead>
              <tbody>
                {view.tools.map((t) => (
                  <tr key={t.key}>
                    <th scope="row" className="compare-mono">{t.name}</th>
                    <td className="num"><Link cell={t.left} /></td>
                    <td className="num"><Link cell={t.right} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section id="compare-turns-h" title="按轮" caption="按序号对齐：左边的第 1 轮对右边的第 1 轮。每格：提示开头，用时 · 工具调用 · 新输入 + 输出。"
        note={view.turnsTruncated ? TURNS_TRUNCATED_TEXT : null}>
        {view.turns.length === 0 ? <p className="muted stats-state">两边都还没有轮次</p> : (
          <div className="stats-table-wrap">
            <table className="stats-table compare-table">
              <thead><tr><th scope="col">轮</th><th scope="col">左</th><th scope="col">右</th></tr></thead>
              <tbody>
                {view.turns.map((t) => (
                  <tr key={t.index}>
                    <th scope="row">{t.label}</th>
                    <Turn cell={t.left} />
                    <Turn cell={t.right} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section id="compare-files-h" title="文件" note={view.files.cwdsDiffer ? CWDS_DIFFER_TEXT : null}
        caption={`路径相对各自的工作目录，按两边次数之和排；每组最多列 ${COMPARE_FILES_MAX} 个。点数字打开那个会话的文件面板。`}>
        {view.files.empty ? <p className="muted stats-state">两边都没有读写文件</p> : (
          <div className="stats-table-wrap">
            <table className="stats-table compare-table">
              <thead><tr><th scope="col">文件</th><th scope="col" className="num">左（读/改）</th><th scope="col" className="num">右（读/改）</th></tr></thead>
              {view.files.groups.filter((g) => g.rows.length > 0 || g.moreText !== null).map((g) => (
                <tbody key={g.key}>
                  <tr className="compare-group"><th scope="colgroup" colSpan={3}>{g.label}</th></tr>
                  {g.rows.map((f) => (
                    <tr key={f.key}>
                      <th scope="row" className="compare-path">{f.path}</th>
                      <td className="num"><Link cell={f.left} /></td>
                      <td className="num"><Link cell={f.right} /></td>
                    </tr>
                  ))}
                  {g.moreText !== null && <tr><td colSpan={3} className="muted">{g.moreText}</td></tr>}
                </tbody>
              ))}
            </table>
          </div>
        )}
      </Section>
    </>
  );
}

export interface ComparePageViewProps {
  /** null before the first answer. */
  view: CompareView | null;
  /** The last request failed (it is retried). */
  failed: boolean;
  onSwap(): void;
  onChange(): void;
}

/** The page as rendered from its state (no fetching: ComparePage below does that). */
export function ComparePageView({ view, failed, onSwap, onChange }: ComparePageViewProps) {
  return (
    <div className="stats compare-page">
      <div className="stats-head compare-head">
        <h1>对比</h1>
        <span className="compare-actions">
          <button type="button" className="attention-btn" onClick={onSwap}>{SWAP_TEXT}</button>
          <button type="button" className="attention-btn" aria-haspopup="dialog" disabled={view === null} onClick={onChange}>{CHANGE_TEXT}</button>
        </span>
      </div>
      {failed && <p className="error stats-state" role="status">{view === null ? LOAD_FAILED_TEXT : REFRESH_FAILED_TEXT}</p>}
      {view !== null && view.live && !failed && <p className="muted compare-live" role="status">有一边正在进行，数字每 5 秒更新一次。</p>}
      {view === null ? (!failed && <p className="muted stats-state">加载中…</p>) : <Body view={view} />}
    </div>
  );
}

/**
 * `#/compare/<a>/<b>` (compare spec 4): the two sessions' numbers, refetched every 5 s while a side is running or
 * waiting for a permission. Texts masked by rule with the switch on (the cross-session lists' masker: no learned
 * values). 「交换左右」 swaps the address; 「换一个」 opens the picker for the right side.
 */
export function ComparePage({ a, b }: { a: string; b: string }) {
  const { list: m } = useMask();
  const now = useNow();
  const [state, setState] = useState<CompareState>({ response: null, failed: false });
  useEffect(() => {
    const p = createComparePoller({ load: () => api.compare(a, b), onState: setState });
    return () => p.close();
  }, [a, b]);
  const view = useMemo(() => (state.response === null ? null : compareView(state.response, { a, b }, m, now)), [state.response, a, b, m, now]);
  const [picking, setPicking] = useState(false);
  const left = state.response?.left ?? null;
  return (
    <>
      <ComparePageView view={view} failed={state.failed}
        onSwap={() => { location.hash = compareHash(b, a); }} onChange={() => setPicking(true)} />
      {picking && <ComparePicker currentId={a} projectId={left?.projectId ?? null} otherId={b} onClose={() => setPicking(false)} />}
    </>
  );
}
