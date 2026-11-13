/**
 * Bidirectional control characters in session text (U+202A–202E embeddings / overrides, U+2066–2069 isolates,
 * U+200E / U+200F marks) can make a text render in another order than it is stored (`‮gnp.exe` reads as `exe.png`). The
 * session page and the exported viewer show them as a visible marker instead (`⟦U+202E⟧`). Pure; used by both builds.
 */

const BIDI = /[‎‏‪-‮⁦-⁩]/g;
const HAS_BIDI = /[‎‏‪-‮⁦-⁩]/;

/** The visible marker for one bidi control character. */
export function bidiMarker(c: string): string {
  return `⟦U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}⟧`;
}

/** The text with every bidi control character replaced by its marker; the same string when there is none. */
export function neutralizeBidi(text: string): string {
  return typeof text === 'string' && HAS_BIDI.test(text) ? text.replace(BIDI, bidiMarker) : text;
}

const MAX_DEPTH = 100;

/**
 * A JSON-like value with neutralizeBidi applied to every string and object key; the same value (same object) when
 * nothing changed. Deeper than 100 levels it is left as it is (the drawer shows such values as JSON text, which then
 * goes through neutralizeBidi as a whole).
 */
export function neutralizeBidiValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return neutralizeBidi(value);
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const v = neutralizeBidiValue(value[i], depth + 1);
      if (v !== value[i] && out === null) out = value.slice(0, i);
      if (out !== null) out.push(v);
    }
    return out ?? value;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  let changed = false;
  const next: [string, unknown][] = [];
  for (const [k, v] of entries) {
    const nk = neutralizeBidi(k);
    const nv = neutralizeBidiValue(v, depth + 1);
    if (nk !== k || nv !== v) changed = true;
    next.push([nk, nv]);
  }
  if (!changed) return value;
  const out: Record<string, unknown> = {};
  // defineProperty: a key `__proto__` stays a plain key.
  for (const [k, v] of next) Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  return out;
}
