# More Sources (Gemini CLI, Grok Build, Copilot CLI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read Gemini CLI, Grok Build and GitHub Copilot CLI session files from disk and show them like the existing three origins.

**Architecture:** Each new origin is a `FileSource` (directory of appended JSONL files, driven by the existing watcher / line reader / rebuild) plus an `AgentNormalizer` registered in `NORMALIZER_FACTORIES`. A new `node_removed` change carries rewinds. No hooks are installed; a guard at `/hooks` drops payloads Grok and Copilot send to our Claude/Cursor hooks.

**Tech Stack:** TypeScript, pnpm workspace (`npx --yes pnpm@10 <cmd>`), Vitest (node env), Fastify, better-sqlite3, React.

**Spec:** `docs/superpowers/specs/2026-11-16-more-sources-design.md` — binding. Section 5 of the spec holds every record rule, field name, fallback order and tool table; tasks below reference it instead of repeating it. Read the section named in your task in full.

## Global Constraints

- No real data exists for these tools. Every fixture is invented: fake paths (`/home/dev/demo`, `C:\\work\\demo`), fake ids, no real names, no credentials. Fixtures follow the example files in spec section 5 exactly in shape.
- Tests and throwaway servers use temp dirs only, via `AGENT_CANVAS_PROJECTS_DIR`, `AGENT_CANVAS_DATA_DIR`, `AGENT_CANVAS_CODEX_DIR`, `AGENT_CANVAS_CURSOR_DB`, `AGENT_CANVAS_GEMINI_DIR`, `AGENT_CANVAS_GROK_DIR`, `AGENT_CANVAS_COPILOT_DIR` (and temp HOME/USERPROFILE). Never read or write `~/.gemini`, `~/.grok`, `~/.copilot`, `~/.claude`, `~/.codex`, `~/.cursor`, `~/.agent-canvas`. Never use port 4317.
- Nothing is ever written under a tool's directory. Do not install, download or run `gemini`, `grok`, `copilot`, `codex`.
- Normalizers never throw on any input. Unknown record types are reported through `unknownRecordType` as `<origin>:<type>`, type name cut to 60 chars and restricted to `[A-Za-z0-9._\-/$]`; never a content value.
- `NORMALIZER_VERSION` stays 34. Output of the claude, codex and cursor normalizers must not change; every existing test stays green unmodified (except exhaustive `Record<Origin, …>` tables that need the new keys).
- No new runtime dependency (no YAML library).
- Existing known load-flaky tests (`normalize-cursor-round1` "I4", Cursor wiring, compact CLI, notify-desktop spawnRunner): rerun alone before treating as a failure.
- Judge a test run by the `Test Files` / `Tests` summary lines, not by grepping for "failed".
- Commits end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. Do not push.

## Review Focus

