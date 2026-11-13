/**
 * The session page's export dialog (spec 4.1). Live side only: rendered by pages/Session.tsx (it calls the API), never
 * by SessionCanvas, so it is not in the exported viewer.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ExportOptions, ExportPreview } from '@agent-canvas/shared';
import { api, failureOf } from '../client';
import {
  EXPORT_CAUTION, EXPORT_OPTIONS_KEY, buildExportOptions, createLatest, exportErrorText, fileNameFromDisposition, maskOffWarning,
  parseDialogOptions, previewView, serializeDialogOptions, settingsErrorText, termsToText, validateTermsText,
  type DialogOptions, type TurnChoice,
} from '../export';
import { useMask } from '../MaskContext';

/** The scan runs this long after the last option change. */
const PREVIEW_DELAY_MS = 300;

function loadOptions(): DialogOptions {
  try { return parseDialogOptions(window.localStorage.getItem(EXPORT_OPTIONS_KEY)); } catch { return parseDialogOptions(null); }
}
function saveOptions(o: DialogOptions): void {
  try { window.localStorage.setItem(EXPORT_OPTIONS_KEY, serializeDialogOptions(o)); } catch { /* not remembered */ }
}

type Scan =
  | { state: 'idle' }
  | { state: 'scanning' }
  | { state: 'done'; preview: ExportPreview; options: ExportOptions }
  | { state: 'error'; message: string };

type Download =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'done'; fileName: string }
  | { state: 'error'; message: string };

/** Saves a Blob as a file: an object URL on a temporary `<a download>`, revoked afterwards. */
function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}

const MASK_ROWS: { key: keyof ExportOptions['mask']; label: string; hint: string }[] = [
  { key: 'credential', label: '固定格式的凭据', hint: 'sk-… 这类 API key、GitHub / npm / Slack token、JWT、Bearer 令牌、私钥、网址里的密码' },
  { key: 'assignment', label: '密钥/密码赋值', hint: '名字里带 password、secret、token、api key 的变量或字段后面的值' },
  { key: 'personal', label: '个人信息（邮箱、主目录用户名）', hint: '邮箱地址；C:\\Users\\<名>、/home/<名> 里的用户名换成 ~' },
  { key: 'custom', label: '自定义词', hint: '下面列出的词，不分大小写（客户名、项目代号等）' },
];

const OUTPUT_OPTIONS: { value: ExportOptions['output']; label: string }[] = [
  { value: 'head', label: '每步前 8 KB' }, { value: 'full', label: '全部' }, { value: 'none', label: '不含' },
];

