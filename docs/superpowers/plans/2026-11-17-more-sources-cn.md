# Four More Sources Implementation Plan (DeepSeek Harness, WorkBuddy, CodeBuddy Code, Doubao Work)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read the session files of four more tools — origins `deepseek`, `workbuddy`, `codebuddy`, `doubao` — and show them with every existing feature, from public format information only.

**Architecture:** Each tool gets a `FileSource` and an `AgentNormalizer`, registered the way Gemini / Grok / Copilot were. Two small optional extensions to the shared tailing path make this possible without touching existing sources: a source may decode its own container into lines (`readLines`, with a persisted opaque reader state) and may watch several roots (`watchRoots`). WorkBuddy and CodeBuddy Code share one normaliser and one source class.

**Tech Stack:** TypeScript (ESM, Node >= 22), better-sqlite3, chokidar, `node:zlib` zstd (Node >= 22.15, feature-detected), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-17-more-sources-cn-design.md` (binding; its section 10 holds the conventions settled while planning). Format references the spec relies on, binding for every field name and file layout: `docs/formats/deepseek-harness.md`, `docs/formats/buddy-family.md`, `docs/formats/doubao-work.md`.

## Global Constraints

- No test or manual run reads or writes anything under the real home directory or the real application-data directories (`~/.agent-canvas`, `~/.claude`, `~/.codex`, `~/.cursor`, `~/.gemini`, `~/.grok`, `~/.copilot`, `~/.dsh`, `~/.workbuddy`, `~/.workbuddy-ai`, `~/.codebuddy`, `%LOCALAPPDATA%\Doubao*`, `~/Library/Application Support/Doubao*`). Every test config names every tool directory (guard: `packages/server/test/no-real-tool-dirs.test.ts`); never port 4317.
- Fixtures are invented from the format references. Fake secrets are concatenated at run time. Nothing is copied from a real session.
- Output for the existing six origins does not change: `NORMALIZER_VERSION` stays 34, no schema change, existing sources define none of the new optional members, the whole existing suite passes with no change to existing assertions (other than the origin lists this plan extends).
- The tool directories are read-only for us. A missing directory starts no source, creates nothing, watches nothing.
- Lenient reading: an unknown record type is skipped and counted through `unknownTypeName(origin, raw)`; a throwing normaliser is reported as `<origin>:normalizer-error` as the existing ones do; nothing a single bad file does stops other sessions.
- Session ids are the tools' own ids, bare (as every existing source does). `KEY_PREFIXES` (`deepseek:`, `workbuddy:`, `codebuddy:`, `doubao:`) prefix store keys only.
- Token usage follows the existing convention in `packages/shared/src/model.ts`: `inputTokens` = input not read from cache, cache writes included; `cachedInputTokens` = cache reads; `outputTokens` includes reasoning.
- No new runtime dependency.
- Labels: DeepSeek / WorkBuddy / CodeBuddy / 豆包.
- Root commands: `npx --yes pnpm@10 typecheck`, `npx --yes pnpm@10 test`, `npx --yes pnpm@10 build`; one file: `npx --yes pnpm@10 exec vitest run <path>`. Wall-clock bounds go in `*.timing.test.ts` and are multiplied by `AGENT_CANVAS_TIMING_SCALE` as `packages/server/test/pipeline.timing.test.ts` does.
- Commits end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. Do not push; do not open a PR. Do not run `codex`, do not operate Cursor.

## Review Focus

1. A file that is rewritten rather than appended (DeepSeek torn-tail truncate and re-append; Buddy failed-batch rollback; Doubao rewrite of unknown shape), including the case where the new file is not shorter than the stored offset. Expected: the session is re-derived, stale nodes are removed, nothing is duplicated (Tasks 2, 3, 6, 7).
2. Records arriving one batch at a time versus all at once versus after a rebuild. Expected: identical graph, details, usage and titles in all three (every source task has this case).
3. A subagent file read before its parent, and a parent whose link field is absent. Expected: the thread attaches to the root session when it becomes known, linked when the link exists, unlinked otherwise, never a phantom session (Tasks 4, 6, 7).
4. Text typed by the user versus text injected by the tool (DeepSeek source kinds, Buddy wrappers and `providerData` flags, Doubao reminder prefixes). Expected: only human text becomes a prompt; a message that is entirely injected produces no node (Tasks 4, 5, 7).
5. A huge file or a huge line (hundreds of thousands of lines; one tool output of several MB; tens of thousands of zstd frames). Expected: bounded memory per read, no quadratic re-walk, the service stays responsive (timing tests in Tasks 3, 5, 6).

---

### Task 1: Shared groundwork — origins, configuration, diagnostics

**Files:**
- Modify: `packages/shared/src/model.ts`, `packages/shared/src/anomalies.ts`, `packages/shared/src/api.ts`
- Modify: `packages/server/src/sources/source.ts`, `src/config.ts`, `src/sources/dirs.ts`, `src/normalize/registry.ts`, `src/api/server.ts`, `src/export/markdown.ts`, `src/notify/engine.ts`
- Modify (minimum to type-check; looks are finished in Task 8): `packages/web/src/home.ts`, `OriginBadge.tsx`, `diagnostics.ts`, `masking.ts`, `styles.css`
- Modify: `vitest.config.ts`, `packages/server/test/no-real-tool-dirs.test.ts`, and every `loadConfig(` call in tests that the guard requires to name the new keys
- Test: `packages/server/test/config-more-sources-cn.test.ts`, additions to `api-diagnostics-more-sources.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  // shared/model.ts
  export type Origin = 'claude' | 'codex' | 'cursor' | 'gemini' | 'grok' | 'copilot' | 'deepseek' | 'workbuddy' | 'codebuddy' | 'doubao';
  // ORIGINS: same order.
  // shared/anomalies.ts
  // COST_EXCLUDED_ORIGINS = ['copilot', 'doubao']
  // shared/api.ts
  export type FileOnlyOrigin = 'gemini' | 'grok' | 'copilot' | 'deepseek' | 'workbuddy' | 'codebuddy' | 'doubao';
  export interface FileSourceStatus {
    dir: string | null; present: boolean; reading: boolean; sessionCount: number;
    /** Every configured root when a source has more than one (workbuddy, doubao). */
    dirs?: { dir: string; present: boolean }[];
    /** deepseek: session directories holding only files of an unsupported format version. */
    legacyFiles?: number;
    /** Why the source cannot run on this runtime (deepseek on Node < 22.15), else absent. */
    unavailable?: string;
    /** workbuddy / doubao: sessions found again under another root or profile and not read twice. */
    duplicateSessions?: number;
    /** doubao: threads whose time could only be taken from the file's modification time. */
    mtimeFallbacks?: number;
  }
  // server/sources/source.ts
  // KEY_PREFIXES gains deepseek:, workbuddy:, codebuddy:, doubao:
  // FileSource gains: status?(): Partial<FileSourceStatus>;
  // server/config.ts — Config gains
  deepseekDir: string | null;          // dsh home; AGENT_CANVAS_DSH_DIR > DSH_HOME > ~/.dsh
  workbuddyDirs: readonly string[];    // AGENT_CANVAS_WORKBUDDY_DIR (one) > WORKBUDDY_CONFIG_DIR (one) > [~/.workbuddy, ~/.workbuddy-ai]
  codebuddyDir: string | null;         // AGENT_CANVAS_CODEBUDDY_DIR > CODEBUDDY_CONFIG_DIR > ~/.codebuddy
  doubaoDirs: readonly string[];       // AGENT_CANVAS_DOUBAO_DIR (one "User Data"-level dir) > defaultDoubaoDirs(...)
  export function defaultDoubaoDirs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[];
  // win32: <LOCALAPPDATA or home/AppData/Local>/DoubaoWork/User Data and …/Doubao/User Data; darwin: ~/Library/Application Support/DoubaoWork and …/Doubao; others: []
  // server/sources/dirs.ts
  export function sourceDirsOf(config: Config, origin: FileOnlyOrigin): string[];
  ```
  An own variable set to `''` disables the source (`null` / `[]`), exactly as `AGENT_CANVAS_GEMINI_DIR` does. `NORMALIZER_FACTORIES` gets `null` for the four (filled by later tasks). `fileOnlySources` in `api/server.ts` loops over `FILE_ONLY_ORIGINS` and merges each running source's `status()`. `notify/engine.ts` `isErrorHook`: `false` for the four. `vitest.config.ts` `test.env` adds `AGENT_CANVAS_DSH_DIR`, `AGENT_CANVAS_WORKBUDDY_DIR`, `AGENT_CANVAS_CODEBUDDY_DIR`, `AGENT_CANVAS_DOUBAO_DIR`, all `''`.

- [ ] **Step 1: Failing tests.** `config-more-sources-cn.test.ts`: for each tool, override > own variable > tool variable > default; `''` disables; WorkBuddy default is two directories and an override is one; `defaultDoubaoDirs` for win32 (with and without `LOCALAPPDATA`), darwin, linux (`[]`); nothing is created on disk. Diagnostics: with no directories the four entries exist with `present: false`, `reading: false`, `sessionCount: 0`. Guard test: `TOOL_KEYS` lists the seven keys.
- [ ] **Step 2: Run; expect failure.**
- [ ] **Step 3: Implement**, then update the test call sites the guard flags (mechanical: add the four keys with temp or empty values).
- [ ] **Step 4: `npx --yes pnpm@10 typecheck && npx --yes pnpm@10 test`; expect pass.**
- [ ] **Step 5: Commit:** `feat: origins, configuration and diagnostics for four more sources`.

### Task 2: Tailing extensions — source-decoded lines, reader state, several watch roots

**Files:**
- Modify: `packages/server/src/sources/source.ts`, `src/pipeline.ts`, `src/sources/transcript/watcher.ts`
- Create: `packages/server/src/sources/guarded-reader.ts`
- Test: `packages/server/test/pipeline-reader-extension.test.ts`, `packages/server/test/guarded-reader.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  ```ts
  // sources/source.ts
  export interface SourceRead {
    lines: { offset: number; text: string }[]; // offset strictly increasing within one generation of the file
    newOffset: number;                          // byte position to resume from
    truncated: boolean;                         // the file was rewritten: lines restart from the beginning
    state?: string | null;                      // opaque reader state to persist with the offset; undefined = leave as is
  }
  // FileSource gains:
  readLines?(absPath: string, fromOffset: number, maxBytes: number, state: string | null): Promise<SourceRead>;
  readonly watchRoots?: readonly { dir: string; depth: number }[]; // preferred over rootDir/watchDepth when present

  // pipeline.ts
  export const READER_STATE_PREFIX = 'reader-state:'; // meta key prefix + store key of the file

  // sources/guarded-reader.ts
  /** readNewLines plus a guard: SHA-1 of the first and of the last (up to) 64 bytes already read; a mismatch means rewritten. */
  export function readGuardedLines(absPath: string, fromOffset: number, maxBytes: number, state: string | null): Promise<SourceRead>;
  ```
  The pipeline calls `source.readLines` instead of `readNewLines` when it exists, passes the stored state, and writes `res.state` in the same transaction as the offset. `truncated` drives the existing generation bump for `lineIdentity: 'offset'` sources. Sources without `readLines` take the exact existing path.

- [ ] **Step 1: Failing tests** with a fake source: lines from `readLines` are stored and applied; the state round-trips across a new `Pipeline` on the same store; `truncated: true` bumps the generation and all lines are stored again; a rewrite that leaves the size at or above the stored offset is detected by `readGuardedLines` (head changed; tail changed) as well as a shrink; plain append = same result as `readNewLines`; for a source without `readLines` the raw rows written are identical to those written before this change (same fixture, compare rows); the watcher subscribes to every `watchRoots` entry and to `rootDir` only when there is none.
- [ ] **Step 2: Run; expect failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the new tests and the whole suite; expect pass.**
- [ ] **Step 5: Commit:** `feat(pipeline): sources may decode their own lines and watch several roots`.

### Task 3: DeepSeek Harness — container and source

**Files:**
- Create: `packages/server/src/sources/deepseek/zstd-frames.ts`, `src/sources/deepseek/source.ts`
- Modify: `packages/server/src/cli-commands.ts` (`fileSources`)
- Test: `packages/server/test/deepseek-frames.test.ts`, `deepseek-source.test.ts`, `deepseek.timing.test.ts`, `packages/server/test/deepseek-fixtures.ts`

**Interfaces:**
- Consumes: Tasks 1-2; `docs/formats/deepseek-harness.md` sections 1, 2, 5, 6, 7.
- Produces:
  ```ts
  // zstd-frames.ts
  export function zstdAvailable(z?: { zstdDecompressSync?: unknown }): boolean;
  /** Walks Zstandard frame headers from `from`. `tornStart`: offset of an incomplete last frame. `corruptAt`: first offset that is not a frame. */
  export function scanZstdFrames(buf: Uint8Array, from?: number): { frames: { start: number; end: number }[]; tornStart: number | null; corruptAt: number | null };
  /** One decoded line per JSONL row. offset = line ordinal (header 0, then 1, 2, …). state = JSON {head, tail, lines}. */
  export function readDshLines(absPath: string, fromOffset: number, maxBytes: number, state: string | null): Promise<SourceRead>;

  // source.ts
  export interface DeepSeekLookup { storedFile(key: string): { sessionId: string; agentId: string | null; projectId: string | null } | null; knownProjectIds(): Iterable<string> }
  export class DeepSeekFileSource implements FileSource { constructor(dshHome: string, lookup?: DeepSeekLookup) }
  // origin 'deepseek'; rootDir <dshHome>/sessions; lineIdentity 'offset'; readLines = readDshLines

  // cli-commands.ts
  export function fileSources(config: Config, store?: Store, caps?: { zstd: boolean }): FileSource[];
  ```
  Rules: only `session.v4.jsonl.zstd` is a session file; `.tmp` and other names are ignored; a session directory with no v4 file but an older `session*.jsonl.zstd` counts in `status().legacyFiles`; a higher version file is counted and skipped while v4 beside it is still read. Rewrite = file shorter than the stored offset, or first frame's hash differs, or the bytes at the resume offset are not a frame start, or the tail fingerprint differs → `truncated: true`, restart at 0. A torn last frame is left for the next read. `classify` decodes frame 1 (bounded) for `id`, `cwd`, `parentSession`, `origin`: no parent → `session`, project `ProjectIdResolver.forCwd(cwd)`; a subagent → `agent` of the root found by following `parentSession` headers (at most 16 levels, cycle check), and `null` while a link in the chain cannot be read yet. When `caps.zstd` is false the source is not created and diagnostics carry `unavailable: '需要 Node 22.15 或更高'`.

- [ ] **Step 1: `deepseek-fixtures.ts`:** builders that write a v4 file frame by frame with `zlib.zstdCompressSync` (checksum flag on), header in frame 1; helpers to append a batch, tear the last frame, truncate. Tests that need zstd skip with a message when `zstdAvailable()` is false.
- [ ] **Step 2: Failing tests.** Frames: scanning finds every boundary; frame-by-frame reading equals one-shot; a torn tail waits and completes later; each rewrite case restarts and yields the new content; line ordinals are contiguous across reads; state survives a restart. Source: classification of main and subagent files in both arrival orders, multi-level; a directory with only old-format files is counted, not read; a v5 file beside v4; missing `sessions` directory creates nothing; `caps.zstd = false`. Timing: 30,000 frames — bounded memory per read (spy on the bytes read per call) and time within `gapBound`.
- [ ] **Step 3: Run; expect failure.**
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run the new tests and the whole suite; expect pass.**
- [ ] **Step 6: Commit:** `feat(deepseek): framed zstd reader and file source`.

### Task 4: DeepSeek Harness — normaliser

**Files:**
- Create: `packages/server/src/normalize/deepseek.ts`
- Modify: `packages/server/src/normalize/registry.ts`, `src/normalize/files.ts` (`deepseekTouches`)
- Test: `packages/server/test/normalize-deepseek.test.ts`, `deepseek-e2e.test.ts`; extend `deepseek-fixtures.ts`

**Interfaces:**
- Consumes: Task 3; `docs/formats/deepseek-harness.md` sections 4 and 5; spec section 3.3-3.5 and 10.
- Produces: `export class DeepSeekNormalizer implements AgentNormalizer`; `export function deepseekNodeId(sessionId: string, agentId: string | null, part: string): string`; `export function deepseekTouches(toolName: string, input: unknown): …` in the shape the other `*Touches` have.
  Mapping is the table in spec 3.3. Tool nodes are keyed by `(turn, step, callId)` (a `callId` is unique only within a step). Usage: `inputTokens = inputTokens + cacheWriteTokens`, `cachedInputTokens = cacheReadTokens`, `outputTokens = outputTokens`; the node carries the assistant message id as `messageId`. Model goes into the node's `detail.raw` as Gemini does. `turn/end` with reason `error` → the turn's last node failed; `aborted` / `interrupted` → interrupted. The compaction checkpoint is a `system` node with `systemSubtype: 'compact'`. A restart (`offset <= lastOffset`) resets the thread and removes its nodes, as Grok's `resetThread` does. Subagent link: spec 3.5; inherited `subagent/catalog` rows of a fork prefix are ignored.

- [ ] **Step 1: Failing tests:** each row of the spec 3.3 table; the user source kinds (only `user` is a prompt; `compact-checkpoint` is the system node; the rest produce nothing and are not "unknown"); text / reasoning / tool-call blocks; pairing and failed results; the same `callId` in two steps gives two nodes; title last-wins; cwd change; usage mapping; unknown type counted; one-shot = appended line by line = rebuild; child before and after parent, multi-level, unmatched activation unlinked, `mode: 'external'` no thread; a fork is its own session with the copied prefix; a rewritten file removes the stale nodes.
- [ ] **Step 2: Run; expect failure.**
- [ ] **Step 3: Implement and register the factory.**
- [ ] **Step 4: Run; expect pass; whole suite.**
- [ ] **Step 5: Commit:** `feat(deepseek): normaliser`.

### Task 5: Buddy family — normaliser

**Files:**
- Create: `packages/server/src/normalize/buddy-prompt.ts`, `buddy-branch.ts`, `buddy-usage.ts`, `buddy.ts`
- Modify: `packages/server/src/normalize/registry.ts`, `src/normalize/files.ts` (`buddyTouches`)
- Test: `packages/server/test/buddy-prompt.test.ts`, `buddy-branch.test.ts`, `buddy-usage.test.ts`, `normalize-buddy.test.ts`, `buddy.timing.test.ts`, `packages/server/test/buddy-fixtures.ts`

**Interfaces:**
- Consumes: Tasks 1-2; `docs/formats/buddy-family.md` sections 2-8; spec section 4 and 10.
- Produces:
  ```ts
  // buddy-prompt.ts
  /** What the human typed in a user message's content, or null when nothing remains (format reference 4.1). */
  export function humanText(content: unknown): string | null;
  export function classifyUserMessage(rec: unknown): 'prompt' | 'queued-prompt' | 'compaction' | 'hidden'; // 4.2; flags are read from providerData
  // buddy-branch.ts
  export interface BranchLine { id: string | null; parentId: string | null; logicalParentId: string | null; type: string; custom: boolean; isCompactAgent: boolean; contentFilterNotice: boolean; resendForkNotice: boolean }
  /** Indices of the lines on the active branch, or null when the file has no fork marker (show everything). Port of the algorithm in format reference section 7. */
  export function activeBranch(lines: readonly BranchLine[]): ReadonlySet<number> | null;
  // buddy-usage.ts
  /** One usage record in this project's convention, plus its total for "keep the largest"; null when not a usage object. Every shape of format reference 6.3. */
  export function buddyUsage(src: unknown): { usage: Usage; total: number } | null;
  // buddy.ts
  export class BuddyNormalizer implements AgentNormalizer { constructor(origin: 'workbuddy' | 'codebuddy') }
  export function buddyNodeId(sessionId: string, agentId: string | null, part: string): string;
  ```
  Usage: one usage per `providerData.messageId`, the largest seen, held on the first displayed node of that response (moved or raised as later records arrive, the way Grok's `usageOn` moves usage); `inputTokens` = prompt − cache read (cache writes stay in); a `model-usage` record whose `messageId` has no displayed node is added to the nearest preceding displayed node of the thread. Turns by `providerData.conversationRequestId` when present, else one per accepted prompt; a `queued-prompt` stays in the running turn. Results pair with the nearest preceding call of the same `callId` that has no result; orphan results are dropped and counted; `function_call_output` is accepted as a result. Titles `custom-title` > `ai-title` > `topic`. When `activeBranch` changes from null or from another set, nodes that left the branch are removed with `node_removed` and nodes that joined are added; the walk is recomputed only when a fork marker arrives (appending without markers stays O(1) per line). Model `auto` is replaced by a concrete model seen in the session. The normaliser must hold no tool input or output text in memory beyond the record being applied.

- [ ] **Step 1: `buddy-fixtures.ts`:** line builders for every record type of the format reference, with the envelope fields.
- [ ] **Step 2: Failing tests.** Prompt: each wrapper and each flag of format reference section 4. Branch: no marker → null; rewind; edit-and-resend; content filter notice; compaction (not a branch switch); duplicate ids; each result equals a hand-computed set stated in the test. Usage: every row of 6.3; largest-wins; no `messageId`; `model-usage` without a node. Normaliser: every record type; reasoning from `rawContent` then `content`; result shapes of 3.6; title priority; `auto`; orphans; turns with and without `conversationRequestId`; a fork notice arriving mid-append removes the abandoned nodes; one-shot = appended = rebuild; a restart of the file resets the thread; both origins from the same lines. Timing: 200,000 lines with fork markers every 20,000 — time within `gapBound`, memory bounded.
- [ ] **Step 3: Run; expect failure.**
- [ ] **Step 4: Implement and register both factories.**
- [ ] **Step 5: Run; expect pass; whole suite.**
- [ ] **Step 6: Commit:** `feat(buddy): normaliser for WorkBuddy and CodeBuddy Code`.

### Task 6: Buddy family — sources

**Files:**
- Create: `packages/server/src/sources/buddy/source.ts`
- Modify: `packages/server/src/cli-commands.ts` (`fileSources`)
- Test: `packages/server/test/buddy-source.test.ts`, `buddy-e2e.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 5; `docs/formats/buddy-family.md` section 1; spec 4.1, 4.6, 4.7.
- Produces:
  ```ts
  export interface BuddyLookup { storedFile(key: string): { sessionId: string; agentId: string | null; projectId: string | null } | null; knownProjectIds(): Iterable<string> }
  export class BuddyFileSource implements FileSource {
    constructor(origin: 'workbuddy' | 'codebuddy', roots: readonly { label: string; dir: string }[], lookup?: BuddyLookup);
  }
  /** `…/2026-10-27-13-46-52` → its parent directory; anything else unchanged. */
  export function workbuddyProjectDir(cwd: string): string;
  ```
  One instance per origin holding all its roots; store keys carry the root label; `watchRoots` = each `<root>/projects` at depth 3; `lineIdentity: 'offset'`; `readLines = readGuardedLines`. A session file is `<project>/<uuid>.jsonl`; `<project>/<uuid>/subagents/agent-*.jsonl` is an agent of that session (nested `<X>/subagents/…` under a known agent stem maps to its root session). Project: bounded scan of the file's head for the first line with a `cwd`, then `ProjectIdResolver.forCwd` (for `workbuddy`, of `workbuddyProjectDir(cwd)`); `null` (not yet classifiable) while no `cwd` has been written. The same session id under a second root: the first read (or already stored) wins, the other is skipped and counted in `status().duplicateSessions`. `workbuddy.db`, `traces/`, `.meta.json` and tombstone names are not session files.

- [ ] **Step 1: Failing tests:** the same fixture under the three roots gives `workbuddy` / `workbuddy` / `codebuddy`; duplicate session across the two WorkBuddy roots; override directory = one root; classification of session and subagent files, nested subagents; project from a later line when the first lines have no `cwd`; timestamp-folder rule for `workbuddy` only, pattern `^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$`; same directory as a Claude session → one project; subagent linked through `toolResult.subAgent.sessionId`, unlinked without it; shrink and same-size rewrite re-derive the session; missing roots create nothing; e2e through `Pipeline` + API (projects, graph, node detail).
- [ ] **Step 2: Run; expect failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; expect pass; whole suite.**
- [ ] **Step 5: Commit:** `feat(buddy): file sources for WorkBuddy and CodeBuddy Code`.

### Task 7: Doubao Work

**Files:**
- Create: `packages/server/src/sources/doubao/source.ts`, `src/sources/doubao/assignment.ts`, `src/normalize/doubao.ts`
- Modify: `packages/server/src/cli-commands.ts`, `src/normalize/registry.ts`, `src/normalize/files.ts` (`doubaoTouches`), `packages/server/test/store-line-identity.test.ts` (the per-origin list of `'offset'` sources)
- Test: `packages/server/test/doubao-assignment.test.ts`, `doubao-source.test.ts`, `normalize-doubao.test.ts`, `doubao-e2e.test.ts`, `packages/server/test/doubao-fixtures.ts`

**Interfaces:**
- Consumes: Tasks 1-2; `docs/formats/doubao-work.md`; spec section 5 and 10.
- Produces:
  ```ts
  // assignment.ts
  /** The demand sections of an assignment.md, reminder-only sections dropped; `at` is null when the header time does not parse. */
  export function parseAssignment(text: string): { at: number | null; text: string }[];
  // source.ts
  export const DOUBAO_PROJECT = 'doubao-work';
  export class DoubaoFileSource implements FileSource { constructor(roots: readonly string[], lookup?: …) }
  // normalize/doubao.ts
  export class DoubaoNormalizer implements AgentNormalizer {}
  ```
  Discovery: under each root, every `Default` / `Profile N` directory, namespace `.doubaowork` or `.doubao`, then `agent_mode/workspace/.sessions`; `watchRoots` = each discovered `.sessions` directory at depth 4 (never the Chromium profile tree itself); new profiles are found by the periodic full scan. A session is a `.sessions/<conversationId>` directory; the main agent is the single directory matching `^m_[a-zA-Z0-9]+$` (none or several: the conversation is not read and is counted as unknown); other agent directories are threads. `trajectory.jsonl` is tailed with `lineIdentity: 'offset'` and `readGuardedLines`; when a file is read from offset 0 the reader first emits one synthetic line `{"__agentCanvas":"file","mtimeMs":<n>}` so the fallback time is stored with the raw events and replays identically. `assignment.md` enters through the existing whole-file kinds (`title` for the main agent, `agent_meta` for the others), with a size cap. All sessions use project `DOUBAO_PROJECT`. The same conversation id under another root or profile: first wins, counted. Normaliser: rows per spec 5.2 (an assistant row with `tool_calls` and absent or null `content` is valid); each prompt opens a turn; node times per spec 5.3, with `mtimeFallbacks` counted; the first demand without a user row gets a prompt node from the assignment text; `create_agent` linking per spec 5.4; no usage, no model, no cwd.

- [ ] **Step 1: Failing tests.** Assignment: the header regex of the format reference, several demands, reminder-only sections, unparsable time, a body over 64 KiB dropped. Source: both variants and several profiles; main-agent rule; watch roots; duplicates; missing roots. Normaliser: each row kind; two identical rows are two nodes; `arguments` as object and as JSON string; reminder prefix stripped; times from the nth demand and the mtime fallback; missing first user row; subagent thread linked through the `create_agent ok` result and unlinked when unparsable; unknown role counted; a rewritten file re-derives; one-shot = appended = rebuild. E2E: the project is `doubao-work`; no cost anomaly is produced.
- [ ] **Step 2: Run; expect failure.**
- [ ] **Step 3: Implement and register.**
- [ ] **Step 4: Run; expect pass; whole suite.**
- [ ] **Step 5: Commit:** `feat(doubao): Doubao Work source and normaliser`.

### Task 8: Web, cross-feature tests, docs, version

**Files:**
- Modify: `packages/web/src/home.ts` (`ORIGIN_LOOK`, `projectTitle`: id `doubao-work` → `豆包工作`), `OriginBadge.tsx`, `diagnostics.ts`, `masking.ts` (loop over `FILE_ONLY_ORIGINS`), `pages/Diagnostics.tsx`, `styles.css`; the web tests that enumerate origins
- Create: `packages/server/test/more-sources-cn-features.test.ts`
- Modify: `docs/manual.md`, `README.md`, `scripts/pack.mjs` (description, keywords), the four `package.json` versions → `0.2.0`, the spec's status line
- Test: web tests for the looks and the new diagnostics lines

**Interfaces:**
- Consumes: everything above.
- Produces: no new interface.

- [ ] **Step 1: Failing tests.** Web: a look, a mark and a colour for each of the ten origins; the home filter still shows only origins with data; diagnostics blocks for the four with the lines for `dirs`, `legacyFiles`, `unavailable`, `duplicateSessions`, `mtimeFallbacks`; masked diagnostics cover the four. Server `more-sources-cn-features.test.ts`, modelled on `more-sources-features.test.ts`: the four origins in projects, title search, content search, stats (Doubao with zero tokens), by-file view, anomalies, Markdown and HTML export, masking of a fake secret; the existing six origins give identical API output with and without the four new directories present; one directory shared by Claude, DeepSeek, WorkBuddy and CodeBuddy sessions is one project.
- [ ] **Step 2: Run; expect failure.**
- [ ] **Step 3: Implement the web changes.**
- [ ] **Step 4: Docs.** `docs/manual.md`: a section `DeepSeek Harness、WorkBuddy、CodeBuddy Code、豆包工作` with the same subsections as the Gemini / Grok / Copilot one — where each is read from; what is shown; what is not (Doubao: no thinking, model, usage, working directory; title from the first prompt; times per demand; cloud-computer tasks and plain chat not readable; DeepSeek: format v4 only, needs Node 22.15 or later; Buddy: abandoned branches hidden and their usage not counted, usage conversion unverified); the statement that all four are unverified against real data; a pointer to `docs/formats/`; the four environment variables in the table; the by-file tool names marked unverified. `README.md`: the supported-tools table and list, the configuration table. Do not claim anything was tested on real data.
- [ ] **Step 5: Version `0.2.0`** in the four `package.json` files; `scripts/pack.mjs` description and keywords.
- [ ] **Step 6: Full verification:** `npx --yes pnpm@10 typecheck && npx --yes pnpm@10 build && npx --yes pnpm@10 test && npx --yes pnpm@10 release`.
- [ ] **Step 7: Commit:** `feat: looks, cross-feature tests and docs for four more sources; 0.2.0`.

---

## After the tasks (controller, with the user)

- Main-versus-branch comparison (spec section 7): check out `main` in a `git worktree`, build both, feed both the same invented Claude / Codex / Cursor / Gemini / Grok / Copilot inputs on temp directories, and diff every API output for the six existing origins (projects, sessions, graphs, node details, stats, anomalies, files, searches, Markdown export, the data embedded in the HTML export). Remove the worktree afterwards. Part of the final review.
- Real machine (spec 7.1): back up the real database to D:, restart the real service on the new build, compare counts only.
- Push, PR, merge and the `v0.2.0` tag only when the user asks for each.
