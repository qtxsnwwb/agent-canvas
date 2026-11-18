/**
 * Files a tool call names, from structured tool inputs only (never from command lines; the one exception is the fixed
 * `apply_patch` format). Each origin's normalizer turns its call into raw touches here, then `nodeFiles` normalizes
 * the paths, drops duplicates and caps the list.
 */
import { MAX_FILES_PER_NODE, normalizeFilePath, pathKey, type FileAction, type FileTouch, type GraphNode } from '@agent-canvas/shared';

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
 * The patch that makes `node` carry `next`: empty when it already does. Files that go away are cleared with an
 * explicit `files: []` / `filesTruncated: false` (an empty list means "no files", as an absent field does), never
 * with undefined: a patch goes through JSON (store, change log, websocket), where an undefined field would vanish and
 * leave the old value in place on every consumer that merges patches.
 */
export function filesPatch(node: GraphNode, next: NodeFiles): Partial<GraphNode> {
  const patch: Partial<GraphNode> = {};
  if (!sameFiles(node.files, next.files)) patch.files = next.files ?? [];
  if ((node.filesTruncated ?? false) !== (next.filesTruncated ?? false)) patch.filesTruncated = next.filesTruncated ?? false;
  return patch;
}

/** The node fields for `next`, with absent fields left out (for building a new node). */
export function filesFields(next: NodeFiles): NodeFiles {
  const out: NodeFiles = {};
  if (next.files !== undefined) out.files = next.files;
  if (next.filesTruncated) out.filesTruncated = true;
  return out;
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

/**
 * The string value of `key` in JSON text that does not parse (params cut at the stored cap): the first `"key": "…"`
 * whose value is a complete JSON string (its closing quote is in the text), JSON escapes decoded. A quoted key inside
 * another string value is escaped there (`\"key\"`), so it cannot match. Null when the text was cut before or inside
 * the value, or the value is not a string.
 */
function stringFieldFromText(text: string, key: string): string | null {
  const re = new RegExp(`(?<!\\\\)"${key}"\\s*:\\s*"((?:[^"\\\\\\u0000-\\u001f]|\\\\.)*)"`);
  const m = re.exec(text);
  if (m === null) return null;
  try {
    const v = JSON.parse(`"${m[1]}"`) as unknown;
    return typeof v === 'string' && v.trim() !== '' ? v : null;
  } catch {
    return null;
  }
}

/**
 * The file a Cursor tool call names, from its parsed `params`; params that did not parse (a string: cut at the cap)
 * give the tool's own path field read by its key from the text (see stringFieldFromText).
 */
export function cursorTouches(toolName: string | null, params: unknown): RawTouch[] {
  const spec = toolName !== null && Object.hasOwn(CURSOR_TOOLS, toolName) ? CURSOR_TOOLS[toolName] : undefined;
  if (spec === undefined) return [];
  const path = isObject(params) ? stringField(params, spec.key) : typeof params === 'string' ? stringFieldFromText(params, spec.key) : null;
  return path === null ? [] : [{ path, action: spec.action }];
}

// ---- Gemini CLI ----

/** Gemini CLI tools that read or change one named file (spec 5.1's table; search / shell / subagent tools touch none). */
const GEMINI_TOOLS: Record<string, FileAction> = {
  read_file: 'read',
  read_many_files: 'read',
  write_file: 'write',
  replace: 'edit',
};
/** Path arguments, tried in this order (current and older argument names). */
const GEMINI_PATH_KEYS = ['file_path', 'absolute_path', 'path', 'dir_path', 'directory'];

/** The file a Gemini CLI tool call names: the first path argument present (GEMINI_PATH_KEYS order). */
export function geminiTouches(toolName: string | null, args: unknown): RawTouch[] {
  const action = toolName !== null && Object.hasOwn(GEMINI_TOOLS, toolName) ? GEMINI_TOOLS[toolName] : undefined;
  if (action === undefined || !isObject(args)) return [];
  for (const key of GEMINI_PATH_KEYS) {
    const path = stringField(args, key);
    if (path !== null) return [{ path, action }];
  }
  return [];
}

// ---- GitHub Copilot CLI ----

/** Copilot CLI tools that read or change a named file (spec 5.3's table; shell / search / subagent tools touch none). */
const COPILOT_TOOLS: Record<string, FileAction> = {
  view: 'read',
  create: 'write',
  edit: 'edit',
  apply_patch: 'edit',
};
/** Path arguments, tried in this order (spec 5.3). */
const COPILOT_PATH_KEYS = ['path', 'file_path', 'filePath', 'fileName'];
/** Where an `apply_patch` call may carry its patch text when it names no path (argument name unverified). */
const COPILOT_PATCH_KEYS = ['input', 'patch'];

/**
 * The file a Copilot CLI tool call names: the first path argument present (COPILOT_PATH_KEYS order). `args` given as a
 * JSON string is parsed first. An `apply_patch` call without a path argument: the files of its patch text (the
 * arguments themselves when they are a string that is not JSON, else an `input` / `patch` argument).
 */
export function copilotTouches(toolName: string | null, args: unknown): RawTouch[] {
  const action = toolName !== null && Object.hasOwn(COPILOT_TOOLS, toolName) ? COPILOT_TOOLS[toolName] : undefined;
  if (action === undefined) return [];
  let parsed: unknown = args;
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args);
    } catch {
      parsed = args;
    }
  }
  if (isObject(parsed)) {
    for (const key of COPILOT_PATH_KEYS) {
      const path = stringField(parsed, key);
      if (path !== null) return [{ path, action }];
    }
  }
  if (toolName !== 'apply_patch') return [];
  if (typeof parsed === 'string') return applyPatchTouches(parsed);
  if (!isObject(parsed)) return [];
  for (const key of COPILOT_PATCH_KEYS) {
    const v = parsed[key];
    if (typeof v === 'string') return applyPatchTouches(v);
  }
  return [];
}

