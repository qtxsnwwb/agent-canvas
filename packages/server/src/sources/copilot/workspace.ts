/** What agent-canvas reads from a Copilot CLI session's `workspace.yaml` (spec 5.3). */
export interface CopilotWorkspace {
  name?: string;
  summary?: string;
  cwd?: string;
}

const KEYS = new Set(['name', 'summary', 'cwd']);
/** A block-scalar indicator (`|`, `>`, with optional chomping / indentation markers) and nothing else. */
const BLOCK = /^[|>][+-]?[0-9]?[+-]?$/;

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1);
  return v;
}

/**
 * The top-level `name`, `summary` and `cwd` of a `workspace.yaml`, read line by line as `key: value` without a YAML
 * library (spec 5.3): only unindented lines count (nested keys are ignored); a value is its first line, surrounding
 * quotes stripped (escapes are not decoded); a block scalar (`|`, `>`, …) takes its first non-empty indented line. The
 * first occurrence of a key wins; empty values are left out. Never throws: anything unreadable gives `{}`.
 */
export function parseWorkspaceYaml(text: string): CopilotWorkspace {
  const out: CopilotWorkspace = {};
  if (typeof text !== 'string') return out;
  const lines = text.replace(/^﻿/, '').split('\n').map((l) => l.replace(/\r$/, ''));
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
      value = unquote(value).trim();
    }
    if (value !== '') out[key] = value;
  }
  return out;
}
