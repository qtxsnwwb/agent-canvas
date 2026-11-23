# Timeline View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "时间线" view on the session page that puts the main thread and every subagent on one time axis and ranks subagents by how long the main thread waited for them, with each one's own time alongside.

**Architecture:** A pure module in `packages/web/src/canvas/` computes, from the session graph the page already holds and the waterfall clock, the thread tree, each thread's blocking intervals, the session total (union of turn intervals), a moment-by-moment attribution of that total to exactly one thread, and per-thread own time by dispatch segments. A new React view renders it in place of the canvas; the existing execution (waterfall) panel stays and follows the timeline's own scope. No server change.

**Tech Stack:** TypeScript, React + Vite, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-24-agent-timeline-design.md` (binding; "用户决定" notes are the user's decisions).

## Global Constraints

- No server, API, store or `NORMALIZER_VERSION` change.
- Invariant: every moment of the session total belongs to exactly one thread; the sum of all subagents' wait times plus the main thread's own time equals the total (to the millisecond).
- Total = length of the **union** of turn intervals; a turn runs from its prompt to the later of its last main-thread step that is not a dispatch / `wait_agent` and the end of the blocking intervals in that turn (to "now" while it is in progress). Time after a turn's end is in nobody's wait.
- Default sort: wait time, descending, among siblings; switchable to start time.
- Own time: by dispatch segments (spec 3.3); several dispatches of one agent = one row with a segmented bar.
- Doubao sessions show only "这个来源没有记录每一步的时间，无法生成时间线".
- Step intervals and the clock: exactly the waterfall's (`buildWaterfall` rules, `waterfallClock`, `snapshotClock` for snapshots). Computed on the full graph regardless of 精简 / 完整.
- The timeline is page state, not a new `ViewMode`; the existing views and the waterfall panel's tests pass unchanged.
- The export viewer gets the view too; nothing in the module loads a worker by URL (the viewer's CSP forbids it).
- Tests use invented data only. Root commands: `npx --yes pnpm@10 typecheck`, `npx --yes pnpm@10 test`, `npx --yes pnpm@10 build`; one file `npx --yes pnpm@10 exec vitest run <path>`. Wall-clock bounds in `*.timing.test.ts` scaled by `AGENT_CANVAS_TIMING_SCALE`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push; do not open a PR.

### Background detection (decided while planning; replaces spec 3.1's "read `run_in_background` from the input")

A node's `summary` is its input JSON cut at 200 characters, so `run_in_background` is often cut off behind a long prompt, and the full input is only in the lazily fetched node detail. Instead, for every origin except Codex: **a dispatch blocks its parent only until the parent starts a new step that is not part of the same message** (same `messageId`, i.e. the parallel calls the dispatch was issued with; an origin without message ids — Cursor, Grok — uses fork siblings, nodes with the dispatch's `parentId`), **another dispatch included** (review round 1 ruling: only the calls of the same message are skipped, so a background launch followed by a foreground dispatch in the next message stops blocking there, and the foreground agent takes the wait). A step at the dispatch's own timestamp is simultaneous, not later, and never ends the block. After that moment the parent is evidently not waiting; the rest of the dispatch interval does not block. A foreground dispatch has no such step before its result, so it blocks for its whole interval; a Claude background dispatch stops blocking as soon as the main thread carries on, and blocks nothing once the turn has ended. Grok chains every node to the one before (no batch marker), so there a call issued together with a dispatch counts as carrying on. Codex: `spawn_agent` / `followup_task` / `send_message` never block; a `wait_agent` step blocks for its interval, on the agents named in its input (parsed from `summary`; when that fails, on the parent's child threads that are active at that moment).

## Review Focus

1. A Claude background agent that keeps running after the main thread's final reply: zero wait, bar drawn to its end, own time counted, total unchanged by it. (Task 1)
2. Two turns whose intervals overlap because of background work: the total counts the overlap once and the invariant still holds. (Task 1)
3. A Codex session: spawn, main works, `wait_agent` on two agents, follow-up to one of them later: wait goes to the agent ending last during `wait_agent`, nothing during the main thread's own work; the reused agent's own time excludes the idle time between its segments. (Task 1)
4. A session that is still running: bars and numbers grow with the clock, stop when the session goes idle, and a snapshot never grows. (Tasks 1, 2)
5. A 100,000-node session: the computation stays linear; if a run exceeds 50 ms it moves off the main thread in the live page (not in the viewer). (Tasks 1, 2)

---

### Task 1: The computation

**Files:**
- Create: `packages/web/src/canvas/agentTime.ts`
- Test: `packages/web/test/agentTime.test.ts`, `packages/web/test/agentTime.timing.test.ts`

**Interfaces:**
- Consumes: `Graph`, `GraphNode`, `Session`, `usageTotal` from `@agent-canvas/shared`; `WaterfallClock`, and the step-interval rule of `buildWaterfall` from `canvas/waterfall.ts` (extract the per-node interval computation into an exported helper there if it is not one already, without changing the waterfall's behaviour).
- Produces:
  ```ts
  export interface ThreadTime {
    id: string;                     // 'main' or the agent id; 'unmatched:<dispatchNodeId>' for a dispatch without childAgentId
    parentId: string | null;        // null for main and for orphan threads
    label: string;                  // the dispatch node's title (or the agent's), '#n' added to equal names in order of appearance
    dispatchIds: string[];          // dispatch node ids, in order
    segments: { startMs: number; endMs: number }[];   // own-time segments (spec 3.3)
    waitingSpans: { startMs: number; endMs: number }[]; // where this thread was waiting on its own children (drawn light)
    ownMs: number;                  // sum of segments; for main: its own attributed time
    waitMs: number;                 // time attributed to this thread (main: 0; see mainWaitMs)
    open: boolean;                  // still running by the clock
    steps: number;
    usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
    children: ThreadTime[];
  }
  export interface AgentTimeline {
    available: true;
    totalMs: number; turns: number;
    mainOwnMs: number; mainWaitMs: number;
    root: ThreadTime;               // main, with children; orphans appended as children of a virtual top level (spec 3.6)
    orphans: ThreadTime[];
    axis: { startMs: number; endMs: number; breaks: { startMs: number; endMs: number }[] }; // breaks: compressed gaps (spec 4)
    longestWaitId: string | null;
  }
  export type AgentTimelineResult = AgentTimeline | { available: false; reason: 'no-times' };
  export function computeAgentTimeline(graph: Graph, session: Pick<Session, 'origin' | 'status' | 'lastActivityAt'>, clock: WaterfallClock): AgentTimelineResult;
  export function sortThreads(t: ThreadTime, by: 'wait' | 'start'): ThreadTime; // siblings only, recursive; ties by id
  ```
  Algorithm: one pass to group nodes by thread and order them by start; blocking intervals per the Background detection rule and spec 3.1; turn intervals and their union; a sweep over the sorted start/end events of blocking intervals and busy main steps that assigns each elementary interval of the total to one thread (deepest blocker, latest end, smaller id on ties); own-time segments per dispatch. Linear after one sort. Gap compression: a gap between turns longer than 5 minutes with no thread active becomes a break. Cycles and duplicate parents guarded as `buildView` does. `origin === 'doubao'` → `{ available: false, reason: 'no-times' }`.

- [ ] **Step 1: Failing tests (`agentTime.test.ts`).** Every row of the tests table in spec section 6 except the view rows, plus Review Focus 1-4, each with a hand-stated expected result. A property test over random sessions (fixed seeds; several turns, parallel, nested, background, Codex wait, reused agents, open steps, missing end times, missing `childAgentId`, orphans): the invariant to the millisecond, every own time ≥ its attributed wait for agents whose segments cover it, totals unchanged by sorting.
- [ ] **Step 2: Failing timing test (`agentTime.timing.test.ts`).** 100,000 nodes, 200 agents, 40 turns: `computeAgentTimeline` within a stated bound; print the measured time.
- [ ] **Step 3: Run; expect failure.**
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run; expect pass; web tests and typecheck.** Report the measured time for 100,000 nodes and whether Task 2 must move the computation off the main thread.
- [ ] **Step 6: Commit:** `feat(timeline): attribute a session's time to its subagents`.