// ---- Grok Build ----

/** What a Grok Build tool does (spec 5.2's table): the categories of spec 4.4. */
export type GrokToolCategory = 'read' | 'write' | 'edit' | 'delete' | 'exec' | 'search' | 'subagent' | 'other';

/** Grok Build wire tool names (every toolset's aliases, spec 5.2). Names not here are `other`. */
const GROK_TOOLS: Record<string, GrokToolCategory> = {
  run_terminal_cmd: 'exec',
  run_terminal_command: 'exec',
  bash: 'exec',
  read_file: 'read',
  read: 'read',
  write: 'write',
  write_file: 'write',
  search_replace: 'edit',
  edit: 'edit',
  edit_file: 'edit',
  hashline_edit: 'edit',
  apply_patch: 'edit',
  list_dir: 'search',
  glob: 'search',
  grep: 'search',
  task: 'subagent',
  Task: 'subagent',
  spawn_subagent: 'subagent',
};
/**
 * ACP `kind` of a call whose tool name is not known (spec 5.2). `move` is taken as a write (of the file it names; a
 * move's destination is a write in the Codex table too); `think`, `other` and anything else: other.
 */
const GROK_KINDS: Record<string, GrokToolCategory> = {
  read: 'read',
  edit: 'edit',
  delete: 'delete',
  move: 'write',
  search: 'search',
  execute: 'exec',
  fetch: 'other',
};
/** Path arguments, tried in this order before `locations[0].path` (spec 5.2). */
const GROK_PATH_KEYS = ['target_file', 'file_path', 'path', 'target_directory', 'filePath'];
/** Where an `apply_patch` call may carry its patch text (argument name unverified). */
const GROK_PATCH_KEYS = ['input', 'patch'];

/** The category of a Grok Build call: by tool name when there is one (not in the table: other), else by ACP `kind`. */
export function grokToolCategory(toolName: string | null, kind: string | null): GrokToolCategory {
  if (toolName !== null) return Object.hasOwn(GROK_TOOLS, toolName) ? GROK_TOOLS[toolName]! : 'other';
  return kind !== null && Object.hasOwn(GROK_KINDS, kind) ? GROK_KINDS[kind]! : 'other';
}

