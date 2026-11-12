/**
 * Files a tool call names, from structured tool inputs only (never from command lines; the one exception is the fixed
 * `apply_patch` format). Each origin's normalizer turns its call into raw touches here, then `nodeFiles` normalizes
 * the paths, drops duplicates and caps the list.
 */
import { MAX_FILES_PER_NODE, normalizeFilePath, type FileAction, type FileTouch, type GraphNode } from '@agent-canvas/shared';

/** A path as the tool input wrote it, with the action. */
export interface RawTouch {
  path: string;
  action: FileAction;
}

/** The `files` / `filesTruncated` fields of a node; both absent when the call names no file. */
export interface NodeFiles {
  files?: FileTouch[];
  filesTruncated?: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Identity of a path for de-duplication: case-insensitive for Windows-style paths (drive letter or UNC). */
function pathKey(path: string): string {
  return /^[A-Za-z]:/.test(path) || path.startsWith('//') ? path.toLowerCase() : path;
}

/**
 * Normalized touches: empty paths dropped, unique (path, action) pairs in first-seen order, at most MAX_FILES_PER_NODE
 * (then `filesTruncated: true`). `{}` when nothing is left.
 */
export function nodeFiles(touches: Iterable<RawTouch>, cwd: string | null): NodeFiles {
  const files: FileTouch[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const t of touches) {
    const path = normalizeFilePath(t.path, cwd);
    if (path === '') continue;
    const key = `${t.action}\u0000${pathKey(path)}`;
    if (seen.has(key)) continue;
    if (files.length >= MAX_FILES_PER_NODE) {
      truncated = true;
      break;
    }
    seen.add(key);
    files.push({ path, action: t.action });
  }
  if (files.length === 0) return {};
  return truncated ? { files, filesTruncated: true } : { files };
}

const sameFiles = (a: FileTouch[] | undefined, b: FileTouch[] | undefined): boolean =>
  (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((f, i) => f.path === b![i]!.path && f.action === b![i]!.action);

/**
 * The patch that makes `node` carry `next`: empty when it already does. A field that goes away is set to undefined
 * (dropped when the node is serialized).
 */
export function filesPatch(node: GraphNode, next: NodeFiles): Partial<GraphNode> {
  const patch: Partial<GraphNode> = {};
  if (!sameFiles(node.files, next.files)) patch.files = next.files;
  if ((node.filesTruncated ?? false) !== (next.filesTruncated ?? false)) patch.filesTruncated = next.filesTruncated;
  return patch;
}

/** The node fields for `next`, with absent fields left out (for building a new node). */
export function filesFields(next: NodeFiles): NodeFiles {
  const out: NodeFiles = {};
  if (next.files !== undefined) out.files = next.files;
  if (next.filesTruncated) out.filesTruncated = true;
  return out;
}

/** Whether two nodes carry the same files. */
export function sameNodeFiles(a: GraphNode, b: GraphNode): boolean {
  return sameFiles(a.files, b.files) && (a.filesTruncated ?? false) === (b.filesTruncated ?? false);
}

const stringField = (input: Record<string, unknown>, key: string): string | null => {
  const v = input[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
};

// ---- Claude Code ----

const CLAUDE_TOOLS: Record<string, { key: string; action: FileAction }> = {
  Read: { key: 'file_path', action: 'read' },
  Edit: { key: 'file_path', action: 'edit' },
  MultiEdit: { key: 'file_path', action: 'edit' },
  Write: { key: 'file_path', action: 'write' },
  NotebookEdit: { key: 'notebook_path', action: 'edit' },
};

/** The file a Claude Code tool_use names (Read / Edit / MultiEdit / Write / NotebookEdit). */
export function claudeTouches(toolName: string, input: unknown): RawTouch[] {
  const spec = Object.hasOwn(CLAUDE_TOOLS, toolName) ? CLAUDE_TOOLS[toolName] : undefined;
  if (spec === undefined || !isObject(input)) return [];
  const path = stringField(input, spec.key);
  return path === null ? [] : [{ path, action: spec.action }];
}

// ---- Cursor ----

const CURSOR_TOOLS: Record<string, { key: string; action: FileAction }> = {
  read_file_v2: { key: 'targetFile', action: 'read' },
  edit_file_v2: { key: 'relativeWorkspacePath', action: 'edit' },
  delete_file: { key: 'relativeWorkspacePath', action: 'delete' },
};

/** The file a Cursor tool call names, from its parsed `params` (a string = params that did not parse: none). */
export function cursorTouches(toolName: string | null, params: unknown): RawTouch[] {
  const spec = toolName !== null && Object.hasOwn(CURSOR_TOOLS, toolName) ? CURSOR_TOOLS[toolName] : undefined;
  if (spec === undefined || !isObject(params)) return [];
  const path = stringField(params, spec.key);
  return path === null ? [] : [{ path, action: spec.action }];
}

// ---- Codex ----

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const HEADERS: { prefix: string; action: FileAction }[] = [
  { prefix: '*** Update File: ', action: 'edit' },
  { prefix: '*** Add File: ', action: 'write' },
  { prefix: '*** Delete File: ', action: 'delete' },
  { prefix: '*** Move to: ', action: 'write' },
];

/**
 * The files of every `apply_patch` body in `text`. A body starts at a line that is exactly `*** Begin Patch` and ends
 * at a line that is exactly `*** End Patch` (trailing whitespace / CR allowed); in between, a line starting at column
 * 0 with `*** Update File: `, `*** Add File: `, `*** Delete File: ` or `*** Move to: ` names a file (edit / write /
 * delete / write: a move keeps its source as edit). Hunk lines start with ' ', '+' or '-', so file content never
 * matches. A body without its end (a stored input cut short) ends with the text, and its last line counts only when
 * a line break follows it (a cut line is not a complete header).
 */
export function applyPatchTouches(text: string): RawTouch[] {
  if (!text.includes(BEGIN)) return [];
  const out: RawTouch[] = [];
  const lines = text.split('\n');
  let inside = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, '');
    const bare = line.trimEnd();
    if (!inside) {
      if (bare === BEGIN) inside = true;
      continue;
    }
    if (bare === END) {
      inside = false;
      continue;
    }
    if (i === lines.length - 1) break; // no line break after it: possibly cut
    for (const h of HEADERS) {
      if (!line.startsWith(h.prefix)) continue;
      const path = line.slice(h.prefix.length).trim();
      if (path !== '') out.push({ path, action: h.action });
      break;
    }
  }
  return out;
}

/** Every string in a value (strings in arrays and objects, depth-first), for finding patch bodies in call inputs. */
function strings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (typeof v === 'string') out.push(v);
  else if (depth < 8 && Array.isArray(v)) for (const x of v) strings(x, out, depth + 1);
  else if (depth < 8 && isObject(v)) for (const x of Object.values(v)) strings(x, out, depth + 1);
  return out;
}

