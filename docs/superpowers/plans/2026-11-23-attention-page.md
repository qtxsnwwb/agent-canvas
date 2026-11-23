# Attention Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A page that lists the sessions waiting for the user (permission, error, stuck, finished), live, with "知道了" and auto-hide, consistent with the desktop notifications.

**Architecture:** A server-side `AttentionService` keeps a small per-session state (main-thread markers) fed by the pipeline's change stream and loaded from the store at start, decides each session's item with a pure function, keeps dismissals and the auto-hide limit in one `meta` key, and pushes item changes over the existing WebSocket to sessions-scope connections. The error-marker judgements are extracted from the notification engine into shared helpers that both use. The web gets a new route, page and header link.

**Tech Stack:** TypeScript (ESM, Node >= 22), Fastify, better-sqlite3, React + Vite, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-23-attention-page-design.md` (binding; its "用户决定" / "我的决定" notes are part of it).

## Global Constraints

- Four kinds, in this priority: `permission` > `error` > `stuck` > `finished` (spec 3). There is no `input` kind: `awaiting_input` counts as `idle`.
- "Latest activity" in spec 3 = the timestamp of the session's **last main-thread node**, never `Session.lastActivityAt`.
- `stuck` threshold = notification settings' `stuckMinutes` (read through `loadNotificationSettings`, also while notifications are off).
- Origins that cannot tell finished from running: `grok`, `copilot`, `doubao` — counted, never in the main list.
- A session with no main-thread prompt node, `ended`, or `sourceDeleted` has no item.
- Auto-hide limit: default 24 hours, integer 1..720. Hidden list and stored dismissals: only items whose `since` is within 30 days.
- Explanation text: node title/summary only, cut to 200 characters; the web masks it with the page masker.
- Notification output must be byte-for-byte unchanged (every existing notify test passes unmodified).
- No change to `NORMALIZER_VERSION` (34) or to any table's columns. An index, if one is needed, is `CREATE INDEX IF NOT EXISTS` at open, needs no rebuild, and is measured.
- Write routes use `sameOriginJson` and answer 503 `{ error: '数据库正在整理，稍后再试' }` while `pipeline.writesHeld()`.
- Tests use temp dirs / in-memory stores only; never real tool directories; never port 4317; no real desktop notification. Root commands: `npx --yes pnpm@10 typecheck`, `npx --yes pnpm@10 test`, one file `npx --yes pnpm@10 exec vitest run <path>`. Wall-clock bounds go in `*.timing.test.ts` scaled by `AGENT_CANVAS_TIMING_SCALE`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push; do not open a PR.

## Review Focus

1. A Claude Code turn that ends, then ~60 s later turns `awaiting_input` (the `idle_prompt` hook bumps activity): the item stays the same episode (same kind, same `since`), a "知道了" survives. (Task 2)
2. A subagent thread keeps writing after the main turn ended: the main item and its `since` do not move. (Task 2)
3. A `StopFailure` hook with no node, then a service restart: the item is `error` before and after. (Tasks 1, 2)
4. A 100,000-node session receiving appends: recomputing its item never reads the whole graph; one change batch costs O(changed nodes). (Task 2 timing)
5. A session left in `awaiting_permission` for weeks: it leaves the main list after the limit, leaves the hidden list after 30 days, and its dismissal record is pruned. (Task 2)

---

### Task 1: Shared types and the extracted error-marker helpers

**Files:**
- Create: `packages/shared/src/attention.ts` (export from `packages/shared/src/index.ts`)
- Create: `packages/server/src/notify/markers.ts`
- Modify: `packages/server/src/notify/engine.ts` (use the helpers; behaviour unchanged)
- Test: `packages/shared/test/attention.test.ts`, `packages/server/test/notify-markers.test.ts`

**Interfaces:**
- Produces (shared):
  ```ts
  export type AttentionKind = 'permission' | 'error' | 'stuck' | 'finished';
  export const ATTENTION_KIND_ORDER: readonly AttentionKind[] = ['permission', 'error', 'stuck', 'finished'];
  export const ATTENTION_UNDETERMINABLE_ORIGINS: readonly Origin[] = ['grok', 'copilot', 'doubao'];
  export const ATTENTION_LIMITS = { autoHideHours: { min: 1, max: 720, default: 24 }, keepDays: 30, explanationChars: 200 } as const;
  export interface AttentionItem {
    key: string;              // `${sessionId}|${kind}|${since}`
    sessionId: string; kind: AttentionKind; since: string; // ISO
    title: string | null; origin: Origin; projectId: string; cwd: string | null;
    explanation: string | null; nodeId: string | null;
  }
  export interface AttentionHidden { item: AttentionItem; reason: 'dismissed' | 'expired' }
  export interface AttentionResponse {
    items: AttentionItem[];            // main list, sorted per spec 5
    hidden: AttentionHidden[];         // since within keepDays, newest first
    undeterminable: { sessionId: string; title: string | null; origin: Origin }[];
    runningCount: number; autoHideHours: number;
  }
  export function attentionKey(sessionId: string, kind: AttentionKind, since: string): string;
  export function sortAttention(items: readonly AttentionItem[]): AttentionItem[]; // kind order, then since newest first
  export function validateAutoHideHours(v: unknown): { ok: true; value: number } | { ok: false; error: string };
  ```
  `ServerMessage` in `packages/shared/src/api.ts` gains `| { type: 'attention'; response: AttentionResponse }`.
- Produces (server, `notify/markers.ts`):
  ```ts
  /** A main-thread node that by itself marks the current turn as failed or interrupted (engine.ts header comment). */
  export function isErrorMarkerNode(origin: Origin, node: Pick<GraphNode, 'kind' | 'systemSubtype' | 'status' | 'agentId'>, isAbortedCall: () => boolean): boolean;
  export { isErrorHook } from './engine.js'; // or moved here and re-exported from engine.ts; same signature
  ```
  `isErrorHook` must cover Codex `Interrupt` as it does now.

- [ ] **Step 1: Failing tests.** Shared: `attentionKey` format; `sortAttention` orders `permission, error, stuck, finished` and newest first within a kind; `validateAutoHideHours` accepts 1 and 720, rejects 0, 721, 1.5, '24', null. Server: `isErrorMarkerNode` true for a main-thread `system`/`interrupt` node of every origin, false for a subagent's, true for a Cursor `failed` call only when `isAbortedCall()` is true, false otherwise; `isErrorHook` cases copied from the engine's existing tests (Claude `StopFailure`, Codex `Interrupt`, Cursor `stop` with `error`/`aborted`, and their negatives).
- [ ] **Step 2: Run; expect failure.**
- [ ] **Step 3: Implement**; change `engine.ts` to call `isErrorMarkerNode` where it now tests `kind === 'system' && systemSubtype === 'interrupt'` and the Cursor aborted-call branch.
- [ ] **Step 4: Run the new tests and every `packages/server/test/notify*.test.ts` file unmodified; expect pass.** Typecheck.
- [ ] **Step 5: Commit:** `refactor(notify): share the error-marker judgements; attention types`.

### Task 2: AttentionService

**Files:**
- Create: `packages/server/src/attention/decide.ts`, `packages/server/src/attention/service.ts`
- Modify: `packages/server/src/store/store.ts` (the queries below)
- Test: `packages/server/test/attention-decide.test.ts`, `attention-service.test.ts`, `attention.timing.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  ```ts
  // decide.ts — pure
  export interface SessionMarks {
    session: Session;
    lastPromptAt: string | null;          // latest main-thread prompt
    errorAt: string | null;               // latest error marker (node or hook) after lastPromptAt
    errorNode: { id: string; text: string } | null;
    waitingNode: { id: string; text: string } | null;   // a node (main or subagent) with status awaiting_permission
    lastMainNode: { id: string; timestamp: string; text: string } | null;
    lastReply: { id: string; text: string } | null;     // latest main-thread text node
  }
  export function decideAttention(m: SessionMarks, nowMs: number, stuckMinutes: number): AttentionItem | null;
  // store.ts
  sessionsActiveSince(iso: string): Session[];                       // by stored lastActivityAt, a cheap superset
  mainTailNodes(sessionId: string, sinceIso: string | null, limit: number): GraphNode[]; // main-thread nodes at/after sinceIso, newest first
  hookEventsSince(sessionId: string, sinceIso: string): { eventName: string; receivedAt: string; payload: Record<string, unknown> | null }[];
  // service.ts
  export class AttentionService {
    constructor(deps: { store: Store; now(): number; stuckMinutes(): number; isAbortedCall(sessionId: string, nodeId: string): boolean });
    noteChanges(changes: readonly Change[]): void;     // pipeline.onChanges
    snapshot(): AttentionResponse;
    dismiss(key: string): { ok: true } | { ok: false; error: string };
    restore(key: string): { ok: true } | { ok: false; error: string };
    setAutoHideHours(v: unknown): { ok: true; value: number } | { ok: false; error: string };
    onUpdate(listener: (r: AttentionResponse) => void): () => void;  // after a change that alters the response, coalesced
    tick(): void;                                       // time-driven re-evaluation; started by the caller every 30 s
    close(): void;
  }
  ```
  `decideAttention` implements spec 3 and the Global Constraints: `awaiting_permission` → `permission` (`since` = waiting node time else last main node time); `idle`/`awaiting_input` with `errorAt` → `error` (`since` = `errorAt`); `running` and last main node older than `stuckMinutes` → `stuck`; `idle`/`awaiting_input` → `finished` (`since` = last main node time); none of these, no prompt, `ended`, `sourceDeleted` → null. Explanation per spec 4.3, cut to 200 characters. Marks are kept per session in memory and updated from `node_added` / `node_updated` / `node_removed` / `session_upserted` of that session only; at start, loaded for `sessionsActiveSince(now − 30 d)` with `latestMainPromptAt`, `mainTailNodes` and, for `claude` / `codex` / `cursor`, `hookEventsSince(lastPromptAt)` filtered with `isErrorHook`. On a `session_upserted` leaving `running` for those three origins, re-read `hookEventsSince` for that session (the hook row is stored before the change is emitted — verify, and test it). A `node_removed` of a marked node re-reads that session's tail. Meta key `attention`: `{ autoHideHours: number, dismissed: string[] }`; on every write drop keys whose `since` is older than 30 days or whose session is no longer a candidate. Main list: item not dismissed and `since` within `autoHideHours`; else hidden with its reason.

