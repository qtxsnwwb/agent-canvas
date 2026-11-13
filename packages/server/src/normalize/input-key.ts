/**
 * The input fingerprint of a tool call (GraphNode.inputKey, spec 2026-11-13-anomalies-design.md section 3.2): a hash of
 * the tool name and the call's full input in a canonical form, so that two calls with the same input get the same key
 * whatever order their keys were written in. Only the hash leaves this module, never the input.
 */
import { createHash } from 'node:crypto';

class Cycle extends Error {}

function write(value: unknown, out: string[], ancestors: Set<object>): void {
  if (value === null || typeof value !== 'object') {
    // Primitives as JSON writes them (a top-level undefined / function cannot reach here, see canonicalInput).
    const text = JSON.stringify(value);
    out.push(text === undefined ? 'null' : text);
    return;
  }
  if (ancestors.has(value)) throw new Cycle();
  ancestors.add(value);
  if (Array.isArray(value)) {
    out.push('[');
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out.push(',');
      write(value[i], out, ancestors); // undefined / function members become null, as JSON writes them
    }
    out.push(']');
  } else {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    out.push('{');
    let first = true;
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue; // dropped, as JSON drops them
      if (!first) out.push(',');
      first = false;
      out.push(JSON.stringify(k), ':');
      write(v, out, ancestors);
    }
    out.push('}');
  }
  ancestors.delete(value);
}

/**
 * The canonical text of an input: a string as it is; anything else as JSON with object keys sorted recursively (arrays
 * keep their order; undefined members dropped or nulled as JSON.stringify does). Throws on a cycle or a BigInt.
 */
export function canonicalInput(input: unknown): string {
  if (typeof input === 'string') return input;
  const out: string[] = [];
  write(input, out, new Set());
  return out.join('');
}

/**
 * `toolName` and `input` hashed (SHA-256 over the whole canonical text, first 16 hex characters); undefined when the
 * input is missing (undefined or null) or cannot be written as JSON (a cycle, a BigInt, nesting too deep for the
 * stack). Never throws. The hashed text is unambiguous: the tool name with its length, a type tag (`s` for a string
 * input, `j` for anything else, written as canonical JSON), then the canonical text — so a string input never equals an
 * object whose JSON is that string. Cost (measured): about 2 ms for a 1 MB input, a few µs for a typical one.
 */
export function inputKeyOf(toolName: string | null, input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  let text: string;
  try {
    text = canonicalInput(input);
  } catch {
    return undefined;
  }
  const name = toolName ?? '';
  const hash = createHash('sha256');
  hash.update(`${name.length}:${name}:${typeof input === 'string' ? 's' : 'j'}:`);
  hash.update(text);
  return hash.digest('hex').slice(0, 16);
}

/** The `inputKey` field of a new node; absent when there is no key. */
export function inputKeyFields(key: string | undefined): { inputKey?: string } {
  return key === undefined ? {} : { inputKey: key };
}

/**
 * The patch that makes `node` carry `key`: empty when it already does, or when there is no new key (an input does not
 * go away once a call has one; a key is never cleared with undefined, which a patch through JSON would lose).
 */
export function inputKeyPatch(node: { inputKey?: string }, key: string | undefined): { inputKey?: string } {
  return key === undefined || node.inputKey === key ? {} : { inputKey: key };
}