/** The files of the `apply_patch` bodies in a Codex call's input (a text, or the parsed arguments of a function call). */
export function codexCallTouches(input: unknown): RawTouch[] {
  return strings(input).flatMap(applyPatchTouches);
}

/** The action a FileChange value describes: add → write, delete → delete, otherwise edit. */
function changeAction(value: unknown): FileAction {
  let kind: unknown = value;
  if (isObject(value)) {
    kind = value.type ?? value.kind;
    if (isObject(kind)) kind = kind.type;
    if (kind === undefined) {
      const keys = Object.keys(value);
      if (keys.length === 1) kind = keys[0]; // externally tagged: { add: {...} }
    }
  }
  const k = typeof kind === 'string' ? kind.toLowerCase() : '';
  if (k === 'add') return 'write';
  if (k === 'delete') return 'delete';
  return 'edit';
}

/** A FileChange value's move destination (`move_path` of an update), if any. */
function movePath(value: unknown): string | null {
  if (!isObject(value)) return null;
  const inner = isObject(value.update) ? value.update : isObject(value.kind) ? value.kind : value;
  const v = inner.move_path ?? inner.movePath;
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** The files of a Codex `FileChange` item: the keys of `changes` (a move's destination as write). */
export function fileChangeTouches(item: Record<string, unknown>): RawTouch[] {
  const changes = item.changes;
  if (!isObject(changes)) return [];
  const out: RawTouch[] = [];
  for (const [path, value] of Object.entries(changes)) {
    if (path.trim() === '') continue;
    out.push({ path, action: changeAction(value) });
    const dest = movePath(value);
    if (dest !== null) out.push({ path: dest, action: 'write' });
  }
  return out;
}

/**
 * Merges another source's touches of the same call into `base` (both normalized): a pair already there is skipped; for
 * a path `base` has, an `edit` is dropped when `base` has a more specific action for it, and a `write` / `delete`
 * replaces `base`'s `edit` of that path; anything else is appended. The result is capped like `nodeFiles`.
 */
export function mergeFiles(base: NodeFiles, other: NodeFiles): NodeFiles {
  const files = [...(base.files ?? [])];
  let truncated = base.filesTruncated === true || other.filesTruncated === true;
  for (const t of other.files ?? []) {
    const key = pathKey(t.path);
    const same = files.filter((f) => pathKey(f.path) === key);
    if (same.some((f) => f.action === t.action)) continue;
    if (same.length > 0 && t.action === 'edit' && same.some((f) => f.action !== 'read')) continue;
    const editAt = t.action === 'write' || t.action === 'delete' ? files.findIndex((f) => pathKey(f.path) === key && f.action === 'edit') : -1;
    if (editAt >= 0) {
      files[editAt] = t;
      continue;
    }
    if (files.length >= MAX_FILES_PER_NODE) {
      truncated = true;
      continue;
    }
    files.push(t);
  }
  if (files.length === 0) return {};
  return truncated ? { files, filesTruncated: true } : { files };
}
