# Export and Secret Masking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Export one session as a self-contained read-only HTML file or a Markdown document with secrets masked, and a page-level switch that masks secrets on screen.

**Architecture:** A pure masking module in the shared package (rules, numbering, report) is used by the server's export and by the web's display. The server assembles the export data in a streaming way (scope, content options, truncation, masking) and renders Markdown or fills an HTML template. The template is a second build entry of the web package: the existing session page reading embedded data instead of the API. The web adds an export dialog and the masking switch.

**Tech Stack:** unchanged — TypeScript, pnpm workspace (`npx --yes pnpm@10 <cmd>`), Fastify, better-sqlite3, React, Vite, Vitest. No new runtime dependency (a Vite single-file inlining step may be written by hand in the build script; a dev-only dependency needs the controller's approval first).

**Spec:** `docs/superpowers/specs/2026-11-13-export-and-masking-design.md` (binding).

## Global Constraints

- The database is not changed; no rebuild; `NORMALIZER_VERSION` stays; search still matches original text.
- Fail closed: wherever masking is requested and cannot be applied (an exception, an unreadable value), the output carries a masked placeholder, never the original text.
- Mask reports, logs, errors and route responses other than the export body never contain a matched value — only types and counts.
- The export contains only the requested session's data (spec 4.3); never raw events, hook payloads or other sessions.
- The exported HTML makes no network request and references nothing external; embedded data cannot break out of its script block or be interpreted as markup.
- All regular expressions run in linear time on adversarial input (no nested quantifiers over overlapping classes); a 1 MB worst-case input is measured in a test.
- TDD for logic: failing test first. Vitest, node environment, no jsdom, no component tests.
- Tests use temp dirs only (`AGENT_CANVAS_PROJECTS_DIR`, `AGENT_CANVAS_DATA_DIR`, `AGENT_CANVAS_CODEX_DIR`, `AGENT_CANVAS_CURSOR_DB`); never read or write under the user's real home directory; the real service on port 4317 is not touched and its port not used. The real database is never opened by an implementer.
- Fixtures are synthetic; secret-looking test values are obviously fake and built by concatenation at run time where a literal would trip secret scanners (the repository is public).
- User-facing text is Simplified Chinese, in the tone of the existing pages.
- Commits: English Conventional Commits ending with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. Do not push.
- Before each commit: `npx --yes pnpm@10 test`, `npx --yes pnpm@10 typecheck`, `npx --yes pnpm@10 build` all pass — read the actual pass/fail lines.
- Names fixed: shared module `packages/shared/src/masking.ts` exporting `MaskCategory = 'credential' | 'assignment' | 'personal' | 'custom'`, `MaskType`, `MaskOptions { categories: MaskCategory[]; customTerms?: string[]; homeUsers?: string[]; numbered?: boolean }`, `MaskReport`, `createMasker(options): { mask(text: string): string; maskValue(value: unknown): unknown; report(): MaskReport }`, `MASK_TYPE_LABELS`; shared export types in `packages/shared/src/export.ts`: `ExportOptions { format: 'html' | 'md'; scope: { kind: 'session' } | { kind: 'turn'; turnKey: string }; thinking: boolean; subagents: boolean; output: 'head' | 'full' | 'none'; mask: { credential: boolean; assignment: boolean; personal: boolean; custom: boolean } }`, `ExportPreview`, `ExportBundle` (the data embedded in the HTML), `EXPORT_MAX_BYTES = 50 * 1024 * 1024`, `EXPORT_OUTPUT_HEAD_BYTES = 8 * 1024`; server module `packages/server/src/export/`; routes `POST /api/sessions/:id/export/preview`, `POST /api/sessions/:id/export`, `GET|PUT /api/export/settings`; settings file `export-settings.json` in the data dir; viewer entry `packages/web/viewer.html` + `packages/web/src/viewer/`; built template `packages/web/dist/viewer-template.html` with the placeholder `<script id="agent-canvas-export" type="application/json">__AGENT_CANVAS_EXPORT__</script>`; web `packages/web/src/{masking.ts,export.ts}`, `packages/web/src/canvas/ExportDialog.tsx`, masking switch state in `localStorage` key `agent-canvas:mask`.

## Review Focus

1. Leaks: a secret that appears in a place the masker is not applied to — node titles and summaries, structured input keys vs values, file paths, session title / cwd / branch, the mask report, error messages, the HTML's embedded bundle vs the rendered text, Markdown headings, the downloaded file name; a secret split by truncation at the 8 KB cut (half a token left visible); the same value masked in one place and not another.
2. Hostile content in the data: `</script>`, `<!--`, `]]>`, U+2028/2029, NUL, lone surrogates, `javascript:` links, HTML in tool output, Markdown that closes a fence or a `<details>`, a session title with path separators or control characters (file name), right-to-left overrides.
3. Regular-expression cost: megabyte inputs made of near-matches for every rule (long runs of `sk-`, `=`, `@`, `eyJ`, `-----BEGIN`), thousands of custom terms' worth of alternation, custom terms with regex metacharacters.
4. Size and memory: a session with 170,000 nodes and hundreds of MB of details — preview and export must stream, yield, respect `EXPORT_MAX_BYTES` early (stop when exceeded), and survive a client that disconnects mid-download.
5. The masking switch on the page: every surface that shows session text (incl. copy buttons, the raw-record view, search snippets, tooltips and `title`/`aria-label` attributes, the document title, the anomalies and stats pages) — one unmasked surface defeats the switch.

---

### Task 1: Masking rules, export data, Markdown, routes, settings

**Files:** `packages/shared/src/{masking.ts (new),export.ts (new),index.ts}`; `packages/server/src/export/*` (new); `packages/server/src/api/server.ts`; tests in `packages/shared/test/` and `packages/server/test/`.

**Produces:** spec sections 3, 4.2, 4.3, 4.5, 6 — the masker (rules, assignment filter, numbering, report, fail-closed wrapper, `maskValue` for structured values with key-name awareness); export settings (custom terms) with its routes; the streaming assembly of an `ExportBundle` for a scope and content options; preview (report, estimated bytes, node count, tooLarge); the Markdown renderer; the two export routes with `Origin` checking, 400/404/413; for `format: 'html'` the route fills the template if `packages/web/dist/viewer-template.html` exists and otherwise answers 501 with a clear message (Task 2 supplies the template; the escaping function for the embedded JSON is written and tested here).

### Task 2: HTML viewer build and template

**Files:** `packages/web/{viewer.html (new),vite.config.ts,package.json}`; `packages/web/src/viewer/*` (new) and the minimal seams in `packages/web/src/{client.ts,pages/Session.tsx,...}` needed to feed the session page from embedded data; `scripts/pack.mjs`, `scripts/check-release.mjs`; `packages/server/src/export/*` (template lookup only); tests in `packages/web/test/` and `packages/server/test/`.

**Consumes:** `ExportBundle` and the placeholder contract from Task 1.

**Produces:** spec section 4.4 — the read-only viewer (session page only: canvas views, waterfall, detail drawer, file panel, replay; a banner with export time, mask report and the caution line; no navigation, no network), built into one self-contained HTML template (scripts and styles inlined, a strict content security policy meta tag, no external reference); the server finds the template in development and in the npm package (pack script includes it and fails without it); a headless-browser test or check that opens an exported file and asserts zero network requests and visible content.

### Task 3: Web — export dialog, masking switch

**Files:** `packages/web/src/{App.tsx,client.ts,masking.ts (new),export.ts (new),canvas/ExportDialog.tsx (new),pages/*.tsx,canvas/*,styles.css}`; tests in `packages/web/test/`.

**Consumes:** Task 1's routes and types; the shared masker.

**Produces:** spec sections 4.1 and 5 — the export button and dialog (format, scope, content, mask categories, custom terms editor, live scan result, size estimate, too-large state, caution line, download); the header masking switch persisted in the browser and applied to every surface that shows session text, with per-session numbering on the session page and unnumbered placeholders on cross-session lists; search highlight falling on a placeholder.
