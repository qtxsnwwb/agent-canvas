import type { GraphEdge, GraphNode, NodeDetail, Session } from './model.js';
import {
  CUSTOM_TERM_MAX_CHARS,
  CUSTOM_TERM_MIN_CHARS,
  CUSTOM_TERMS_MAX,
  type MaskCategory,
  type MaskReport,
} from './masking.js';

/**
 * Exporting one session (spec 2026-11-13-export-and-masking-design.md, section 4): the options a request carries, the
 * preview answer and the data embedded in an exported HTML file (and rendered as Markdown).
 */

/** The largest export (bytes of the file); a larger one is refused (413) and its preview says tooLarge. */
export const EXPORT_MAX_BYTES = 50 * 1024 * 1024;
/** `output: 'head'`: each step's output is cut to this many UTF-8 bytes (after masking). */
export const EXPORT_OUTPUT_HEAD_BYTES = 8 * 1024;
/** The longest turnKey a request may name. */
export const EXPORT_TURN_KEY_MAX = 512;

/**
 * POST /api/sessions/:id/export(/preview) body. Every field is required and no other is accepted.
 * - scope: the whole session, or one main-thread turn (groupTurns' key) with every subagent dispatched from it.
 * - thinking: include thinking nodes. subagents: include subagent-internal nodes (dispatch nodes always stay).
 * - output: tool output cut to EXPORT_OUTPUT_HEAD_BYTES (`head`), whole (`full`) or left out (`none`).
 * - mask: the masking categories to apply (`custom` uses the terms from the export settings).
 */
export interface ExportOptions {
  format: 'html' | 'md';
  scope: { kind: 'session' } | { kind: 'turn'; turnKey: string };
  thinking: boolean;
  subagents: boolean;
  output: 'head' | 'full' | 'none';
  mask: { credential: boolean; assignment: boolean; personal: boolean; custom: boolean };
}

/** The dialog's defaults (spec 3.1, 4.1): custom on when there are terms. */
export function defaultExportOptions(hasCustomTerms: boolean): ExportOptions {
  return {
    format: 'html',
    scope: { kind: 'session' },
    thinking: true,
    subagents: true,
    output: 'head',
    mask: { credential: true, assignment: true, personal: false, custom: hasCustomTerms },
  };
}

/** The categories an ExportOptions.mask turns on, in MASK_CATEGORIES order. */
export function exportMaskCategories(mask: ExportOptions['mask']): MaskCategory[] {
  const out: MaskCategory[] = [];
  if (mask.credential) out.push('credential');
  if (mask.assignment) out.push('assignment');
  if (mask.personal) out.push('personal');
  if (mask.custom) out.push('custom');
  return out;
}

/**
 * POST /api/sessions/:id/export/preview answer. report: what masking found (types and counts only). estimatedBytes:
 * the size the export would have (HTML: with the viewer template when it exists); when tooLarge, the scan stopped as
 * soon as it passed EXPORT_MAX_BYTES, so report and estimatedBytes cover only the part scanned. nodeCount: nodes in
 * scope after the content options.
 */
export interface ExportPreview {
  report: MaskReport;
  estimatedBytes: number;
  nodeCount: number;
  tooLarge: boolean;
}

/**
 * The data of one export: embedded in the HTML file (`<script id="agent-canvas-export" type="application/json">`) and
 * the input of the Markdown renderer. Everything that came from the session is masked as the options say.
 * - session: title, cwd, gitBranch and projectId masked; id, origin, status and times as stored.
 * - nodes: the nodes in scope, in the session snapshot's order (store order); title, toolName, summary and file paths
 *   masked. Thinking nodes are absent when options.thinking is false, subagent-internal nodes when options.subagents is
 *   false; edges touching an absent node are absent too (nothing is rewired: readers must tolerate gaps).
 * - edges: the edges whose two ends are both in `nodes`.
 * - details: by node id, for nodes with any detail; input, output and text masked; output cut or dropped per
 *   options.output (a cut output, or a structured one over the limit, becomes a string; see `truncations`); `raw` is
 *   always null (the original record is never exported). A node absent from `details` has no detail.
 * - truncations: by node id, the output's size in UTF-8 bytes (after masking, before cutting) where it was cut.
 * - unreadable: nodes whose stored detail could not be decoded (their details entry is empty with unreadable: true).
 * - turnNumber: with a turn scope, the turn's 1-based position among the session's main-thread turns.
 */
export interface ExportBundle {
  version: 1;
  tool: { name: 'Agent Canvas'; version: string };
  exportedAt: string;
  options: ExportOptions;
  report: MaskReport;
  session: Session;
  nodes: GraphNode[];
  edges: GraphEdge[];
  details: Record<string, NodeDetail>;
  truncations: Record<string, { originalBytes: number }>;
  unreadable: string[];
  turnNumber?: number;
}

/** The HTML template's placeholder for the embedded bundle (inside the script element named here). */
export const EXPORT_TEMPLATE_PLACEHOLDER = '__AGENT_CANVAS_EXPORT__';
export const EXPORT_SCRIPT_ID = 'agent-canvas-export';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function exactKeys(o: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) if (!Object.prototype.hasOwnProperty.call(o, k)) return `缺少字段 ${k}`;
  for (const k of Object.keys(o)) if (!keys.includes(k)) return `未知字段 ${k}`;
  return null;
}

