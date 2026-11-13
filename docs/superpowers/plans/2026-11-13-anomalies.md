# Anomaly Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Flag four kinds of in-session anomalies (loop, failure streak, file churn, unusual cost), show them on the home page, the session page and a new anomalies page, and notify on live loops and failure streaks.

**Architecture:** Tool nodes gain an input fingerprint (`inputKey`) from the three normalizers. Pure detection functions in the shared package turn a session's nodes into anomalies and per-turn costs. A cached server service (the stats service's approach) feeds three routes and two new notification kinds. The web renders markers, a session panel and a list page, jumping to nodes through the existing node address.

**Tech Stack:** unchanged — TypeScript, pnpm workspace (`npx --yes pnpm@10 <cmd>`), Fastify, better-sqlite3, React, Vitest. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-13-anomalies-design.md` (binding).

## Global Constraints

- Existing behaviour and tests stay unchanged except: tool/subagent nodes gain `inputKey`, the normalizer version pin, `NotificationKind` gains two members.
- Detection is a pure function of the current node set: rebuild equals live; node input order does not matter.
- Anomaly records and the new routes carry kinds, counts, numbers, times, ids and file paths only — never conversation text, tool input or output. `inputKey` is a hash only.
- Thresholds are named constants in `packages/shared/src/anomalies.ts` with the spec's values: `LOOP_FAILED_MIN = 3`, `LOOP_REPEAT_MIN = 5`, `FAILURE_STREAK_MIN = 5`, `CHURN_MIN = 15`, `COST_FACTOR = 2`, `COST_MIN_TURNS = 20`, `COST_MIN_ACTIVE_MS = 600_000`, `COST_MIN_TOKENS = 200_000`.
- TDD for logic: failing test first. Vitest, node environment, no jsdom, no component tests.
- Tests use temp dirs only (`AGENT_CANVAS_PROJECTS_DIR`, `AGENT_CANVAS_DATA_DIR`, `AGENT_CANVAS_CODEX_DIR`, `AGENT_CANVAS_CURSOR_DB`); never read or write under the user's real home directory; the real service on port 4317 is not touched and its port not used. The real database is never opened by an implementer.
- Fixtures are synthetic.
- No test or manual run sends a real desktop notification (use the existing injectable sender).
- User-facing text is Simplified Chinese, in the tone of the existing pages; kind names: 原地打转, 失败扎堆, 反复改同一个文件, 消耗异常高.
- Commits: English Conventional Commits ending with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. Do not push.
- Before each commit: `npx --yes pnpm@10 test`, `npx --yes pnpm@10 typecheck`, `npx --yes pnpm@10 build` all pass — read the actual pass/fail lines.
- Names fixed: `GraphNode.inputKey?: string` (16 hex chars); shared module `packages/shared/src/anomalies.ts` exporting `AnomalyKind = 'loop' | 'failures' | 'churn' | 'cost'`, `Anomaly`, `TurnCost`, `detectAnomalies(nodes: Iterable<GraphNode>): Anomaly[]`, `turnCosts(nodes: Iterable<GraphNode>, sessionRunning: boolean): TurnCost[]`, `costAnomalies(...)`, `ANOMALY_LABELS`; fingerprint helper `packages/server/src/normalize/input-key.ts` (`inputKeyOf(toolName, input): string | undefined`); server module `packages/server/src/anomalies/`; routes `GET /api/sessions/:id/anomalies`, `GET /api/anomalies`, `GET /api/anomalies/counts`; response types `SessionAnomaliesResponse`, `AnomalyListResponse`, `AnomalyCountsResponse` in the shared module; web `packages/web/src/pages/Anomalies.tsx`, `packages/web/src/canvas/AnomalyPanel.tsx`, pure helpers `packages/web/src/anomalies.ts`; hash route `#/anomalies`.

## Review Focus

1. Identity of "the same call": the same input with keys in another order, nested objects, numbers vs strings, missing input, very large input (hash cost on the ingest path), a node whose input arrives or changes after the node was created (Cursor bubbles, hook-only nodes later confirmed): the key follows the final input and rebuild equals live.
2. Counting on a changing node set: a running node that later fails, a failure later corrected to success, a denied call inside a streak, parallel calls finishing out of start order, nodes with equal timestamps, a turn with no prompt (subagent thread), a session with thousands of nodes in one turn (Cursor): no double report, one anomaly per kind per turn, deterministic result.
3. Cost baseline: fewer than 20 turns, all-zero tokens (Cursor), a group dominated by one huge session, unfinished last turn, sessions filtered out by the request (the baseline must not depend on the request's filters).
4. Notifications: importing history at start-up, a service restart in the middle of a loop, a rebuild, the same anomaly growing (count 3 → 4 → 5): one notification per session, turn and kind; none for old data.
5. Large data (about 217,000 nodes, 5,800 turns, one session with 100,000+ nodes): warm-up does not block the event loop for long; a changed session recomputes only itself; list bounded at 200.

---

### Task 1: Input fingerprint and detection rules

**Files:** `packages/shared/src/{model.ts,anomalies.ts (new),index.ts}`; `packages/server/src/normalize/{input-key.ts (new),normalizer.ts,codex.ts,cursor*.ts,version.ts}`; tests in `packages/shared/test/` and `packages/server/test/`.

**Produces:** spec section 3 — `inputKey` on tool and subagent nodes from the three normalizers (canonical JSON of the full input, hashed, 16 hex chars; version bumped); the detection turn grouping; `detectAnomalies` for `loop`, `failures`, `churn`; `turnCosts` and `costAnomalies` for `cost`; the `Anomaly` / `TurnCost` types, threshold constants and `ANOMALY_LABELS` that Tasks 2 and 3 use.

### Task 2: Cached service, routes, notifications

**Files:** `packages/server/src/anomalies/*` (new); `packages/server/src/api/server.ts`; `packages/server/src/notify/{engine.ts,settings.ts,service.ts}`; `packages/shared/src/{anomalies.ts,notifications.ts}`; tests in `packages/server/test/`.

**Consumes:** Task 1's functions and types.

**Produces:** spec sections 4, 5, 7 — the per-session cache (reuse `SessionSummaryCache`) with background warm-up; the cost baseline computed at query time over all sessions; the three routes with validation and the response types; notification kinds `loop` and `failures` (default off, live sessions only, anomaly within the last 2 minutes, once per session + turn + kind, nothing on restart or import), with a click target of the node address.

### Task 3: Web — markers, session panel, anomalies page

**Files:** `packages/web/src/{route.ts,App.tsx,client.ts,anomalies.ts (new),pages/Anomalies.tsx (new),pages/Home.tsx,pages/Session.tsx,pages/Notifications.tsx,canvas/AnomalyPanel.tsx (new),styles.css,canvas/canvas.css}` and the overview turn card component; tests in `packages/web/test/`.

**Consumes:** Task 2's routes and response types; `sessionNodeHash`.

**Produces:** spec section 6 — the home card marker with counts; the session toolbar button and panel, turn-card markers (subagent anomalies on the dispatching turn and the subagent card), jump to the node; the `#/anomalies` page with filters and per-kind totals; the two new switches on the notifications page; loading, empty, error and "still computing" states.
