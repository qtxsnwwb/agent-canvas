/** What agent-canvas reads from a Copilot CLI session's `workspace.yaml` (spec 5.3). */
export interface CopilotWorkspace {
  name?: string;
  summary?: string;
  cwd?: string;
}

const KEYS = new Set(['name', 'summary', 'cwd']);
/** A block-scalar indicator (`|`, `>`, with optional chomping / indentation markers) and nothing else. */
const BLOCK = /^[|>][+-]?[0-9]?[+-]?$/;
/** YAML's spellings of "no value" for a plain scalar. */
const NULLS = new Set(['~', 'null', 'Null', 'NULL']);

/**
 * A scalar's text: double quotes stripped (escapes not decoded); single quotes stripped with `''` read as `'`; a plain
 * value's ` # comment` cut, and YAML's null spellings read as no value.
 */
function scalar(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  const plain = v.replace(/\s+#.*$/, '').trim();
  return NULLS.has(plain) ? '' : plain;
}

/**
 * The top-level `name`, `summary` and `cwd` of a `workspace.yaml`, read line by line as `key: value` without a YAML
 * library (spec 5.3): only unindented lines count (nested keys are ignored); a value is its first line, read as a
 * scalar (see `scalar`); a block scalar (`|`, `>`, …) takes its first non-empty indented line. Lines end at LF, CRLF or
 * a lone CR. The first occurrence of a key wins; empty values are left out. Never throws: anything unreadable gives `{}`.
 */
export function parseWorkspaceYaml(text: string): CopilotWorkspace {
  const out: CopilotWorkspace = {};
  if (typeof text !== 'string') return out;
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:(?:\s+(.*))?$/.exec(lines[i]!);
    if (m === null) continue;
    const key = m[1]! as keyof CopilotWorkspace;
    if (!KEYS.has(key) || out[key] !== undefined) continue;
    let value = (m[2] ?? '').trim();
    if (BLOCK.test(value)) {
      value = '';
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!;
        if (next.trim() === '') continue;
        if (/^\s/.test(next)) value = next.trim();
        break;
      }
    } else {
      value = scalar(value).trim();
    }
    if (value !== '') out[key] = value;
  }
  return out;
}