- [ ] **Step 1: Failing tests — decide.** Each kind; priority when several hold; `awaiting_input` after `idle` keeps kind and `since`; a later error marker turns `finished` into `error` with a new key; no prompt → null; `ended` and `sourceDeleted` → null; `stuck` at `stuckMinutes` − 1 s vs + 1 s; explanation cut at 200 characters.
- [ ] **Step 2: Failing tests — service (in-memory store, changes applied through `store.applyChanges` and fed to `noteChanges`).** Review Focus 1, 2, 3 (`StopFailure` stored as a hook raw event, no node; restart = a new service over the same store), 5; dismiss hides only the current key and a new episode reappears; restore; auto-hide boundary; changing the limit applies at once; hidden list keeps 30 days; dismissal pruning bounded after 10,000 dismissals; `grok`/`copilot`/`doubao` only in `undeterminable`; a subagent waiting for permission gives `permission` with the subagent's node id; `onUpdate` fires once for a batch that changes one session several times and not for a batch that changes nothing; `tick` turns a quiet running session into `stuck`; a rebuild (`clearDerived` then re-ingest) gives the same response.
- [ ] **Step 3: Failing timing test.** A 100,000-node session: start-up load and 1,000 appended batches stay within bounds that a whole-graph read per batch would exceed (state the measured numbers in a comment).
- [ ] **Step 4: Run; expect failure.**
- [ ] **Step 5: Implement.** For the store queries use the existing indexes (`node_main_prompt`, the session/raw indexes); if a query needs another index, add it with `CREATE INDEX IF NOT EXISTS` and say why in the report.
- [ ] **Step 6: Run; expect pass; whole suite; typecheck.**
- [ ] **Step 7: Commit:** `feat(attention): service deciding which sessions wait for the user`.