1. A file that is rewritten or shrinks (Copilot transcript recovery, Gemini legacy `.json` rewritten whole): re-read from the start must end in the same graph, with no duplicate nodes. → Tasks 2, 3.
2. A rewind that removes nodes must also remove their details, search-index entries, edges and stats/anomaly cache contributions, live and after rebuild. → Task 1 (mechanism), Tasks 2 and 4 (use).
3. A child session/thread seen before its parent (Grok subagent directory listed first; Gemini subagent file before the parent's tool call) must end attached exactly as when seen in order. → Tasks 2, 4.
4. A very large `events.jsonl` (hundreds of MB) must never be read whole; classify/first-line reads are bounded. → Task 3.
5. A legitimate Claude Code or Cursor hook payload must never be dropped by the foreign-payload guard. → Task 1.

---

### Task 1: Shared groundwork

**Files:**
- Modify: `packages/shared/src/model.ts` (`Origin`, `ORIGINS`), `packages/shared/src/change.ts`
- Modify: `packages/server/src/sources/source.ts` (`KEY_PREFIXES`), `packages/server/src/config.ts`, `packages/server/src/cli-commands.ts` (`fileSources`), `packages/server/src/normalize/registry.ts`
- Modify: `packages/server/src/store/store.ts`, `packages/server/src/stats/session-cache.ts`, `packages/server/src/api/server.ts`, and every other site that switches on `Change['type']` or holds a `Record<Origin, …>` (typecheck lists them: `export/markdown.ts`, `notify/engine.ts`, `web/src/home.ts`, `web/src/OriginBadge.tsx`, `web/src/diagnostics.ts`, web change reducers)
- Create: `packages/server/src/sources/dirs.ts`, `packages/server/src/normalize/unknown-type.ts`, `packages/server/src/hook-guard.ts`
- Test: `packages/shared/test/change-node-removed.test.ts`, `packages/server/test/store-node-removed.test.ts`, `packages/server/test/config-more-sources.test.ts`, `packages/server/test/hook-guard.test.ts`, `packages/server/test/api-hook-guard.test.ts`

**Interfaces — Produces:**
- `type Origin = 'claude' | 'codex' | 'cursor' | 'gemini' | 'grok' | 'copilot'`; `ORIGINS` in that order. `KEY_PREFIXES`: `gemini:`, `grok:`, `copilot:`.
- `Change` gains `{ type: 'node_removed'; sessionId: string; id: string }`. `applyChange` removes the node and every edge whose `from` or `to` is the id; unknown id → graph unchanged.
- Store: applying `node_removed` deletes the node row, its detail, its search-index entry and its edges, in the same transaction as the batch; unknown id is a no-op. Stats session cache, anomaly cache and the SSE stream treat it like any other change of that session (invalidate / forward).
- `Config` gains `geminiDir: string | null`, `grokDir: string | null`, `copilotDir: string | null`. Resolution, first hit wins: override → `AGENT_CANVAS_GEMINI_DIR` / `_GROK_DIR` / `_COPILOT_DIR` (empty string = null = not read) → tool variable (`GEMINI_CLI_HOME` + `/.gemini`, `GROK_HOME`, `COPILOT_HOME`) → `~/.gemini`, `~/.grok`, `~/.copilot`.
- `isExistingDir(p: string | null): boolean` in `sources/dirs.ts` (the check `fileSources` already does for Codex, extracted).
- `NORMALIZER_FACTORIES` gets `gemini: null, grok: null, copilot: null` (filled by Tasks 2–4). `fileSources` is unchanged in behaviour here.
- `unknownTypeName(origin: Origin, raw: unknown): string` in `normalize/unknown-type.ts`: `<origin>:<cleaned>`; non-string or empty → `<origin>:?`.
- `isForeignHookPayload(origin: 'claude' | 'codex' | 'cursor', body: unknown): boolean` in `hook-guard.ts`, rule per spec section 7. `/hooks` checks it first: when true → respond as for an accepted hook, store nothing, bump an in-memory counter exposed in `/api/diagnostics` as `foreignHooksDropped: number`.
- Origin labels wherever a `Record<Origin, string>` exists: `Gemini CLI`, `Grok`, `Copilot CLI`.

- [ ] **Step 1: Failing tests.** `change-node-removed`: removes node and incident edges; unknown id returns the same object. `store-node-removed`: after `node_added` ×3 + edges + `node_removed` of the middle one, `getGraph` has 2 nodes and no edge touching it, its detail is gone, a content search for a word only in that node returns nothing; replaying the same raw-free change list on a fresh store gives the same graph. `config-more-sources`: each of the four resolution levels for each tool, and `''` → null. `hook-guard`: Claude payload (`session_id`, `hook_event_name`) → false; Cursor payload (`conversation_id`, `hook_event_name`) → false; Cursor `sessionStart` with `session_id` only → false; `{hookEventName, sessionId, cwd, workspaceRoot}` → true; `{sessionId, timestamp, cwd, toolName}` → true; `{sessionId, session_id}` → false; non-object → false; origin `codex` always false. `api-hook-guard`: POST of a Grok-shaped body to `/hooks?origin=claude` stores no raw event, creates no session, and diagnostics shows `foreignHooksDropped: 1`; a Claude body still creates its session.
- [ ] **Step 2:** Run them; expect failures for missing exports.
- [ ] **Step 3:** Implement. Let `npx --yes pnpm@10 -r typecheck` drive the exhaustive-table and switch sites.
- [ ] **Step 4:** `npx --yes pnpm@10 -r typecheck` clean; `npx --yes pnpm@10 -r test` — all pass.
- [ ] **Step 5:** Commit `feat: origins gemini/grok/copilot, node_removed change, foreign hook guard`.

---

### Task 2: Gemini CLI

Spec: sections 4 and 5.1.

**Files:**
- Create: `packages/server/src/sources/gemini/source.ts`, `packages/server/src/sources/gemini/project.ts`, `packages/server/src/normalize/gemini.ts`, `packages/server/src/normalize/gemini-reduce.ts`
- Modify: `packages/server/src/normalize/files.ts` (`geminiTouches`), `packages/server/src/normalize/registry.ts`, `packages/server/src/cli-commands.ts`
- Test: `packages/server/test/gemini-fixtures.ts`, `gemini-source.test.ts`, `gemini-reduce.test.ts`, `normalize-gemini.test.ts`, `gemini-e2e.test.ts`

**Interfaces:**
- Consumes: Task 1 (`KEY_PREFIXES.gemini`, `node_removed`, `isExistingDir`, `unknownTypeName`, `config.geminiDir`).
- Produces: `class GeminiFileSource implements FileSource` — `rootDir = <geminiDir>/tmp`, `watchDepth` reaching `*/chats/*/*`; keys `gemini:<path relative to tmp, '/' separators>`. `classify`: `*/chats/session-*.jsonl` → `session`; `*/chats/<parent>/<child>.jsonl` → `agent` (`sessionId` = parent folder name, `agentId` = file base name); `session-*.json` → `title`-kind whole read (legacy), skipped when the same-named `.jsonl` exists; `.project_root` and `../projects.json` handled as whole-read meta so a rebuild has the project without the file; `*.tmp-*`, `*.unreadable-*` → null. Session id comes from the first metadata line (bounded first-line read, as the Codex source does), cached per key and taken from stored raw events when present.
- `geminiProject(tmpDir, slug, knownProjectIds): { projectId: string; cwd: string | null }` per spec 5.1 (case-insensitive reuse of an existing project id on Windows through `ProjectIdResolver`).
- `reduceGemini(state, line): Op[]` in `gemini-reduce.ts`: the five record kinds → ops `upsertMessage`, `removeMessages(ids)`, `setMeta`, `replaceAll(messages)`; pure, no graph knowledge. The normalizer turns ops into changes: stable node ids derived from session id + message id (+ thought index / tool-call id), `node_added` on first sight, `node_updated` when a re-appended message differs, `node_removed` for removed messages and for nodes a replaced message no longer has.
- `geminiTouches(toolName, args): RawTouch[]` per the spec's tool table and path-key order.
- `fileSources` adds `new GeminiFileSource(...)` when `isExistingDir(path.join(config.geminiDir, 'tmp'))`.

- [ ] **Step 1: Failing tests.**
  - `gemini-reduce`: each of the five kinds; same id twice → one message, last content, first position; `$rewindTo` known id removes it and all after; unknown id removes all; `$patch` with `toolCalls[{id,result}]` sets only that call's result; `removeIds`; `$set.messages` replaces all; unknown `$`-key line → `unknownRecordType 'gemini:$<key>'`; a JSON array / number / malformed line → no throw.
  - `normalize-gemini`: the spec's example file line by line gives prompt, thinking, text, tool(read_file, succeeded, file touch read), tool(run_shell_command, failed), system(info) nodes with usage `{inputTokens: input − cached, cachedInputTokens: cached, outputTokens: output + thoughts}` and title from `$set.summary`; a `user` message whose content has `functionResponse` adds no node; the message re-appended three times (text → +scheduled call → +result) yields exactly one text node and one tool node whose status goes running → succeeded; `status: 'cancelled'` → failed; tool call with `agentId` matching a subagent file → `subagent` node with `childAgentId` and a spawn edge, in both arrival orders (Review Focus 3); `$rewindTo` emits `node_removed` for every node of the removed messages.
  - `gemini-source`: classification of every path shape above; legacy `.json` skipped when `.jsonl` sibling exists; project from `.project_root`, else `projects.json`, else `gemini:<slug>` with null cwd; missing/garbage sidecars do not throw.
  - `gemini-e2e` (pipeline + store on temp dirs): one-shot ingest equals line-by-line appended ingest equals rebuild-from-raw (same nodes, edges, session); legacy `.json` written whole twice with a message added → no duplicates (Review Focus 1); after a rewind the removed node is gone from graph, content search and the by-file view (Review Focus 2); with no `tmp` directory the pipeline has no gemini source and nothing is created on disk.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** typecheck clean; full test run passes.
- [ ] **Step 5:** Commit `feat: Gemini CLI source`.

---

### Task 3: GitHub Copilot CLI

Spec: sections 4 and 5.3.

**Files:**
- Create: `packages/server/src/sources/copilot/source.ts`, `packages/server/src/sources/copilot/workspace.ts`, `packages/server/src/normalize/copilot.ts`
- Modify: `packages/server/src/normalize/files.ts` (`copilotTouches`), `registry.ts`, `cli-commands.ts`
- Test: `packages/server/test/copilot-fixtures.ts`, `copilot-source.test.ts`, `copilot-workspace.test.ts`, `normalize-copilot.test.ts`, `copilot-e2e.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `class CopilotFileSource implements FileSource` — `rootDir = <copilotDir>/session-state`, `watchDepth` 1; keys `copilot:<relative path>`. `classify`: `<id>/events.jsonl` and legacy `<id>.jsonl` → `session` (session id = directory / base name); `<id>/workspace.yaml` → `title`; everything else (`session.db`, `checkpoints/`, `plan.md`, `files/`, lock files, `vscode.metadata.json`) → null. `listFiles` lists by name without recursing into `checkpoints/` or `files/`. Project: from the stored raw events when present, else a bounded read of the first line (`session.start.data.context.cwd`), else `workspace.yaml` `cwd`, else unknown.
- `parseWorkspaceYaml(text: string): { name?: string; summary?: string; cwd?: string }` — top-level `key: value` lines only, first line of a value, surrounding quotes stripped, block-scalar markers (`|`, `>`) take the next indented line; never throws.
- `CopilotNormalizer implements AgentNormalizer` per spec 5.3, including the three-step agent-thread linking order and the explicit ignore list; node ids derived from session id + event `id` (tool nodes from `toolCallId`) so a re-read from offset 0 after a shrink re-derives the same ids and adds nothing twice.
- `copilotTouches(toolName, args): RawTouch[]`; `arguments` given as a JSON string is parsed first.
- `fileSources` adds it when `isExistingDir(path.join(config.copilotDir, 'session-state'))`.

- [ ] **Step 1: Failing tests.**
  - `copilot-workspace`: plain, quoted, block-scalar `name`; unknown keys ignored; nested keys ignored; empty/garbage → `{}`.
  - `normalize-copilot`: the spec's example line by line → prompt, thinking, tool(view, succeeded, read touch), tool(bash, failed, output = error message), text; `assistant.message` with empty content and `toolRequests` adds no text node; a `toolRequests` item without a later `tool.execution_start` still yields one tool node, and with one yields exactly one; `tool.execution_complete` before its start (out of order) ends in the same node; subagent thread linked by `data.parentToolCallId`, by `agentId === toolCallId`, by first-new-`agentId`-after-`subagent.started`, and unlinked when none apply (thread still shown under the session); `session.shutdown` → status ended and session usage = sum over `modelMetrics`, placed on a system node at that timestamp; `session.resume` after shutdown → status running again; ignore-list types produce no node and no unknown report; `foo.bar` → `copilot:foo.bar`; `arguments` as string.
  - `copilot-source`: classification of each path; legacy flat file; project resolution order.
  - `copilot-e2e`: one-shot = appended = rebuild; file replaced by a shorter one that drops two lines and keeps the rest (Review Focus 1) → no duplicates, the surviving nodes unchanged; a 5 MB generated `events.jsonl` ingests with `classify` reading at most the bounded first-line window (assert through a spy on the bounded reader, Review Focus 4); title precedence `name` > `summary` > first prompt; missing directory → no source.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** typecheck clean; full test run passes.
- [ ] **Step 5:** Commit `feat: GitHub Copilot CLI source`.

---

### Task 4: Grok Build

Spec: sections 4 and 5.2.

**Files:**
- Create: `packages/server/src/sources/grok/source.ts`, `packages/server/src/normalize/grok.ts`
- Modify: `packages/server/src/normalize/files.ts` (`grokTouches`), `registry.ts`, `cli-commands.ts`
- Test: `packages/server/test/grok-fixtures.ts`, `grok-source.test.ts`, `normalize-grok.test.ts`, `grok-e2e.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `class GrokFileSource implements FileSource` — `rootDir = <grokDir>/sessions`, `watchDepth` 2; keys `grok:<relative path>`. A directory is a session only when it has `summary.json`. `classify`: `<cwd>/<id>/updates.jsonl` → `session`, or `agent` of `parent_session_id` (agentId = own id) when `summary.json` says `session_kind: 'subagent'` with a parent; `<cwd>/<id>/summary.json` → `title`; all other files → null. `classify` returns null for `updates.jsonl` until `summary.json` is readable (the interface allows "cannot tell yet"); the mapping is cached per key and restored from stored raw events. Project: `info.cwd` → URL-decoded directory name when it looks absolute (`/…` or `X:…`) → `<cwd dir>/.cwd` → unknown.
- `GrokNormalizer implements AgentNormalizer` per spec 5.2: chunk coalescing (consecutive chunks of the same kind in the same turn extend one node through `node_updated`), turn detection, both envelope shapes, `_meta` lookup order, extension-record type lookup order, usage on turn completion, rewind by `target_prompt_index` → `node_removed`.
- `grokTouches(toolName, kind, rawInput, locations): RawTouch[]` per the spec's table, with the ACP-`kind` fallback.
- `fileSources` adds it when `isExistingDir(path.join(config.grokDir, 'sessions'))`.

- [ ] **Step 1: Failing tests.**
  - `normalize-grok`: the spec's example → prompt, thinking, tool(execute, failed, output text), tool(search_replace, succeeded, edit touch on the `locations` path), text with usage from the `turn_completed` line; five consecutive `agent_message_chunk` lines → one text node whose detail is the concatenation; chunk kinds alternating → separate nodes; legacy line without `method`; `_meta` on `params` and on `params.update`; `tool_call_update` before `tool_call`; statuses `error` and `cancelled` → failed; missing `rawInput` → tool node titled from `title`/`kind` with no input key; rewind marker with `target_prompt_index: 1` over three turns removes turns 1 and 2 (`node_removed` for each node) and later lines append after turn 0; rewind marker without an index removes nothing and reports `grok:<type>`; unknown extension type reported; `plan` / `available_commands_update` / `current_mode_update` neither node nor report.
  - `grok-source`: directory without `summary.json` ignored; cwd resolution order incl. the `slug-<hash>` + `.cwd` form and a Windows-style encoded name (`D%3A%5Cwork%5Cdemo`); subagent directory classified as agent of its parent; fork (parent id, kind not subagent) is its own session.
  - `grok-e2e`: one-shot = appended = rebuild; child session directory ingested before the parent and after it give the same graph (Review Focus 3); rewind removes nodes from graph, search and by-file view (Review Focus 2); title precedence `generated_title` > `session_summary`; missing directory → no source.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** typecheck clean; full test run passes.
- [ ] **Step 5:** Commit `feat: Grok Build source`.

---

### Task 5: Web, diagnostics, docs

Spec: sections 6, 9.1, 10.

**Files:**
- Modify: `packages/web/src/home.ts`, `packages/web/src/OriginBadge.tsx`, `packages/web/src/diagnostics.ts`, `packages/web/src/pages/Diagnostics.tsx`, origin filter options wherever the three existing origins are listed (search page, stats page), the web change reducer for `node_removed` if Task 1 left only the minimum
- Modify: `packages/server/src/api/server.ts` (diagnostics block per new origin), `packages/server/src/stats/*` and `packages/shared/src/anomalies.ts` only if a test below fails
- Modify: `README.md`, `docs/manual.md`
- Test: `packages/web/test/diagnostics-more-sources.test.ts`, `packages/web/test/origin-look.test.ts`, `packages/server/test/api-diagnostics-more-sources.test.ts`, `packages/server/test/more-sources-features.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: `/api/diagnostics` gains `sources: Record<'gemini' | 'grok' | 'copilot', { dir: string | null; present: boolean; sessionCount: number }>`; `foreignHooksDropped` shown on the diagnostics page; per-origin unknown-record lists for the three prefixes (same helper shape as `cursorUnknownRecords`). `ORIGIN_LOOK` / `ORIGIN_MARKS` entries (simple original marks — a letter glyph in a rounded square; no vendor logos). Origin filters list six origins.
- Manual: a section per new source — where it reads from, the override variable, what is shown, what is not (no hooks/live status, the per-source limits of spec section 6), restart needed when the tool is installed while the service runs, and the sentence "未经真实数据核对" with the pointer to the diagnostics page.

- [ ] **Step 1: Failing tests.** `api-diagnostics-more-sources`: absent dirs → `present: false`, count 0; a temp Gemini dir with one session → `present: true`, count 1. `more-sources-features` (one fixture session per new origin in one pipeline): each appears in `/api/projects` with its origin; content search finds a word from each; stats totals include Gemini per-response usage and Copilot's shutdown total; a Copilot session yields no `cost` anomaly and does not throw; export (Markdown) of each succeeds and names the origin label. Web tests: every `Origin` has a look and a mark; unknown-record helpers split by prefix.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement; write the docs.
- [ ] **Step 4:** typecheck, full tests, `npx --yes pnpm@10 build`, `npx --yes pnpm@10 release` + `node scripts/check-release.mjs` pass.
- [ ] **Step 5:** Commit `feat: more sources in web and diagnostics; docs`.
