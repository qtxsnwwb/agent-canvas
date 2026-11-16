import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPORT_SCRIPT_ID, EXPORT_TEMPLATE_PLACEHOLDER, type ExportBundle } from '@agent-canvas/shared';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The file name of the built viewer template (Task 2 builds it into packages/web/dist). */
export const VIEWER_TEMPLATE_FILE = 'viewer-template.html';

/** The script element the template carries, with the placeholder the bundle replaces. */
export const TEMPLATE_SLOT = `<script id="${EXPORT_SCRIPT_ID}" type="application/json">${EXPORT_TEMPLATE_PLACEHOLDER}</script>`;

/**
 * Where the viewer template may be, given the directory this module runs from: in the repository (src/export or
 * dist/export) the web package's `packages/web/dist`; in the published package, where the server is bundled into
 * `dist/` (this module's code is in a file directly under it), `web/` next to `dist/` (scripts/pack.mjs copies the web
 * build there, like webDistCandidates in cli-commands.ts).
 */
export function viewerTemplateCandidates(here: string = HERE): string[] {
  return [
    path.resolve(here, '..', '..', '..', 'web', 'dist', VIEWER_TEMPLATE_FILE),
    path.resolve(here, '..', 'web', VIEWER_TEMPLATE_FILE),
  ];
}

/** The first candidate that is a file; null when the viewer has not been built. Only stat'ed. */
export function findViewerTemplate(here: string = HERE): string | null {
  for (const file of viewerTemplateCandidates(here)) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // not there
    }
  }
  return null;
}

/**
 * JSON for a `<script type="application/json">` element: `<`, `>`, `&`, U+2028 and U+2029 written as `\uXXXX` (inside
 * JSON strings, the only place they can occur), so the data cannot end the script element, open a comment or be read as
 * markup, and stays valid JSON. Lone surrogates are escaped by JSON.stringify itself.
 */
export function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Whether a template can be filled: the placeholder occurs exactly once, inside the slot. */
export function isUsableTemplate(template: string): boolean {
  const first = template.indexOf(EXPORT_TEMPLATE_PLACEHOLDER);
  return first >= 0 && template.indexOf(EXPORT_TEMPLATE_PLACEHOLDER, first + 1) < 0 && template.includes(TEMPLATE_SLOT);
}

/**
 * The template with its slot's placeholder replaced by the bundle (no `$` pattern interpretation). Throws unless the
 * placeholder occurs exactly once, inside the slot.
 */
export function fillTemplate(template: string, bundle: ExportBundle): string {
  if (!isUsableTemplate(template)) throw new Error('viewer template must hold the export slot exactly once');
  const at = template.indexOf(TEMPLATE_SLOT);
  const open = TEMPLATE_SLOT.slice(0, TEMPLATE_SLOT.indexOf(EXPORT_TEMPLATE_PLACEHOLDER));
  const close = '</script>';
  return template.slice(0, at) + open + embedJson(bundle) + close + template.slice(at + TEMPLATE_SLOT.length);
}
