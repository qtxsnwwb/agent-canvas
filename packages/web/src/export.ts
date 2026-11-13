/**
 * The export dialog's model (spec 4.1): the options it remembers, the scan result as lines, error lines, the file
 * name of a download, the custom-terms editor's validation. Pure; the dialog is canvas/ExportDialog.tsx.
 */
import {
  EXPORT_MAX_BYTES, MASK_TYPE_LABELS, MASK_TYPES, validateCustomTerms, CUSTOM_TERMS_MAX, type ExportOptions, type ExportPreview,
  type ExportSettingsResponse, type MaskReport,
} from '@agent-canvas/shared';

export const EXPORT_CAUTION = '遮蔽不保证完整，分享前请自己再看一遍。';
const MAX_MB = Math.round(EXPORT_MAX_BYTES / 1024 / 1024);
export const TOO_LARGE_TEXT = `超过 ${MAX_MB} MB，请只导出一轮或减少工具输出`;

// ---- remembered options ----

/** localStorage key of the dialog's options (custom terms are not here: they live in the server's settings). */
export const EXPORT_OPTIONS_KEY = 'agent-canvas:export-options';
const OPTIONS_VERSION = 1;

/**
 * What the dialog remembers. `scope` is the last choice (a turn is used only when one is selected); `mask.custom` null:
 * never chosen, on exactly when there are custom terms (spec 3.1 "有词就开").
 */
export interface DialogOptions {
  format: ExportOptions['format'];
  scope: 'session' | 'turn';
  thinking: boolean;
  subagents: boolean;
  output: ExportOptions['output'];
  mask: { credential: boolean; assignment: boolean; personal: boolean; custom: boolean | null };
}