/**
 * The file a Grok Build call names, for calls that read, write, edit or delete one (grokToolCategory): the first path
 * argument of `rawInput` present (GROK_PATH_KEYS order), else (an `apply_patch`) the files of its patch text, else the
 * first entry of the ACP `locations`.
 */
export function grokTouches(toolName: string | null, kind: string | null, rawInput: unknown, locations: unknown): RawTouch[] {
  const category = grokToolCategory(toolName, kind);
  if (category !== 'read' && category !== 'write' && category !== 'edit' && category !== 'delete') return [];
  const action: FileAction = category;
  if (isObject(rawInput)) {
    for (const key of GROK_PATH_KEYS) {
      const path = stringField(rawInput, key);
      if (path !== null) return [{ path, action }];
    }
  }
  if (toolName === 'apply_patch') {
    if (typeof rawInput === 'string') {
      const t = applyPatchTouches(rawInput);
      if (t.length > 0) return t;
    } else if (isObject(rawInput)) {
      for (const key of GROK_PATCH_KEYS) {
        const v = rawInput[key];
        if (typeof v !== 'string') continue;
        const t = applyPatchTouches(v);
        if (t.length > 0) return t;
      }
    }
  }
  if (Array.isArray(locations) && isObject(locations[0])) {
    const path = stringField(locations[0], 'path');
    if (path !== null) return [{ path, action }];
  }
  return [];
}

// ---- DeepSeek Harness ----

/**
 * DeepSeek Harness tool names taken as file tools (spec section 10 item 16). The format reference evidences `bash` and
 * `subagent` only: this table is a conservative guess at common names, unverified against a real session.
 */
const DEEPSEEK_TOOLS: Record<string, FileAction> = {
  read: 'read',
  read_file: 'read',
  view: 'read',
  write: 'write',
  write_file: 'write',
  create: 'write',
  create_file: 'write',
  edit: 'edit',
  edit_file: 'edit',
  multi_edit: 'edit',
  str_replace: 'edit',
  replace: 'edit',
  search_replace: 'edit',
  apply_patch: 'edit',
  delete: 'delete',
  delete_file: 'delete',
  remove_file: 'delete',
};
/** Path arguments, tried in this order (unverified names). */
const DEEPSEEK_PATH_KEYS = ['path', 'file_path', 'filePath', 'file', 'target_file', 'filename'];
/** Where an `apply_patch` call may carry its patch text when it names no path (unverified names). */
const DEEPSEEK_PATCH_KEYS = ['input', 'patch'];

/**
 * The file a DeepSeek Harness tool call names (DEEPSEEK_TOOLS): the first path argument present (DEEPSEEK_PATH_KEYS
 * order); `input` given as a JSON string (the model's raw arguments) is parsed first, and arguments that do not parse
 * name no file. An `apply_patch` call without a path argument: the files of its patch text.
 */
export function deepseekTouches(toolName: string, input: unknown): RawTouch[] {
  const action = Object.hasOwn(DEEPSEEK_TOOLS, toolName) ? DEEPSEEK_TOOLS[toolName] : undefined;
  if (action === undefined) return [];
  let parsed: unknown = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch {
      return toolName === 'apply_patch' ? applyPatchTouches(input) : [];
    }
  }
  if (!isObject(parsed)) return [];
  for (const key of DEEPSEEK_PATH_KEYS) {
    const path = stringField(parsed, key);
    if (path !== null) return [{ path, action }];
  }
  if (toolName !== 'apply_patch') return [];
  for (const key of DEEPSEEK_PATCH_KEYS) {
    const v = parsed[key];
    if (typeof v === 'string') return applyPatchTouches(v);
  }
  return [];
}

// ---- WorkBuddy / CodeBuddy Code ----

/**
 * File tools of the Buddy engine by name (spec section 10 item 16). The format reference (docs/formats/buddy-family.md)
 * evidences the tool name `Bash` (its example records) and an Agent tool whose name and argument keys it lists as open
 * (section 10 item 4); it records no file tool and no path argument. This table is therefore a conservative guess,
 * unverified on real transcripts: the Claude-Code-style names (`Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`
 * with `file_path` / `notebook_path`: a code review found them in the engine package, but the format reference does not
 * record them), plus the snake_case names of the CodeBuddy IDE family.
 */
