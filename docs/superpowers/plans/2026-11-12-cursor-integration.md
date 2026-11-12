# Cursor Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Show Cursor Agent sessions in claude-canvas next to Claude Code and Codex sessions, through the same graph model, views and API.

**Architecture:** A third origin, `cursor`. Its data is not appended files but Cursor's local SQLite state database, read-only: a *poll source* reads changed conversations every few seconds, stores trimmed records as raw events (so rebuild never re-reads Cursor's database), and a `CursorNormalizer` turns them into the shared `Change` stream. Everything downstream is shared. Cursor hooks (observation-only events) leave session status marks and poke the poller.

**Tech Stack:** unchanged — TypeScript, pnpm workspace (`npx --yes pnpm@10 <cmd>`), Fastify, better-sqlite3, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-12-cursor-integration-design.md` (binding; section numbers below refer to it). The Codex spec `2026-11-11-codex-integration-design.md` and the main spec govern everything not changed here.

## Global Constraints

- Claude Code and Codex behaviour must not change: every existing test keeps passing unmodified, except where a shared type gains a member (then only fixture literals / exhaustive maps are updated).
- TDD for logic: failing test first. Vitest, node environment, no jsdom, no component tests.
- Tests and any server you start use temp dirs / temp files only: `CLAUDE_CANVAS_PROJECTS_DIR`, `CLAUDE_CANVAS_DATA_DIR`, `CLAUDE_CANVAS_CODEX_DIR`, `CLAUDE_CANVAS_CURSOR_DB`. Never read or write the real `~/.cursor/hooks.json`, `~/.claude/settings.json`, `~/.codex/hooks.json`. Never open the real Cursor database (`%APPDATA%\Cursor\User\globalStorage\state.vscdb`) or real session files; the real record *structure* is described in spec section 2.
- Fixtures are synthetic: shaped like the real records, invented text.
- The Cursor database is only ever opened `readonly` with short auto-commit queries by primary key or key range; no writes, no explicit transactions, no pragmas that write.
- Commits: English Conventional Commits ending with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. Commit only your own paths. Do not push.
- Before each commit: `npx --yes pnpm@10 test`, `npx --yes pnpm@10 typecheck`, `npx --yes pnpm@10 build` all pass.
- Names fixed across tasks: `Origin = 'claude' | 'codex' | 'cursor'`; key prefix `cursor:` (store key of a conversation: `cursor:<composerId>`); config field `cursorDbPath: string | null` (env `CLAUDE_CANVAS_CURSOR_DB`; unset → the platform default path of spec 5.1; empty string → null = disabled); interface `PollSource` in `packages/server/src/sources/poll.ts`; class `CursorSource` in `packages/server/src/sources/cursor/source.ts`; class `CursorNormalizer` in `packages/server/src/normalize/cursor.ts`; raw record types `composer` and `bubble`; `POST /hooks?origin=cursor`; CLI `hooks install|uninstall --cursor`, `hook-forward --origin cursor`; env `CLAUDE_CANVAS_CURSOR_HOOKS_FILE`.

## Review Focus

1. A bubble that changes after it was first stored (tool `loading` → `completed`, text growing): the node is updated in place, never duplicated; a rebuild from raw events gives the same graph as the live run.
2. A subagent conversation read before its parent (and the reverse), and a `task_v2` call whose subagent never appears: one session, dispatch edge present when both exist, no orphan session.
3. The Cursor database missing, locked, lacking a table/column, or holding a bubble whose JSON does not parse: no crash, other origins unaffected, the problem visible in diagnostics, retried next poll.
4. A conversation archived or deleted in Cursor after it was collected: marked "source deleted", data kept, never read again; an archived conversation is never imported.
5. The hook forwarder for `--origin cursor`: prints exactly `{"continue":true}` for `beforeSubmitPrompt` and nothing for any other event, exits 0 when the server is down, slow, or stdin is garbage.

---

### Task 1: The `cursor` origin and the poll-source seam

**Files:** `packages/shared/src/{model.ts,api.ts}`; `packages/server/src/{config.ts,pipeline.ts,cli-commands.ts,api/server.ts}`; `packages/server/src/sources/{source.ts,poll.ts (new)}`; `packages/server/src/normalize/{registry.ts,version.ts}`; exhaustive `Record<Origin, …>` maps and fixtures in `packages/web` and tests; tests next to each.

**Produces (later tasks rely on these):**
- `Origin` gains `'cursor'`; `ORIGINS = ['claude', 'codex', 'cursor']`; `KEY_PREFIXES.cursor = 'cursor:'`; `NORMALIZER_FACTORIES.cursor = null` (Task 3 fills it; until then Cursor raw events are stored and produce nothing — test this).
- `Config.cursorDbPath` (spec 5.1), loaded and tested for unset / set / empty on each platform default.
- `Diagnostics.cursor: { dbPath: string | null; dbExists: boolean; lastPollAt: string | null; lastError: string | null }`, served by `/api/diagnostics`.
- `interface PollSource { readonly origin: Origin; start(sink: PollSink): void; stop(): Promise<void>; poke(sessionId: string): void; status(): { lastPollAt: string | null; lastError: string | null } }` and `interface PollSink` — what a poll source may ask of the pipeline:
  - `ingestRecords(batch: { key: string; projectId: string; sessionId: string; agentId: string | null; records: { recordType: string; line: string }[] }): Promise<void>` — stores each record as a `source: 'transcript'` raw event of the source's origin under `file = key` (deduplicated by the existing `(file, line_hash)` index, so an unchanged record is a no-op), applies the new ones through the normalizer in order, serialised per session like file ingestion, and counted by `importing()` / `idle()`.
  - `markSourceDeleted(sessionId: string): Promise<void>` and its undo `clearSourceDeleted(sessionId: string)` — the existing "source deleted" marking, driven by the source instead of a file scan.
  - `reportFailure(key: string, err: unknown): void` (existing).
  - `poked(listener)` is not needed: the pipeline calls `source.poke(sessionId)` when a hook of that origin arrives (Task 5 wires the call; Task 1 adds the method and a pipeline hook-point with a test using a fake source).
- `Pipeline` accepts poll sources next to file sources (`PipelineOptions.pollSources?: PollSource[]`), starts them after the initial scan and stops them on close; rebuild replays stored Cursor raw events like any other (ordered by ingest id) without touching the source.
- `NORMALIZER_VERSION` bumped.

**Tests first:** origin-of-key for `cursor:`; config; a fake `PollSource` pushing records through a real `Pipeline` on a temp database: stored once, duplicate batch is a no-op, a changed line is stored as a second raw event, rebuild keeps them; `markSourceDeleted`; diagnostics shape; every existing test green.

### Task 2: CursorSource — reading Cursor's database

**Files:** `packages/server/src/sources/cursor/{db.ts,source.ts,project.ts,trim.ts}` (new); `packages/server/src/cli-commands.ts` (construct it when `cursorDbPath` is set); tests `packages/server/test/cursor-source.test.ts` with a builder `packages/server/test/cursor-fixtures.ts` that creates a temp SQLite file with the real table shapes (`composerHeaders` columns of spec 2; `cursorDiskKV(key TEXT PRIMARY KEY, value BLOB)`).

**Consumes:** `PollSource`, `PollSink`, `Config.cursorDbPath`.

**Produces:** spec section 5 —
- `db.ts`: open read-only (spec 5.1), typed queries: all headers; `composerData:<id>`; bubbles by exact key. Every failure is returned, not thrown past the poll loop.
- `trim.ts`: pure functions `trimComposer(raw, extras) → string` and `trimBubble(raw) → string` producing the JSON lines of spec 5.3 (stable key order so equal content gives equal lines; 64 KB caps). These two shapes are the contract Task 3 parses — export their TypeScript types (`CursorComposerRecord`, `CursorBubbleRecord`) from `packages/server/src/sources/cursor/records.ts`.
- `project.ts`: working directory by the three-step fallback and project id (reuse the Codex `encodeProjectId` and its case-insensitive reuse of existing project ids; unknown directory → `cursor-<workspaceId>`).
- `source.ts`: the poll loop of spec 5.2 (interval injectable; a `pollOnce()` usable by tests without timers): select conversations (not archived, not draft, main; subagents whose root is selected), detect change by `lastUpdatedAt` plus the "recently active" rule, read only needed bubbles, emit `composer` then `bubble` records through `sink.ingestRecords` (root session id as `sessionId`, subagent composer id as `agentId`), archive/disappearance → `markSourceDeleted`, per-conversation failures → `reportFailure`, `poke(sessionId)` → an immediate extra round for that conversation, `status()`.

### Task 3: CursorNormalizer

**Files:** `packages/server/src/normalize/{cursor.ts (new),registry.ts,version.ts}`; tests `packages/server/test/normalize-cursor.test.ts`; an end-to-end test (three origins in one temp setup; rebuild gives the same result).

**Consumes:** `AgentNormalizer`, the record types of Task 2.

**Produces:** `class CursorNormalizer implements AgentNormalizer` implementing every row and rule of spec section 6: sessions from `composer` records (title, times, bubble order), prompt / text / thinking / tool nodes from bubbles, upsert by bubble id (a later version of a bubble replaces the earlier one), order by the composer's list then `createdAt`, times, the parallel rule, turn boundaries, `task_v2` → subagent node linked by `toolCallId` to the subagent conversation (either arrival order), dispatch-node status, session status, tokens, unknown shapes counted. Everything is a function of the records read so far, independent of arrival order (test with shuffled interleavings, as the Codex tests do). `NORMALIZER_FACTORIES.cursor` set; `NORMALIZER_VERSION` bumped.

### Task 4: Web — badge, filter, diagnostics

**Files:** `packages/web/src/{OriginBadge.tsx,home.ts,pages/Home.tsx,pages/Diagnostics.tsx,styles.css}`, tests for the pure parts.

**Produces:** spec section 8 — a Cursor origin badge (its own colour and glyph, consistent with the two existing badges); the home filter gains "Cursor"; the diagnostics page gains a Cursor block (database path, exists, last poll, last error, hooks per event, unknown bubble shapes) shown when the database exists or Cursor data exists.

### Task 5: Cursor hooks

**Files:** `packages/server/src/{hook-forward.ts,hooks-config.ts,hooks-cli.ts,cli-commands.ts,api/server.ts,pipeline.ts}`, `packages/server/src/normalize/{cursor.ts,cursor-hooks.ts (new)}`; tests next to each.

**Produces:** spec section 7 —
- `hooks install|uninstall --cursor` writing `~/.cursor/hooks.json` (`--settings`, env `CLAUDE_CANVAS_CURSOR_HOOKS_FILE`): `{ "version": 1, "hooks": { <event>: [ { "command", "timeout": 5 } ] } }` for exactly `sessionStart`, `beforeSubmitPrompt`, `stop`, `subagentStop`, `sessionEnd`; command per spec 7.2 (PowerShell call form on Windows); all existing installer safety behaviour; creates the file when missing; refuses when `~/.cursor` is missing; never touches any other event or entry; an existing file without `version` gets `version: 1` only if it has no `version`.
- `hook-forward --origin cursor`: unchanged behaviour plus stdout `{"continue":true}` for `beforeSubmitPrompt` only (decided from the stdin payload's `hook_event_name`; printed even when the server is down).
- `/hooks?origin=cursor` stored with origin; `conversation_id` is the session id (for a subagent's hook the root session when known); effects per spec 7.3: session-level marks only, combined with the records into the session status as a function of state (reuse the approach of the Codex hook marks), and `pollSource.poke(sessionId)`.
- `NORMALIZER_VERSION` bumped.