### Task 3: API and live push

**Files:**
- Modify: `packages/server/src/api/server.ts`
- Test: `packages/server/test/api-attention.test.ts`

**Interfaces:**
- Consumes: Task 2.
- Produces:
  - `GET /api/attention` → `AttentionResponse`
  - `POST /api/attention/dismiss` body `{ key: string }` → `AttentionResponse`
  - `POST /api/attention/restore` body `{ key: string }` → `AttentionResponse`
  - `PUT /api/attention/settings` body `{ autoHideHours: number }` → `AttentionResponse`; 400 `{ error }` when invalid
  - WebSocket: every connection subscribed with `scope: 'sessions'` receives `{ type: 'attention', response }` after each `onUpdate`.
  `buildServer` creates the service (overridable through a new optional `attention` dependency for tests), subscribes it to `pipeline.onChanges`, runs `tick` every 30 s (timer unref'd, cleared on close), and does so outside the `notifications !== undefined` block. `stuckMinutes` comes from `loadNotificationSettings(store)`; `isAbortedCall` as `notify/service.ts` does it.

- [ ] **Step 1: Failing tests:** each route's answer; dismiss/restore/settings require same-origin JSON (403 otherwise, as the export routes are tested) and answer 503 while writes are held; invalid key and invalid hours answer 400; a sessions-scope WebSocket client receives an `attention` message after a change that adds an item and none after an unrelated change; a session-scope client does not receive it; the timer is cleared on `app.close()`.
- [ ] **Step 2: Run; expect failure.** **Step 3: Implement.** **Step 4: Run; expect pass; whole suite.**
- [ ] **Step 5: Commit:** `feat(attention): API and live updates`.

### Task 4: Web page

**Files:**
- Create: `packages/web/src/attention.ts` (view logic: grouping, labels, relative times, masking), `packages/web/src/pages/Attention.tsx`
- Modify: `packages/web/src/route.ts` (`{ page: 'attention' }` for `#/attention`), `App.tsx` (header link “待处理” with the main-list count, hidden at 0), `client.ts` (the four calls), `liveSource.ts` or the sessions-scope subscription (receive `attention`), `masking.ts` (`maskAttention(r, m)` modelled on `maskAnomalyList`), `pages/Home.tsx` (“N 个正在进行” links to `#/attention`), `styles.css`
- Test: `packages/web/test/attention.test.ts`, additions to the route and masking tests

**Interfaces:**
- Consumes: Tasks 1, 3.
- Produces: no new interface for later tasks.

Page per spec 5 and its sketch: rows of kind label · origin badge · project · relative time, the explanation line, a “知道了” button that does not navigate; row click opens `#/s/<id>/n/<nodeId>` (or `#/s/<id>` without a node); “显示已移出的” with each item's reason and an undo for `dismissed`; the auto-hide limit editable (1..720); the footer “运行中 N 个 · 无法判断状态的 M 个（…）” with the undeterminable sessions expandable; empty state “此刻没有需要你处理的会话” plus the running count. Kind labels: `permission` 等你批准, `error` 出错中断, `stuck` 卡住了, `finished` 跑完了. Live: updates from the WebSocket message without reload; the header count updates on every page.

- [ ] **Step 1: Failing tests:** `parseHash('#/attention')`; grouping and order; labels; masked explanation with the switch on; header count hidden at 0; undo only offered for `dismissed`; a click on “知道了” does not navigate (component test as the existing page tests do).
- [ ] **Step 2: Run; expect failure.** **Step 3: Implement.** **Step 4: Run; expect pass; whole suite.**
- [ ] **Step 5: Commit:** `feat(attention): the 待处理 page`.

### Task 5: Cross-feature check and docs

**Files:**
- Create: `packages/server/test/attention-features.test.ts`
- Modify: `docs/manual.md` (new section “待处理” after “通知”), `README.md` (feature list), the spec's status line

**Interfaces:** consumes everything above; produces nothing.

- [ ] **Step 1: Failing test `attention-features.test.ts`:** through `Pipeline` and the HTTP API on temp directories, one session per origin using the existing fixtures (`*-fixtures.ts`): each origin whose notification table says “跑完了 ✅” yields `finished` after a completed turn; each whose “出错中断” is ✅ yields `error` after its error scenario; and for every origin and scenario the kind equals what `NotificationEngine` notifies for the same change stream (`finished` ↔ `finished`, `error` ↔ `error`, `permission` ↔ `permission`); `grok`/`copilot`/`doubao` appear only as undeterminable.
- [ ] **Step 2: Run; expect failure; fix in the owning code; run; expect pass.**
- [ ] **Step 3: Docs.** Manual section: what the page is for; the four kinds and when each applies; which origins can show which (a table matching the notification table, including the three undeterminable ones); “知道了”, auto-hide (default 24 h, 1-720), the 30-day hidden list; the stuck threshold shared with notifications; that `awaiting_input` counts as finished; that the explanation follows the masking switch. README: one line in the feature list.
- [ ] **Step 4: Full verification:** `npx --yes pnpm@10 typecheck && npx --yes pnpm@10 build && npx --yes pnpm@10 test && npx --yes pnpm@10 release`.
- [ ] **Step 5: Commit:** `feat(attention): cross-feature test and docs`.

---

## After the tasks (controller, with the user)

- Whole-branch review; main-versus-branch check that notification output and every existing API answer are unchanged.
- Push, PR, merge, and any version bump only when the user asks.