export function ExportDialog({ sessionId, turn, onClose }: {
  sessionId: string;
  /** The main-thread turn selected on the canvas (its label as shown there); null: none, "this turn" is disabled. */
  turn: TurnChoice | null;
  onClose(): void;
}) {
  const ids = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const mask = useMask();
  const { settings } = mask;
  const [options, setOptionsState] = useState<DialogOptions>(loadOptions);
  const setOptions = useCallback((f: (o: DialogOptions) => DialogOptions) => {
    setOptionsState((o) => {
      const next = f(o);
      saveOptions(next);
      return next;
    });
  }, []);
  const hasTerms = settings.state === 'ok' && settings.terms.length > 0;
  const request = useMemo(() => buildExportOptions(options, turn, hasTerms), [options, turn, hasTerms]);
  const requestKey = JSON.stringify(request);

  // ---- open as a modal (the rest of the page is inert), Esc closes, focus goes back where it was ----
  useEffect(() => {
    const d = dialogRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (d !== null && !d.open) d.showModal();
    return () => {
      if (d?.open) d.close();
      if (previous !== null && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  // ---- the scan (debounced; an older answer arriving late is ignored, the older request aborted) ----
  const [scan, setScan] = useState<Scan>({ state: 'idle' });
  const latest = useRef(createLatest());
  useEffect(() => {
    if (settings.state === 'loading') return;
    const body = JSON.parse(requestKey) as ExportOptions;
    const n = latest.current.next();
    const ctrl = new AbortController();
    setScan({ state: 'scanning' });
    const timer = setTimeout(() => {
      api.exportPreview(sessionId, body, ctrl.signal).then(
        (preview) => { if (latest.current.isLatest(n)) setScan({ state: 'done', preview, options: body }); },
        (e: unknown) => {
          const f = failureOf(e);
          if (f === 'abort' || !latest.current.isLatest(n)) return;
          setScan({ state: 'error', message: exportErrorText(f) });
        },
      );
    }, PREVIEW_DELAY_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [sessionId, requestKey, settings.state]);

  // ---- the download ----
  const [download, setDownload] = useState<Download>({ state: 'idle' });
  const downloadCtrl = useRef<AbortController | null>(null);
  useEffect(() => () => downloadCtrl.current?.abort(), []);
  const startDownload = (): void => {
    const ctrl = new AbortController();
    downloadCtrl.current?.abort();
    downloadCtrl.current = ctrl;
    setDownload({ state: 'busy' });
    const body = request;
    api.exportFile(sessionId, body, ctrl.signal).then(
      ({ blob, disposition }) => {
        if (ctrl.signal.aborted) return;
        const fileName = fileNameFromDisposition(disposition, body.format);
        saveBlob(blob, fileName);
        setDownload({ state: 'done', fileName });
      },
      (e: unknown) => {
        const f = failureOf(e);
        if (f === 'abort') { setDownload({ state: 'idle' }); return; }
        setDownload({ state: 'error', message: exportErrorText(f) });
      },
    ).finally(() => { if (downloadCtrl.current === ctrl) downloadCtrl.current = null; });
  };
  const cancelDownload = (): void => {
    downloadCtrl.current?.abort();
    downloadCtrl.current = null;
    setDownload({ state: 'idle' });
  };

  // ---- custom terms ----
  const [termsOpen, setTermsOpen] = useState(false);
  const [termsText, setTermsText] = useState<string | null>(null);
  const shownTerms = termsText ?? termsToText(settings.terms);
  const termsCheck = useMemo(() => validateTermsText(shownTerms), [shownTerms]);
  const [termsSave, setTermsSave] = useState<{ state: 'idle' | 'saving' | 'saved' } | { state: 'error'; message: string }>({ state: 'idle' });
  const saveTerms = (): void => {
    if (!termsCheck.ok) return;
    setTermsSave({ state: 'saving' });
    api.saveExportSettings(termsCheck.terms).then(
      (r) => {
        mask.settingsSaved(r);
        setTermsText(null);
        setTermsSave({ state: 'saved' });
      },
      (e: unknown) => {
        const f = failureOf(e);
        setTermsSave({ state: 'error', message: settingsErrorText(f === 'abort' ? 'network' : f) });
      },
    );
  };

  const view = scan.state === 'done' ? previewView(scan.preview, scan.options.scope, scan.options.output) : null;
  const offWarning = maskOffWarning(request.mask);
  const busy = download.state === 'busy';
  const canExport = !busy && !(view !== null && view.tooLarge !== null);
  const customDamaged = settings.state === 'damaged';
  const set = <K extends keyof DialogOptions>(key: K, value: DialogOptions[K]): void => setOptions((o) => ({ ...o, [key]: value }));
  const setMask = (key: keyof DialogOptions['mask'], value: boolean): void => setOptions((o) => ({ ...o, mask: { ...o.mask, [key]: value } }));

  return (
    // The native modal dialog: the page behind is inert (focus stays inside), Esc fires `cancel`.
    <dialog ref={dialogRef} className="export-dialog" aria-labelledby={`${ids}-title`}
      onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <div className="export-head">
        <h2 id={`${ids}-title`}>导出这个会话</h2>
        <button type="button" className="export-close" aria-label="关闭" onClick={onClose}>×</button>
      </div>
      <div className="export-body">
        <fieldset>
          <legend>格式</legend>
          <label><input type="radio" name={`${ids}-format`} checked={options.format === 'html'} onChange={() => set('format', 'html')} />
            HTML <span className="muted">双击就能在浏览器里打开的只读页面</span></label>
          <label><input type="radio" name={`${ids}-format`} checked={options.format === 'md'} onChange={() => set('format', 'md')} />
            Markdown <span className="muted">文字记录，可以贴进文档或 PR</span></label>
        </fieldset>

        <fieldset>
          <legend>范围</legend>
          <label><input type="radio" name={`${ids}-scope`} checked={request.scope.kind === 'session'} onChange={() => set('scope', 'session')} />
            整个会话</label>
          <label className={turn === null ? 'is-disabled' : undefined}>
            <input type="radio" name={`${ids}-scope`} disabled={turn === null} checked={request.scope.kind === 'turn'}
              onChange={() => set('scope', 'turn')} aria-describedby={`${ids}-turn`} />
            只导出当前选中的这一轮
          </label>
          <p id={`${ids}-turn`} className="muted export-hint">
            {turn === null ? '没有选中轮次：先在画布上点一轮（概览里的轮次卡片，或这一轮里的任意一步）。' : `选中的是：${turn.label}`}
          </p>
        </fieldset>

        <fieldset>
          <legend>内容</legend>
          <label><input type="checkbox" checked={options.thinking} onChange={(e) => set('thinking', e.target.checked)} /> 包含思考</label>
          <label><input type="checkbox" checked={options.subagents} onChange={(e) => set('subagents', e.target.checked)} /> 包含子代理内部的步骤</label>
          <div className="export-output" role="radiogroup" aria-label="工具输出">
            <span>工具输出：</span>
            {OUTPUT_OPTIONS.map((o) => (
              <label key={o.value}><input type="radio" name={`${ids}-output`} checked={options.output === o.value}
                onChange={() => set('output', o.value)} /> {o.label}</label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>遮蔽</legend>
          {MASK_ROWS.map((r) => (
            <div key={r.key} className="export-mask-row">
              <label>
                <input type="checkbox" role="switch" checked={request.mask[r.key]} onChange={(e) => setMask(r.key, e.target.checked)}
                  aria-describedby={`${ids}-mask-${r.key}`} />
                {r.label}
              </label>
              <p id={`${ids}-mask-${r.key}`} className="muted export-hint">
                {r.key === 'custom' && customDamaged ? settings.note : r.hint}
                {r.key === 'custom' && settings.state === 'ok' && `（现在 ${settings.terms.length} 个）`}
              </p>
            </div>
          ))}
          {offWarning !== null && <p className="export-warn" role="alert">{offWarning}</p>}
          <details className="export-terms" open={termsOpen} onToggle={(e) => setTermsOpen(e.currentTarget.open)}>
            <summary>编辑自定义词</summary>
            {settings.state === 'loading' && <p className="muted">加载中…</p>}
            {settings.state === 'error' && (
              <p className="export-warn">{settings.note} <button type="button" className="export-link" onClick={mask.reloadSettings}>重试</button></p>
            )}
            {customDamaged && <p className="export-warn">{settings.note}</p>}
            {mask.on ? (
              // The list itself is what the page switch hides: not shown while it is on.
              <p className="muted">页面遮蔽打开时不显示自定义词。关掉顶栏的“遮蔽”再来编辑。</p>
            ) : (<>
            <label className="export-terms-label" htmlFor={`${ids}-terms`}>一行一个，至少 3 个字符，最多 100 个，不分大小写：</label>
            <textarea id={`${ids}-terms`} rows={5} value={shownTerms} spellCheck={false} disabled={settings.state === 'loading'}
              aria-invalid={!termsCheck.ok} aria-describedby={`${ids}-terms-msg`}
              onChange={(e) => { setTermsText(e.target.value); setTermsSave({ state: 'idle' }); }} />
            <div id={`${ids}-terms-msg`} className="export-terms-msg" aria-live="polite">
              {!termsCheck.ok && <ul className="export-warn">{termsCheck.errors.map((x) => <li key={x}>{x}</li>)}</ul>}
              {termsSave.state === 'saving' && <span className="muted">保存中…</span>}
              {termsSave.state === 'saved' && <span className="muted">已保存</span>}
              {termsSave.state === 'error' && <span className="export-warn">{termsSave.message}</span>}
            </div>
            <button type="button" disabled={!termsCheck.ok || termsSave.state === 'saving' || settings.state === 'loading'
              || (termsText === null && !customDamaged)} onClick={saveTerms}>保存自定义词</button>
            </>)}
          </details>
        </fieldset>

        <section className="export-scan" aria-labelledby={`${ids}-scan`} aria-live="polite" aria-busy={scan.state === 'scanning'}>
          <h3 id={`${ids}-scan`}>扫描结果</h3>
          {(scan.state === 'scanning' || scan.state === 'idle') && <p className="muted">扫描中…</p>}
          {scan.state === 'error' && <p className="export-warn">{scan.message}</p>}
          {view !== null && (
            <>
              {view.rows.length > 0 && <ul className="export-rows">{view.rows.map((r) => <li key={r}>{r}</li>)}</ul>}
              {view.partial
                ? <p>{view.nodes} · {view.size}（扫描在超过上限时停止了，没有完整的数量）</p>
                : <p>{view.total} · {view.nodes} · {view.size}</p>}
              {view.tooLarge !== null && <p className="export-warn">{view.tooLarge}</p>}
            </>
          )}
        </section>

        <p className="export-caution">{EXPORT_CAUTION}</p>
      </div>
      <div className="export-foot">
        <span className="export-status" role="status">
          {download.state === 'busy' && '正在生成文件…'}
          {download.state === 'done' && `已下载 ${download.fileName}`}
          {download.state === 'error' && <span className="export-warn">{download.message}</span>}
        </span>
        {busy && <button type="button" onClick={cancelDownload}>取消</button>}
        <button type="button" onClick={onClose}>关闭</button>
        <button type="button" className="export-go" disabled={!canExport} aria-busy={busy} onClick={startDownload}>
          {busy ? '导出中…' : '导出'}
        </button>
      </div>
    </dialog>
  );
}
