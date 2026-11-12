# Codex Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Show OpenAI Codex sessions in agent-canvas next to Claude Code sessions, through the same graph model, views and API.

**Architecture:** Add an *origin* dimension (`claude` | `codex`) to raw events, file offsets and sessions. Each origin has a file source (how files are found and which session / thread a file belongs to) and a normalizer (records → the shared `Change` stream). Everything downstream of the normalizer (store, API, websocket, web views) is shared.

**Tech Stack:** unchanged — TypeScript, pnpm workspace (`npx --yes pnpm@10 <cmd>`), Fastify, better-sqlite3, chokidar, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-11-codex-integration-design.md` (binding; section numbers below refer to it). The earlier spec `2026-11-10-agent-canvas-design.md` still governs everything not changed here.

## Global Constraints

- Claude Code behaviour must not change: every existing test keeps passing unmodified, except where a shared type gains a required field (then only the fixture literal is updated).
- TDD for logic: failing test first. Vitest, node environment, no jsdom, no component tests. `*.timing.test.ts` stay in the serial project.
- Tests and any server you start use temp dirs only: `AGENT_CANVAS_PROJECTS_DIR`, `AGENT_CANVAS_DATA_DIR`, `AGENT_CANVAS_CODEX_DIR`. Never read or write the real `~/.claude/settings.json` or `~/.codex/hooks.json`. Never open real session files under `~/.claude` or `~/.codex` for their content; to see the real Codex record *structure* (types, ids, field names only) run `node .superpowers/sdd/2026-11-11-codex-integration/codex-shape.mjs`.
- Fixtures are synthetic: shaped like real records, with invented text.
- Commits: English Conventional Commits, ending with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. Commit only your own paths. Do not push.
- Before each commit: `npx --yes pnpm@10 test`, `npx --yes pnpm@10 typecheck`, `npx --yes pnpm@10 build` all pass.
- Names fixed across tasks (do not rename): type `Origin = 'claude' | 'codex'` in `@agent-canvas/shared`; `Session.origin`; `Project.origins`; config field `codexSessionsDir: string | null` (env `AGENT_CANVAS_CODEX_DIR`, default `~/.codex/sessions`, empty string = disabled); file-key prefix `codex:` for Codex files in `raw_event.file` / `file_offset.file`; interface `AgentNormalizer` in `packages/server/src/normalize/types.ts`; class `CodexNormalizer` in `packages/server/src/normalize/codex.ts`; interface `FileSource` in `packages/server/src/sources/source.ts`; `POST /hooks?origin=codex`; CLI `hook-forward --origin <o> --port <n>`, `hooks install|uninstall --codex`.

## Review Focus

1. A database created by the previous version is opened by the new one: old sessions get `origin: 'claude'`, hook counters survive, the automatic rebuild runs once and every Claude session is identical to before (apart from the new field).
2. A Codex subagent thread file is read before its root thread's file (and the other way round): both end in the same session with the dispatch edge present.
3. A Codex rollout whose first line is not a `session_meta` record, or is truncated mid-line: no crash, nothing ingested from it yet, reported in diagnostics; picked up once the line is complete.
4. The same working directory used by both tools (and differing only in drive-letter case on Windows): one project, both origins listed.
5. The hook forwarder when the server is down, slow, or given garbage on stdin: exits 0 quickly, prints nothing.

---

### Task 1: Origin through the shared model, store and pipeline (Claude only)

**Files:** `packages/shared/src/{model.ts,api.ts}`; `packages/server/src/store/{schema.ts,store.ts}`; `packages/server/src/pipeline.ts`; `packages/server/src/config.ts`; `packages/server/src/normalize/{types.ts (new),normalizer.ts,version.ts}`; `packages/server/src/sources/{source.ts (new),claude.ts (new)}` (the existing `sources/transcript/*` may stay as the Claude implementation's internals); web fixtures that build `Session` / `Project` literals; tests next to each.

**Produces (later tasks rely on these):**
- `Origin`, `Session.origin: Origin`, `Project.origins: Origin[]`, `Diagnostics.hookEvents[].origin: Origin` (spec 4.1).
- `RawEvent` variants carry `origin?: Origin` (absent = `'claude'`); the transcript variant may carry `projectId?: string | null` (set for Codex, stored in `raw_event.project_id`, used on replay instead of path parsing). `raw_event.origin` column, `hook_stat` keyed by (origin, event name), migration on open for databases of the previous version (spec 4.2).
- `interface AgentNormalizer` — the public surface the pipeline uses today (`apply`, `dropSession`, `needsPreSessionReplay`, `restorePreSession`, `hasSession`, `sessionCount`, `toolInputCount`); `Normalizer implements AgentNormalizer`. The pipeline holds one normalizer per origin and picks by the event's origin (a registry with a slot for `codex` that Task 3 fills; until then Codex events cannot occur).
- `interface FileSource` — everything the pipeline needs from "a directory of session files": origin, root dir, watch depth, list all files, map an absolute path to a file key and back, classify a key into `{ kind: 'session' | 'agent' | 'agent_meta' | 'title'; projectId; sessionId; agentId? }` (classification may be async and may need to read the file — Codex must read the first line), and which keys count as a session's main file for "source deleted". The Claude source wraps the existing path logic with unchanged keys. `Pipeline` takes a list of sources; `startWatcher` watches each.
- `Config.codexSessionsDir` (not used yet beyond being loaded and tested).
- `NORMALIZER_VERSION` bumped (sessions gain `origin`).

**Steps:** tests first for: migration from a previous-version database (build one with the old schema SQL in the test); `origin` on sessions and in `listProjects().origins`; hook stats per origin; pipeline with the Claude source behaves exactly as before (existing pipeline tests untouched); config parsing of `AGENT_CANVAS_CODEX_DIR` (unset → default path, empty → null). Then implement, run everything, commit.

### Task 2: Codex file source

**Files:** `packages/server/src/sources/codex/*` (new); `packages/server/src/cli.ts` (construct the source when `codexSessionsDir` is set and exists); tests `packages/server/test/codex-source.test.ts`, additions to `pipeline.test.ts`.

**Consumes:** `FileSource`, `Config.codexSessionsDir`, the `codex:` key prefix.

**Produces:** a `FileSource` for `~/.codex/sessions` (spec 5): files `YYYY/MM/DD/rollout-*-<threadId>.jsonl`; the thread → session mapping comes from the file's first line (`session_meta`: `id`, `session_id`, `parent_thread_id`, `cwd`), cached per file; project id = the Claude encoding of `cwd` (non-alphanumerics → `-`), reusing an existing project id that differs only in case; raw transcript events carry `origin: 'codex'`, `projectId`, `sessionId` (root thread id) and `agentId` (null for the root thread, the thread id otherwise); a file whose first line is missing, incomplete or not `session_meta` is not ingested and is reported as an ingest failure until it becomes valid. Titles: `session_index.jsonl` next to the sessions dir (`{ id, thread_name, updated_at }` per line) is watched and emitted as `meta` raw events (`origin: 'codex'`) that Task 3 turns into titles. Until Task 3 the pipeline has no Codex normalizer: ingesting stores raw events and applies nothing (test this), so nothing is lost and the rebuild after Task 3 derives them.

### Task 3: Codex normalizer

**Files:** `packages/server/src/normalize/codex.ts` (new), `normalize/version.ts`; pipeline registry wiring; tests `packages/server/test/normalize-codex.test.ts` with a fixture builder `packages/server/test/codex-fixtures.ts`; an end-to-end test (two origins in one temp setup, rebuild gives the same result).

**Consumes:** `AgentNormalizer`, raw events from Task 2.

**Produces:** `class CodexNormalizer implements AgentNormalizer` implementing the mapping table of spec 6 — turns, prompt nodes from `item_completed/UserMessage`, assistant text, reasoning (summary + duration), one tool node per `custom_tool_call` / `function_call` settled by its `…_output` with the `CommandExecution` / `McpToolCall` / `FileChange` items in between folded into its summary, detail and status, parallel calls of one response forked and joined, `spawn_agent` + `SubAgentActivity` → a subagent node with `childAgentId`, inner threads with a spawn edge, the dispatch node's status derived from the child thread's turns (running ↔ succeeded), compaction / abort / turn-error system nodes, session status from the root thread's turns, titles from the session index, unknown record types counted. `NORMALIZER_VERSION` bumped.

### Task 4: Web — origin badge, filter, diagnostics

**Files:** `packages/web/src/{pages/Home.tsx,pages/Session.tsx,pages/Diagnostics.tsx,home.ts,styles.css}`, tests for the pure parts; `README.md` (a "Codex" section, without the hooks part yet).

**Produces:** spec 8 — an origin badge on session cards, search results and the session bar; a home filter (全部 / Claude Code / Codex, remembered in localStorage, with the same try/catch pattern as the density switch) applied to projects (via `Project.origins`) and sessions; diagnostics shows hooks per origin. Pure helpers (filtering, labels) in `home.ts` with tests.

### Task 5: Codex hooks

**Files:** `packages/server/src/{cli.ts,hook-forward.ts (new),hooks-config.ts,hooks-cli.ts,api/server.ts,pipeline.ts}`, `packages/server/src/normalize/{hooks.ts,codex.ts}`; tests next to each; `README.md` (hooks part of the Codex section).

**Produces:** spec 7 — `hook-forward` (reads stdin, POSTs to `/hooks?origin=<o>` on `127.0.0.1:<port>`, 1 s timeout, always exit 0, no output, no file access); `hooks install|uninstall --codex` writing `~/.codex/hooks.json` (or `--settings <file>`), eleven events, `type: command` with `command` and `commandWindows` built from the absolute paths of the running node binary and `cli.js`, `async: true`, `timeout: 5`, all existing safety behaviour, creates the file when missing, prints the "trust these hooks in Codex" notice; `/hooks` reads `origin` (default `claude`) and stores it on the raw event; Codex hook events are applied by `CodexNormalizer` with the same effects as their Claude counterparts (placeholder running tool node on `PreToolUse` matched to the transcript's node by `tool_use_id` = `call_id`, falling back to the latest unfinished call of that tool in the thread; `PermissionRequest` → awaiting permission; `PostToolUse` settle; `Stop` / `SessionEnd` / `Interrupt` / `SubagentStart` / `SubagentStop`), transcript wins on conflict. `NORMALIZER_VERSION` bumped.