### Task 2: The view

**Files:**
- Create: `packages/web/src/canvas/AgentTimeline.tsx` (the name `Timeline.tsx` is the replay scrubber's), its styles in `canvas/canvas.css`
- Modify: `packages/web/src/pages/SessionCanvas.tsx` (the switch entry "时间线" next to 概览 … 复盘, page state, the waterfall panel's scope while the timeline shows, deep links / file panel / anomaly panel picks), the viewer if it needs anything beyond the shared `SessionCanvas`, and — only if Task 1 measured more than 50 ms — a worker for the live page injected through `SessionSource` (the viewer computes in-thread)
- Test: `packages/web/test/agentTimeline.test.ts` (and the existing page tests extended where they enumerate views)

**Interfaces:**
- Consumes: Task 1.
- Produces: nothing for later tasks.

The view per spec section 4 and its sketch: header line (总用时, 轮数), sort toggle (等待时间 / 开始时间), one row per thread indented under its parent, bars on a shared axis with break marks, light parts where the thread waited on its children, segmented bars for reused agents, right columns 等待 / 各自用时 (main: 自己 … · 等 …), the longest wait marked, a tooltip (dispatching step, start, end, step count, tokens; dispatch count when more than one), "进行中" on open threads; the empty / no-subagent / Doubao messages. Clicking an agent row sets the waterfall panel to that agent (`{ type: 'agent', agentId }`); clicking a point on the main bar sets it to the turn at that time; while the timeline shows, a deep link `#/s/<id>/n/<node>`, a file-panel pick or an anomaly pick sets the panel to the node's agent or turn and opens the drawer on it. Recompute when the graph changes (throttled like the waterfall) and every second while the clock ticks; titles through the page's masking as the canvas does.

- [ ] **Step 1: Failing tests:** switch entry and state; row order for both sorts; indentation; columns and labels; longest mark; tooltip content; click → panel scope; deep link / file / anomaly picks while in the timeline; Doubao and no-subagent messages; the viewer shows the view with the snapshot clock.
- [ ] **Step 2: Run; expect failure.** **Step 3: Implement.** **Step 4: Run; expect pass; whole suite; `npx --yes pnpm@10 build`.**
- [ ] **Step 5: Look at it** in the built-in browser against a throwaway server on temp dirs (temp HOME/USERPROFILE, every `AGENT_CANVAS_*` tool variable temp or empty, throwaway port — never 4317) with invented sessions: a Claude session with parallel, nested and background agents; a Codex session with `wait_agent`; a running session; a Doubao session; widths 375 and 1280. Describe what you saw.
- [ ] **Step 6: Commit:** `feat(timeline): the 时间线 view`.

### Task 3: Docs

**Files:**
- Modify: `docs/manual.md` ("画布" section: a "时间线" subsection), the spec's status line and its misplaced heading "### 3.6" (move under section 3)

- [ ] **Step 1:** Manual: what the two numbers mean in plain words; the total counts only time inside turns, overlap once; background agents and Codex waits (how the page tells who was waited for, including the "carried on" rule and its limit: a parent that starts a step while still really waiting would stop counting as waiting); reused agents' segments; breaks on the axis; Doubao; the outline card's 历时 runs to the last step's start, the timeline to its end. No claim of real-data verification.
- [ ] **Step 2: Full verification:** `npx --yes pnpm@10 typecheck && npx --yes pnpm@10 build && npx --yes pnpm@10 test && npx --yes pnpm@10 release`.
- [ ] **Step 3: Commit:** `docs(timeline): manual section`.

---

## After the tasks (controller, with the user)

- Whole-branch review. Existing views and the waterfall panel unchanged (their tests pass unmodified; the reviewer checks the shared helper extraction).
- Push, PR, merge only when the user asks.
