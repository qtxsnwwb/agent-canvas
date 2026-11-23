import type { Origin } from '@agent-canvas/shared';

/*
 * Explanation texts the attention page builds itself (spec 4.3). The result is still cut to 200 characters and masked
 * by the page, as every explanation.
 */

/** Input fields that name what a call does, in this order: the command, else the file, else the address / pattern. */
const PERMISSION_FIELDS = ['command', 'cmd', 'file_path', 'filePath', 'absolute_path', 'notebook_path', 'path', 'url', 'pattern'] as const;

/**
 * A waiting call's line: its tool name and what it is about to do — the command (a Codex command array joined with
 * spaces) or the file path from the call's input, rather than the input JSON its summary holds (normalize/summary.ts:
 * JSON of the input, whitespace collapsed, cut at SUMMARY_MAX with `…`). A cut summary is searched as text: a field
 * whose value the cut went through gives what is there, ending in `…`. The summary as it is when no field is found.
 */
export function permissionText(toolName: string | null, title: string, summary: string): string {
  const detail = inputDetail(summary) ?? summary;
  return [toolName ?? title, detail].filter((x) => x !== '').join(' · ');
}

function inputDetail(summary: string): string | null {
  if (!summary.startsWith('{')) return null;
  if (!summary.endsWith('…')) {
    try {
      const input: unknown = JSON.parse(summary);
      if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
        for (const field of PERMISSION_FIELDS) {
          const v = (input as Record<string, unknown>)[field];
          if (typeof v === 'string' && v !== '') return v;
          if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')) return v.join(' ');
        }
      }
      return null;
    } catch {
      // not JSON after all: read it as text below
    }
  }
  for (const field of PERMISSION_FIELDS) {
    const found = fieldInText(summary, field);
    if (found !== null && found !== '') return found;
  }
  return null;
}

/** The value of `"field": "…"` or `"field": ["…", …]` in JSON text that may be cut short; null when absent. */
function fieldInText(text: string, field: string): string | null {
  const key = `"${field}"`;
  for (let at = text.indexOf(key); at >= 0; at = text.indexOf(key, at + 1)) {
    // A key, not text inside a string value: there an inner quote is escaped (`\"field\"`).
    if (at > 0 && text[at - 1] === '\\') continue;
    let i = at + key.length;
    while (text[i] === ' ') i += 1;
    if (text[i] !== ':') continue;
    i += 1;
    while (text[i] === ' ') i += 1;
    if (text[i] === '"') return readString(text, i + 1).value;
    if (text[i] !== '[') continue;
    const parts: string[] = [];
    i += 1;
    for (;;) {
      while (text[i] === ' ' || text[i] === ',') i += 1;
      if (text[i] !== '"') break;
      const s = readString(text, i + 1);
      parts.push(s.value);
      if (!s.closed) break;
      i = s.end;
    }
    return parts.length > 0 ? parts.join(' ') : null;
  }
  return null;
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };

/** A JSON string's content from `start` (after its opening quote), unescaped; `closed` false when the text ends first. */
function readString(text: string, start: number): { value: string; closed: boolean; end: number } {
  let out = '';
  let i = start;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') return { value: out, closed: true, end: i + 1 };
    if (c === '\\' && i + 1 < text.length) {
      const e = text[i + 1]!;
      if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
        out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
        i += 6;
        continue;
      }
      out += ESCAPES[e] ?? e;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return { value: out, closed: false, end: i };
}

/** A short error code a hook may carry (`rate_limit`, `server_error`): letters, digits and `_.:-`, at most 40. */
const ERROR_TOKEN = /^[A-Za-z0-9_.:-]{1,40}$/;

/**
 * The reason of an error known only from a hook (isErrorHook): a fixed phrase for the hook, plus the payload's `error`
 * when it is a short code — never anything else from the payload.
 */
export function hookErrorText(origin: Origin, eventName: string, payload: Readonly<Record<string, unknown>> | null): string {
  let phrase = '出错';
  if (origin === 'claude' && eventName === 'StopFailure') phrase = '接口报错';
  else if (origin === 'codex' && eventName === 'Interrupt') phrase = '被中断';
  else if (origin === 'cursor' && eventName === 'stop') phrase = payload?.status === 'aborted' ? '对话被中止' : '出错';
  const token = payload?.error;
  return typeof token === 'string' && ERROR_TOKEN.test(token) ? `${phrase}（${token}）` : phrase;
}