/** Strict validation of an ExportOptions body: a missing, unknown or mistyped field is an error (in Chinese). */
export function parseExportOptions(body: unknown): { ok: true; options: ExportOptions } | { ok: false; error: string } {
  if (!isObject(body)) return { ok: false, error: '导出选项必须是一个对象' };
  const keysError = exactKeys(body, ['format', 'scope', 'thinking', 'subagents', 'output', 'mask']);
  if (keysError) return { ok: false, error: keysError };
  const { format, scope, thinking, subagents, output, mask } = body;
  if (format !== 'html' && format !== 'md') return { ok: false, error: 'format 只能是 html 或 md' };
  if (!isObject(scope)) return { ok: false, error: 'scope 必须是一个对象' };
  let parsedScope: ExportOptions['scope'];
  if (scope.kind === 'session') {
    const e = exactKeys(scope, ['kind']);
    if (e) return { ok: false, error: `scope：${e}` };
    parsedScope = { kind: 'session' };
  } else if (scope.kind === 'turn') {
    const e = exactKeys(scope, ['kind', 'turnKey']);
    if (e) return { ok: false, error: `scope：${e}` };
    if (typeof scope.turnKey !== 'string' || scope.turnKey === '' || scope.turnKey.length > EXPORT_TURN_KEY_MAX) {
      return { ok: false, error: 'scope.turnKey 必须是非空字符串' };
    }
    parsedScope = { kind: 'turn', turnKey: scope.turnKey };
  } else return { ok: false, error: 'scope.kind 只能是 session 或 turn' };
  if (typeof thinking !== 'boolean') return { ok: false, error: 'thinking 必须是布尔值' };
  if (typeof subagents !== 'boolean') return { ok: false, error: 'subagents 必须是布尔值' };
  if (output !== 'head' && output !== 'full' && output !== 'none') return { ok: false, error: 'output 只能是 head、full 或 none' };
  if (!isObject(mask)) return { ok: false, error: 'mask 必须是一个对象' };
  const maskError = exactKeys(mask, ['credential', 'assignment', 'personal', 'custom']);
  if (maskError) return { ok: false, error: `mask：${maskError}` };
  for (const k of ['credential', 'assignment', 'personal', 'custom'] as const) {
    if (typeof mask[k] !== 'boolean') return { ok: false, error: `mask.${k} 必须是布尔值` };
  }
  return {
    ok: true,
    options: {
      format,
      scope: parsedScope,
      thinking,
      subagents,
      output,
      mask: {
        credential: mask.credential as boolean,
        assignment: mask.assignment as boolean,
        personal: mask.personal as boolean,
        custom: mask.custom as boolean,
      },
    },
  };
}

/**
 * GET /api/export/settings (and PUT's answer). customTerms: the custom masking terms. settingsError: why the stored
 * settings could not be read (they then count as empty); null when fine.
 */
export interface ExportSettingsResponse {
  customTerms: string[];
  settingsError: string | null;
}

/** PUT /api/export/settings body. */
export interface ExportSettings {
  customTerms: string[];
}

const ascii = (s: string): string => s.replace(/[A-Z]+/g, (x) => x.toLowerCase());
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Validates a list of custom terms: strings only; each trimmed; empty ones dropped; duplicates (ASCII-case-insensitive)
 * dropped, the first kept; each CUSTOM_TERM_MIN_CHARS..CUSTOM_TERM_MAX_CHARS characters without control characters; at
 * most CUSTOM_TERMS_MAX after that.
 */
export function validateCustomTerms(terms: unknown): { ok: true; terms: string[] } | { ok: false; error: string } {
  if (!Array.isArray(terms)) return { ok: false, error: 'customTerms 必须是字符串数组' };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of terms) {
    if (typeof t !== 'string') return { ok: false, error: 'customTerms 必须是字符串数组' };
    const term = t.trim();
    if (term === '') continue;
    const n = [...term].length;
    if (n < CUSTOM_TERM_MIN_CHARS) return { ok: false, error: `自定义词至少 ${CUSTOM_TERM_MIN_CHARS} 个字符` };
    if (n > CUSTOM_TERM_MAX_CHARS) return { ok: false, error: `自定义词最多 ${CUSTOM_TERM_MAX_CHARS} 个字符` };
    if (CONTROL.test(term)) return { ok: false, error: '自定义词不能包含控制字符' };
    const key = ascii(term);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  if (out.length > CUSTOM_TERMS_MAX) return { ok: false, error: `自定义词最多 ${CUSTOM_TERMS_MAX} 个` };
  return { ok: true, terms: out };
}

/** Strict validation of a PUT /api/export/settings body ({ customTerms } and nothing else). */
export function parseExportSettings(body: unknown): { ok: true; settings: ExportSettings } | { ok: false; error: string } {
  if (!isObject(body)) return { ok: false, error: '设置必须是一个对象' };
  const e = exactKeys(body, ['customTerms']);
  if (e) return { ok: false, error: e };
  const checked = validateCustomTerms(body.customTerms);
  if (!checked.ok) return checked;
  return { ok: true, settings: { customTerms: checked.terms } };
}