export const DEFAULT_DIALOG_OPTIONS: DialogOptions = {
  format: 'html', scope: 'session', thinking: true, subagents: true, output: 'head',
  mask: { credential: true, assignment: true, personal: false, custom: null },
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, values: readonly T[], fallback: T): T => (values.includes(v as T) ? (v as T) : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/** The stored options; anything missing, malformed or of another version falls back to the default, field by field. */
export function parseDialogOptions(stored: string | null): DialogOptions {
  const d = DEFAULT_DIALOG_OPTIONS;
  if (stored === null) return d;
  let raw: unknown;
  try { raw = JSON.parse(stored); } catch { return d; }
  if (!isObj(raw) || raw.v !== OPTIONS_VERSION) return d;
  const mask = isObj(raw.mask) ? raw.mask : {};
  return {
    format: oneOf(raw.format, ['html', 'md'] as const, d.format),
    scope: oneOf(raw.scope, ['session', 'turn'] as const, d.scope),
    thinking: bool(raw.thinking, d.thinking),
    subagents: bool(raw.subagents, d.subagents),
    output: oneOf(raw.output, ['head', 'full', 'none'] as const, d.output),
    mask: {
      credential: bool(mask.credential, d.mask.credential),
      assignment: bool(mask.assignment, d.mask.assignment),
      personal: bool(mask.personal, d.mask.personal),
      custom: typeof mask.custom === 'boolean' ? mask.custom : null,
    },
  };
}

export function serializeDialogOptions(o: DialogOptions): string {
  return JSON.stringify({ v: OPTIONS_VERSION, ...o });
}

export interface TurnChoice { key: string; label: string }

/** The request body: the remembered options for this session (a turn only when one is selected). */
export function buildExportOptions(o: DialogOptions, turn: TurnChoice | null, hasCustomTerms: boolean): ExportOptions {
  return {
    format: o.format,
    scope: o.scope === 'turn' && turn !== null ? { kind: 'turn', turnKey: turn.key } : { kind: 'session' },
    thinking: o.thinking,
    subagents: o.subagents,
    output: o.output,
    mask: {
      credential: o.mask.credential, assignment: o.mask.assignment, personal: o.mask.personal,
      custom: o.mask.custom ?? hasCustomTerms,
    },
  };
}

/** The explicit warning when no category is on. */
export function maskOffWarning(mask: ExportOptions['mask']): string | null {
  return mask.credential || mask.assignment || mask.personal || mask.custom ? null : '四类遮蔽都关了：导出的文件不会遮蔽任何内容。';
}

// ---- the scan result ----

/**
 * Warning lines about masking limits a report says were reached — the same text as the Markdown header's
 * (`maskWarnings` in packages/server/src/export/markdown.ts; the server package cannot be imported here). Read
 * defensively: the viewer passes a report from the file.
 */
export function maskWarnings(report: Pick<MaskReport, 'learnedCapped' | 'learnedSkipped' | 'numberingCapped'>): string[] {
  const out: string[] = [];
  if (report.learnedCapped === true) out.push('需要逐处查找的密钥值太多，超出上限的值只在原处遮蔽，别处原样出现时可能没有遮住。');
  const skipped = report.learnedSkipped;
  if (typeof skipped === 'number' && Number.isFinite(skipped) && skipped > 0) {
    out.push(`有 ${skipped} 段文字太长或太特殊，没有逐处查找已认出的密钥值，只按规则遮蔽。`);
  }
  if (report.numberingCapped === true) out.push('同一类型的不同值太多，部分占位符没有编号。');
  return out;
}

export interface PreviewView {
  /** “<类型>：N 处（M 个不同的值）” per type found, in the report's order. */
  rows: string[];
  total: string;
  nodes: string;
  size: string;
  /** Why the export is not possible (over the size limit); null when it is. */
  tooLarge: string | null;
  /** The scan stopped at the limit: the counts cover only part of the content. */
  partial: boolean;
  /** Masking limits reached (maskWarnings). */
  warnings: string[];
}

export function formatMb(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb < 0.1 ? '不到 0.1 MB' : `约 ${mb.toFixed(1)} MB`;
}

export function previewView(p: ExportPreview, scope: ExportOptions['scope'], output: ExportOptions['output'] = 'head'): PreviewView {
  const rows: string[] = [];
  for (const type of MASK_TYPES) {
    const c = p.report.byType[type];
    if (c === undefined || !(c.occurrences > 0)) continue;
    rows.push(type === 'failed' ? `${MASK_TYPE_LABELS[type]}：${c.occurrences} 处` : `${MASK_TYPE_LABELS[type]}：${c.occurrences} 处（${c.distinct} 个不同的值）`);
  }
  let tooLarge: string | null = null;
  if (p.tooLarge) {
    tooLarge = scope.kind === 'turn'
      ? (output === 'none' ? `这一轮超过 ${MAX_MB} MB，无法导出` : TOO_LARGE_TEXT)
      : (output === 'none' ? `这个会话太大，整个会话无法导出（不含工具输出也超过 ${MAX_MB} MB），请只导出一轮` : TOO_LARGE_TEXT);
  }
  // Over the limit the scan stopped early (possibly before masking anything): no counts are shown then.
  if (p.tooLarge) rows.length = 0;
  return {
    rows,
    total: p.tooLarge ? '' : p.report.total > 0 ? `共 ${p.report.total} 处` : '没有找到需要遮蔽的内容',
    nodes: `${p.nodeCount} 个节点`,
    size: formatMb(p.estimatedBytes),
    tooLarge,
    partial: p.tooLarge,
    warnings: maskWarnings(p.report),
  };
}

// ---- errors ----

/** A failed export or preview, by HTTP status ('network': no answer). The server's text is never shown. */
export function exportErrorText(status: number | 'network'): string {
  switch (status) {
    case 'network': return '连不上 Agent Canvas 服务，请确认它还在运行';
    case 400: return '导出选项不被接受（选中的那一轮可能已经不在了），请关掉对话框再试';
    case 403: return '请求被拒绝：只能从本机打开的 Agent Canvas 页面导出';
    case 404: return '这个会话已经不存在了';
    case 409: return '自定义词的设置文件已损坏，导出被拒绝：请在下面重新保存自定义词，或关掉“自定义词”';
    case 413: return TOO_LARGE_TEXT;
    case 429: return '同时进行的导出太多，请稍后再试';
    case 501: return '这个版本没有带 HTML 查看器，请改用 Markdown';
    case 503: return '服务正在整理数据库，请稍后再试';
    default: return status >= 500 && status < 600 ? '导出失败：服务出错了，请稍后再试' : `导出失败（HTTP ${status}）`;
  }
}

/** A failed load or save of the custom terms. */
export function settingsErrorText(status: number | 'network'): string {
  switch (status) {
    case 'network': return '连不上 Agent Canvas 服务，自定义词没有读到或没有保存';
    case 400: return '自定义词不符合要求，没有保存';
    case 403: return '请求被拒绝：只能从本机打开的 Agent Canvas 页面修改';
    case 503: return '服务正在整理数据库，请稍后再保存';
    default: return `自定义词读写失败（HTTP ${status}）`;
  }
}

// ---- the downloaded file's name ----

export function fallbackFileName(format: ExportOptions['format']): string {
  return `agent-canvas-export.${format}`;
}

// Separators, reserved characters, control and format characters (bidi overrides): replaced.
const UNSAFE_NAME = /[\\/:*?"<>|\u0000-\u001f\u007f\p{Cf}]/gu;

/**
 * The file name from a Content-Disposition header: `filename*` (RFC 5987, UTF-8) first, then `filename`, else
 * fallbackFileName. Unsafe characters become `_`; a name without the format's extension is not used.
 */
export function fileNameFromDisposition(header: string | null, format: ExportOptions['format']): string {
  const fallback = fallbackFileName(format);
  if (header === null) return fallback;
  let name: string | null = null;
  const star = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (star !== null) {
    const m = /^\s*utf-8'[^']*'(.+?)\s*$/i.exec(star[1]!);
    if (m === null) return fallback;
    try { name = decodeURIComponent(m[1]!); } catch { return fallback; }
  } else {
    const plain = /filename\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(header);
    if (plain !== null) name = plain[1] ?? plain[2] ?? null;
  }
  if (name === null) return fallback;
  name = name.replace(UNSAFE_NAME, '_').trim().slice(0, 200);
  return name.toLowerCase().endsWith(`.${format}`) && name.length > format.length + 1 ? name : fallback;
}

// ---- custom terms ----

export function termsToText(terms: readonly string[]): string {
  return terms.join('\n');
}

/** The editor's text, one term per line, checked line by line with the server's rules (shared validateCustomTerms). */
export function validateTermsText(text: string): { ok: true; terms: string[] } | { ok: false; errors: string[] } {
  const lines = text.split(/\r?\n/);
  const errors: string[] = [];
  let count = 0;
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    count++;
    const one = validateCustomTerms([line]);
    if (!one.ok) errors.push(`第 ${i + 1} 行：${one.error}`);
  });
  if (errors.length > 0) return { ok: false, errors };
  const all = validateCustomTerms(lines);
  if (!all.ok) return { ok: false, errors: [count > CUSTOM_TERMS_MAX ? `最多 ${CUSTOM_TERMS_MAX} 个自定义词（现在 ${count} 个）` : all.error] };
  return { ok: true, terms: all.terms };
}

export const SETTINGS_DAMAGED_NOTE = '自定义词的设置文件已损坏：打开“自定义词”时导出会被拒绝，直到修好文件或在这里重新保存自定义词。';

export type SettingsView =
  | { state: 'loading'; terms: string[]; note: null }
  | { state: 'ok'; terms: string[]; note: null }
  | { state: 'damaged'; terms: string[]; note: string }
  | { state: 'error'; terms: string[]; note: string };

/** The custom terms as loaded (GET /api/export/settings), or why they are not available. */
export function settingsView(r: ExportSettingsResponse | null, error: number | 'network' | null): SettingsView {
  if (r === null) {
    return error === null ? { state: 'loading', terms: [], note: null } : { state: 'error', terms: [], note: settingsErrorText(error) };
  }
  if (r.settingsError !== null) return { state: 'damaged', terms: [], note: SETTINGS_DAMAGED_NOTE };
  return { state: 'ok', terms: r.customTerms, note: null };
}

// ---- requests ----

/** Only the latest request's answer is used: `next()` before sending, `isLatest(n)` when it lands. */
export function createLatest(): { next(): number; isLatest(n: number): boolean } {
  let n = 0;
  return { next: () => ++n, isLatest: (k) => k === n };
}
