/**
 * Gemini CLI's session log (spec 5.1) as operations on one thread's messages: each JSONL line is one of five record
 * kinds, told apart in this order — `{"$rewindTo": id}`, `{"$patch": {...}}`, an object with a string `id` (a message;
 * a repeated id replaces it whole, keeping its position), `{"$set": {...}}` (metadata merge; a `messages` array in it
 * replaces every message), an object with `sessionId` and `projectHash` (the metadata line). The reducer reads the
 * thread state but never changes it (`applyGeminiOps` does) and knows nothing of the graph.
 */
import { unknownTypeName } from './unknown-type.js';

export type GeminiObj = Record<string, unknown>;

/** One thread's messages in order of first appearance, and its metadata. */
export interface GeminiThreadState {
  order: string[];
  messages: Map<string, GeminiObj>;
  meta: GeminiObj;
}

export type GeminiOp =
  | { op: 'upsertMessage'; id: string; message: GeminiObj }
  | { op: 'removeMessages'; ids: string[] }
  | { op: 'setMeta'; meta: GeminiObj }
  | { op: 'replaceAll'; messages: GeminiObj[] }
  /** A line that is none of the five kinds (or not JSON): `type` is its unknownRecordType. */
  | { op: 'unknown'; type: string };

export const emptyGeminiState = (): GeminiThreadState => ({ order: [], messages: new Map(), meta: {} });

const isObject = (v: unknown): v is GeminiObj => typeof v === 'object' && v !== null && !Array.isArray(v);
const unknown = (raw: unknown): GeminiOp => ({ op: 'unknown', type: unknownTypeName('gemini', raw) });

/** The ops of one JSONL line. Never throws. */
export function reduceGemini(state: Readonly<GeminiThreadState>, line: string): GeminiOp[] {
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return [unknown('invalid-json')];
  }
  if (!isObject(rec)) return [unknown('not-an-object')];
  if ('$rewindTo' in rec) return rewind(state, rec.$rewindTo);
  if ('$patch' in rec) return isObject(rec.$patch) ? patch(state, rec.$patch) : [unknown('$patch')];
  if (typeof rec.id === 'string') return [{ op: 'upsertMessage', id: rec.id, message: rec }];
  if ('$set' in rec) return isObject(rec.$set) ? set(rec.$set) : [unknown('$set')];
  if (typeof rec.sessionId === 'string' && 'projectHash' in rec) return [{ op: 'setMeta', meta: rec }];
  const dollar = Object.keys(rec).find((k) => k.startsWith('$'));
  return [unknown(dollar ?? (typeof rec.type === 'string' ? rec.type : undefined))];
}

/** A legacy `session-*.json` (the whole conversation object): its metadata, then every message replaced. */
export function reduceGeminiLegacy(text: string): GeminiOp[] {
  let rec: unknown;
  try {
    rec = JSON.parse(text);
  } catch {
    return [unknown('invalid-json')];
  }
  if (!isObject(rec)) return [unknown('not-an-object')];
  const { messages, ...meta } = rec;
  return [{ op: 'setMeta', meta }, { op: 'replaceAll', messages: Array.isArray(messages) ? messages.filter(isMessage) : [] }];
}

const isMessage = (m: unknown): m is GeminiObj => isObject(m) && typeof m.id === 'string';

function rewind(state: Readonly<GeminiThreadState>, target: unknown): GeminiOp[] {
  if (typeof target !== 'string') return [unknown('$rewindTo')];
  const at = state.order.indexOf(target);
  const ids = at === -1 ? [...state.order] : state.order.slice(at);
  return ids.length === 0 ? [] : [{ op: 'removeMessages', ids }];
}

function set(fields: GeminiObj): GeminiOp[] {
  const { messages, ...meta } = fields;
  const ops: GeminiOp[] = [];
  if (Object.keys(meta).length > 0) ops.push({ op: 'setMeta', meta });
  if (Array.isArray(messages)) ops.push({ op: 'replaceAll', messages: messages.filter(isMessage) });
  return ops;
}

/** Merges tool-call patches (`{id, ...fields}`) into a message's calls by call id; unknown call ids are ignored. */
function patchCalls(calls: unknown, patches: unknown[]): unknown[] | null {
  if (!Array.isArray(calls)) return null;
  let changed = false;
  const out = calls.map((call) => {
    if (!isObject(call) || typeof call.id !== 'string') return call;
    let next = call;
    for (const p of patches) {
      if (!isObject(p) || p.id !== call.id) continue;
      next = { ...next, ...p };
      changed = true;
    }
    return next;
  });
  return changed ? out : null;
}

/**
 * `$patch`: `id` + `content` / `toolCalls`, and each of `updates[]`, change messages by id (unknown ids ignored; a
 * top-level `toolCalls` without `id` is matched by call id across the thread's messages); `removeIds` removes;
 * `orderIds` is ignored (nodes keep the order of first appearance).
 */
function patch(state: Readonly<GeminiThreadState>, p: GeminiObj): GeminiOp[] {
  const next = new Map<string, GeminiObj>();
  const current = (id: string): GeminiObj | undefined => next.get(id) ?? state.messages.get(id);
  const update = (u: GeminiObj): void => {
    if (typeof u.id !== 'string') return;
    const msg = current(u.id);
    if (msg === undefined) return;
    let out = msg;
    if ('content' in u) out = { ...out, content: u.content };
    if (Array.isArray(u.toolCalls)) {
      const calls = patchCalls(out.toolCalls, u.toolCalls);
      if (calls !== null) out = { ...out, toolCalls: calls };
    }
    if (out !== msg) next.set(u.id, out);
  };
  if (typeof p.id === 'string') update(p);
  else if (Array.isArray(p.toolCalls)) {
    for (const id of state.order) {
      const msg = current(id)!;
      const calls = patchCalls(msg.toolCalls, p.toolCalls);
      if (calls !== null) next.set(id, { ...msg, toolCalls: calls });
    }
  }
  if (Array.isArray(p.updates)) for (const u of p.updates) if (isObject(u)) update(u);
  const ops: GeminiOp[] = [...next].map(([id, message]) => ({ op: 'upsertMessage', id, message }));
  if (Array.isArray(p.removeIds)) {
    const remove = new Set(p.removeIds.filter((x): x is string => typeof x === 'string' && state.messages.has(x)));
    const ids = state.order.filter((id) => remove.has(id));
    if (ids.length > 0) ops.push({ op: 'removeMessages', ids });
  }
  return ops;
}

/** Applies ops to the thread state (upsert keeps a known id's position; replaceAll takes the new list's order). */
export function applyGeminiOps(state: GeminiThreadState, ops: readonly GeminiOp[]): void {
  for (const o of ops) {
    switch (o.op) {
      case 'upsertMessage':
        if (!state.messages.has(o.id)) state.order.push(o.id);
        state.messages.set(o.id, o.message);
        break;
      case 'removeMessages': {
        const gone = new Set(o.ids);
        for (const id of gone) state.messages.delete(id);
        state.order = state.order.filter((id) => !gone.has(id));
        break;
      }
      case 'setMeta':
        state.meta = { ...state.meta, ...o.meta };
        break;
      case 'replaceAll':
        state.order = [];
        state.messages = new Map();
        for (const m of o.messages) {
          const id = m.id as string;
          if (!state.messages.has(id)) state.order.push(id);
          state.messages.set(id, m);
        }
        break;
      case 'unknown':
        break;
    }
  }
}