const BUDDY_TOOLS: Record<string, FileAction> = {
  Read: 'read',
  read_file: 'read',
  Write: 'write',
  write_file: 'write',
  write_to_file: 'write',
  create_file: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  edit_file: 'edit',
  replace_in_file: 'edit',
  search_replace: 'edit',
  str_replace: 'edit',
  Delete: 'delete',
  delete_file: 'delete',
};
/** Path arguments, tried in this order (unverified names). */
const BUDDY_PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'target_file', 'file', 'filename'];

/**
 * The file a Buddy tool call names (BUDDY_TOOLS): the first path argument present (BUDDY_PATH_KEYS order); `input`
 * given as a JSON string (the call's raw `arguments`) is parsed first, and arguments that do not parse name no file.
 */
export function buddyTouches(toolName: string, input: unknown): RawTouch[] {
  const action = Object.hasOwn(BUDDY_TOOLS, toolName) ? BUDDY_TOOLS[toolName] : undefined;
  if (action === undefined) return [];
  let parsed: unknown = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch {
      return [];
    }
  }
  if (!isObject(parsed)) return [];
  for (const key of BUDDY_PATH_KEYS) {
    const path = stringField(parsed, key);
    if (path !== null) return [{ path, action }];
  }
  return [];
}

// ---- Doubao Work ----

/**
 * File tools of Doubao Work by name (spec section 10 item 16): the format reference evidences the names `Read`, `Write`
 * and `Edit` (besides `Bash`, `PowerShell`, `Wait`, `create_agent`, `present_files`, which name no file here) but none
 * of their argument names, so the path arguments are a conservative guess, unverified.
 */
const DOUBAO_TOOLS: Record<string, FileAction> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
};
/** Path arguments, tried in this order (unverified names). */
const DOUBAO_PATH_KEYS = ['file_path', 'filePath', 'path', 'file', 'target_file', 'filename'];

/**
 * The file a Doubao Work tool call names (DOUBAO_TOOLS): the first path argument present (DOUBAO_PATH_KEYS order);
 * `arguments` given as a JSON string is parsed first, and arguments that do not parse to an object name no file.
 */
export function doubaoTouches(toolName: string, input: unknown): RawTouch[] {
  const action = Object.hasOwn(DOUBAO_TOOLS, toolName) ? DOUBAO_TOOLS[toolName] : undefined;
  if (action === undefined) return [];
  let parsed: unknown = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch {
      return [];
    }
  }
  if (!isObject(parsed)) return [];
  for (const key of DOUBAO_PATH_KEYS) {
    const path = stringField(parsed, key);
    if (path !== null) return [{ path, action }];
  }
  return [];
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

/** Codex tools that run a command or apply a patch (full tool name, `namespace.name` when namespaced). */
const PATCH_TOOLS = new Set(['exec', 'shell', 'local_shell', 'container.exec', 'shell_command', 'exec_command', 'apply_patch']);
/** The arguments of those tools that hold the command, script or patch text. */
const PATCH_ARGS = ['command', 'cmd', 'script', 'input', 'patch'];

/**
 * The files of the `apply_patch` bodies a Codex call runs: only for PATCH_TOOLS, and only in the text input of a
 * custom call or the command / script / input arguments of a function call (a string, or a list of strings). Patch
 * text quoted anywhere else (a message to a subagent, an MCP tool's content, …) is never read.
 */
export function codexCallTouches(toolName: string, input: unknown): RawTouch[] {
  if (!PATCH_TOOLS.has(toolName)) return [];
  if (typeof input === 'string') return applyPatchTouches(input);
  if (!isObject(input)) return [];
  const out: RawTouch[] = [];
  for (const key of PATCH_ARGS) {
    const v = input[key];
    if (typeof v === 'string') out.push(...applyPatchTouches(v));
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') out.push(...applyPatchTouches(x));
  }
  return out;
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
