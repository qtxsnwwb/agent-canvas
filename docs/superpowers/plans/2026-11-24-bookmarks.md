# Bookmarks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bookmark a whole session or one step (with an optional one-line note) from the session page, and find them again on a 书签 page.

**Architecture:** A new `bookmark` table outside the derived tables (so rebuilds keep it). The server builds each bookmark's snapshot from the store when it is created and, when listing, adds what it finds now (session and step present or not). A small REST API with same-origin writes, soft delete for undo, and a push over the app's sessions-scope WebSocket. The web app gets a 书签 page, a header link, toolbar and drawer buttons, and star markers rolled up to the visible card.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, React + Vite, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-24-bookmarks-design.md` (binding).

## Global Constraints

- Table `bookmark` is created with `CREATE TABLE IF NOT EXISTS` in `SCHEMA_SQL`; it is **not** in `DERIVED_TABLES`; `rebuild`, the automatic rebuild on start and `compact` keep its rows. An older build opening the database is unaffected. No `NORMALIZER_VERSION` change.
- Target: `(session_id, node_id)` unique; a session bookmark stores `node_id = ''` in the table and is `nodeId: null` in the API.
- Note: trimmed, every run of whitespace containing a line break folded to one space, at most `BOOKMARK_NOTE_MAX = 200` characters counted as code points (`[...s].length`); longer → 400 with a Chinese message. Empty note allowed.
- Snapshot is built **by the server** from the store at creation (never taken from the request): session title (the same title rule the home page uses), origin, project id, cwd; for a step also node kind, tool name, a one-line label (`permissionText(toolName, title, summary)` from `attention/explain.ts` for tool / subagent nodes; for other kinds the node's summary or title), folded to one line and, when longer than 80 code points, cut to 79 plus `…` for every kind (the ellipsis is what lets the page masker see a cut — final review C1), the node's timestamp. Written once.
- Delete is soft: `deleted_at` set; lists exclude deleted rows; `restore` clears it; rows deleted more than `BOOKMARK_PURGE_AFTER_MS = 24 * 60 * 60_000` ago are purged on the next write. Creating a bookmark on a target whose row is soft-deleted purges that row first.
- All write routes use the existing `sameOriginJson` guard (as the export routes do).
- Push: after every write, `{ type: 'bookmarks'; sessionIds: string[] }` (the sessions whose bookmarks changed) to sessions-scope connections; clients refetch.
- Masking on the page: session title, step label, cwd and project name go through the page masker; **the note is never masked**; the 书签 page filter matches the **displayed** (masked when on) text, plus the note.
- The exported HTML viewer shows no bookmark button, no star, no 书签 link (`SessionSource.bookmarks` is null there).
- Tests: invented data only, temp dirs, never port 4317, never the real `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.cursor/hooks.json`. Root commands: `npx --yes pnpm@10 typecheck`, `npx --yes pnpm@10 test`, `npx --yes pnpm@10 build`; one file `npx --yes pnpm@10 exec vitest run <path>`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push; do not open a PR.

## Review Focus

1. A full `rebuild` (and the start-time automatic rebuild after a normalizer bump): every bookmark is still listed and still opens its step. (Task 1)
2. A step whose node id no longer exists after a rebuild: listed with 「找不到这一步」 and its snapshot; clicking opens the session at the turn nearest the snapshot time with the notice. (Tasks 1, 2)
3. Masking on: typing a secret that appears only in a session title into the filter does not narrow the list to that row. (Task 2)
4. Delete then 撤销 within seconds restores the same bookmark (same note, same 标记时间); a cross-site POST / PATCH / DELETE is refused. (Tasks 1, 2)
5. A bookmarked step inside a collapsed subagent in the default 概览 view: the star shows on the turn card and on the subagent card. (Task 3)

---

### Task 1: Storage and API

**Files:**
- Create: `packages/shared/src/bookmarks.ts` (exported from the shared index), `packages/server/src/bookmarks/service.ts`
- Modify: `packages/server/src/store/schema.ts` (table), `packages/server/src/store/store.ts` (statements and methods), `packages/server/src/api/server.ts` (routes, push), `packages/shared/src/api.ts` (WS message)
- Test: `packages/server/test/bookmarks-store.test.ts`, `packages/server/test/api-bookmarks.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // shared/src/bookmarks.ts
  export const BOOKMARK_NOTE_MAX = 200;
  export interface BookmarkSnapshot {
    sessionTitle: string; origin: Origin; projectId: string; cwd: string | null;
    nodeKind: NodeKind | null; toolName: string | null; stepLabel: string | null; nodeAt: string | null;
  }
  export interface Bookmark {
    id: number; sessionId: string; nodeId: string | null; note: string;
    createdAt: string; noteUpdatedAt: string | null; snapshot: BookmarkSnapshot;
    /** Filled when listing: what exists now. */
    now: { session: boolean; node: boolean; sessionTitle: string | null; sourceDeleted: boolean; projectName: string | null };
  }
  export function normalizeBookmarkNote(raw: string): { ok: true; note: string } | { ok: false; error: string };
  // routes (server.ts)
  // GET    /api/bookmarks[?sessionId=]        -> { bookmarks: Bookmark[] }  (createdAt descending, then id descending)
  // POST   /api/bookmarks  { sessionId, nodeId: string | null, note? } -> 201 Bookmark | 409 { error, bookmark } | 404 (unknown session / node)
  // PATCH  /api/bookmarks/:id  { note }        -> Bookmark | 404 | 400
  // DELETE /api/bookmarks/:id                  -> { ok: true } (soft) | 404
  // POST   /api/bookmarks/:id/restore          -> Bookmark | 404 (unknown, purged, or its target re-bookmarked meanwhile)
  // WS: { type: 'bookmarks'; sessionIds: string[] }
  ```
  `now.node` is true for a session bookmark when the session exists. Listing resolves each row with indexed reads (session by id, node by primary key) — no graph loads.

- [ ] **Step 1: Failing tests.**
  - store: create / list order / patch note (sets `noteUpdatedAt`) / soft delete / restore / purge after 24 h (fake clock) / unique target (409 carries the existing one) / re-create on a soft-deleted target.
  - `rebuild keeps bookmarks`: create session + step bookmarks, run the store's clear-derived + re-ingest path used by `rebuild`, list → same rows, `now.node` true.
  - `a node gone after rebuild`: remove the node → `now.node` false, snapshot unchanged.
  - snapshot built from the store: tool step → `Bash · npm test` style label; a text step → its title / summary head; a request body carrying a `snapshot` field is ignored.
  - note rules: trim, line breaks folded, 200 code points OK (an emoji counts 1), 201 → 400.
  - API: each route's success and error statuses; a cross-site request (`sec-fetch-site: cross-site`, or a foreign `Origin`) to each write route → refused; a sessions-scope WebSocket receives `{ type: 'bookmarks', sessionIds }` after create / patch / delete / restore.
  - an older database (opened by the previous schema) gets the table on open; rows of other tables untouched.
- [ ] **Step 2: Run; expect failure.** **Step 3: Implement.** **Step 4: Run; expect pass; server suite; typecheck.**
- [ ] **Step 5: Commit:** `feat(bookmarks): table, snapshot and API`.

### Task 2: The 书签 page

**Files:**
- Create: `packages/web/src/bookmarks.ts` (pure helpers: row view model from `Bookmark` + masker, filter, labels), `packages/web/src/pages/Bookmarks.tsx`
- Modify: `packages/web/src/client.ts` (api calls; a live list on the shared sessions feed — refetch on a `bookmarks` push, built on the existing `openLivePushed` helper or the same pattern), `packages/web/src/route.ts` (`#/bookmarks`), `packages/web/src/App.tsx` (header link 书签 after 今天 … keep the header's two-row layout working at 375 px), `packages/web/src/styles.css`
- Test: `packages/web/test/bookmarks.test.ts`

**Interfaces:**
- Consumes: Task 1 routes and types.
- Produces: `api.bookmarks(sessionId?)`, `api.createBookmark(...)`, `api.patchBookmark(...)`, `api.deleteBookmark(id)`, `api.restoreBookmark(id)` and a live watcher, used by Task 3.

Per spec section 4 and its sketch: title `书签（N）`; rows newest first with kind (会话 / 步骤), note or `（没有备注）`, 标记时间 (local `MM-DD HH:mm`), step label for steps, then project · origin · “session title” (current title when the session exists, else the snapshot's); 「找不到这一步」 / 「找不到这个会话」 badges; click → `#/s/<id>` or `#/s/<id>/n/<node>`; a missing step → `#/s/<id>` plus the notice 「这一步已经不在了」 and the turn nearest `snapshot.nodeAt` selected (reuse the session page's existing way of opening at a turn if there is one; else open the session and show the notice); a missing session → no navigation, the notice 「这个会话已经不在了」. Filter box `筛选：备注、标题、步骤…`: literal, ASCII case-insensitive, over note + displayed title / label / project name. Inline note edit (Enter or blur saves; Escape cancels; validation message from the server's 400). Delete → row disappears, a 撤销 toast for 6 s calling restore. Empty state text: 「还没有书签。在会话页的工具栏收藏会话，在每一步的详情里收藏这一步。」

- [ ] **Step 1: Failing tests:** view models for session / step / missing step / missing session; masking on: title, label, cwd, project masked, note not; filter on displayed text (Review Focus 3) and on note; sort; edit / delete / undo flows against a fake api; empty state; the live list refetches on a push.
- [ ] **Step 2: Run; expect failure.** **Step 3: Implement.** **Step 4: Run; expect pass; web suite; typecheck.**
- [ ] **Step 5: Timing:** `packages/web/test/bookmarks.timing.test.ts` — 5,000 bookmarks: building the view models and filtering once within a stated bound (scaled by `AGENT_CANVAS_TIMING_SCALE`); print the time.
- [ ] **Step 6: Commit:** `feat(bookmarks): the 书签 page`.

### Task 3: Marking on the session page

**Files:**
- Modify: `packages/web/src/sessionSource.ts` (`bookmarks: SessionBookmarks | null` — null in the viewer), `packages/web/src/liveSource.ts` (provide it), `packages/web/src/pages/SessionCanvas.tsx` (toolbar button, drawer wiring, star markers), `packages/web/src/canvas/Drawer.tsx` (button + note input), `packages/web/src/canvas/nodes.tsx` (star marker), `packages/web/src/canvas/canvas.css`
- Create: `packages/web/src/canvas/bookmarkMarks.ts` (pure: which visible cards get a star)
- Test: `packages/web/test/bookmarkMarks.test.ts`, extend the session page / drawer tests

**Interfaces:**
- Consumes: Task 2's api calls and live watcher.
- Produces: nothing for later tasks.

Per spec section 5: toolbar 「收藏会话」 / 「已收藏」 toggle; drawer 「收藏这一步」 / 「已收藏」 toggle; after marking, a note input beside the button (Enter / blur saves); un-marking a bookmark with a note shows 「备注会一起删除」 with 撤销 (same restore path) — no confirm dialog. Stars: a step's own card when drawn; otherwise rolled up like `cardMarks` in `anomalies.ts` — its turn's card and every subagent card on its dispatch chain (`revealPlan` in `canvas/reveal.ts` gives turn and agents); folds / compact runs: the visible card that contains it, if the view exposes that mapping (state in the report how it was done or why not). No stars in 时间线 or the waterfall. All of it absent when `source.bookmarks` is null (viewer).

- [ ] **Step 1: Failing tests:** `bookmarkMarks` for a main-thread step, a step in a nested subagent (turn + both agent cards), a session bookmark (no card star), a step not in the graph; toolbar and drawer button states and toggling against a fake source; note save; un-mark with note → 撤销 restores; viewer source (bookmarks null) renders no button and no star (Review Focus 5 in the 概览 model).
- [ ] **Step 2: Run; expect failure.** **Step 3: Implement.** **Step 4: Run; expect pass; whole suite; `npx --yes pnpm@10 build`.**
- [ ] **Step 5: Look at it** in the built-in browser against a throwaway server on temp dirs (temp HOME / USERPROFILE / APPDATA / LOCALAPPDATA, every `AGENT_CANVAS_*` tool directory variable temp or empty, throwaway port — never 4317, notifications off) with invented sessions: mark a session and steps (one inside a subagent), write notes, see the stars in 概览 and 逐步, open the 书签 page, filter, delete + 撤销, run `rebuild` against the temp data and check the list; masking on and off; widths 375 and 1280. Describe what you saw; clean up.
- [ ] **Step 6: Commit:** `feat(bookmarks): mark sessions and steps on the session page`.

### Task 4: Docs

**Files:**
- Modify: `docs/manual.md` (a 「书签」 section near 待处理 / 首页与检索), the spec (status line)

- [ ] **Step 1:** Manual (spec section 8), every sentence checked against the code: how to mark a session and a step; the note (200 characters, not masked, why); the 书签 page (sort, filter on what is shown, edit, delete and 撤销); stars rolled up to the visible card; rebuild / upgrade keep bookmarks; 「找不到这一步」 / 「找不到这个会话」; source-deleted sessions open as usual; exports carry no bookmarks; bookmarks live in the database, so another browser sees them. No claim of real-data verification.
- [ ] **Step 2: Full verification:** `npx --yes pnpm@10 typecheck && npx --yes pnpm@10 build && npx --yes pnpm@10 test && npx --yes pnpm@10 release`.
- [ ] **Step 3: Commit:** `docs(bookmarks): manual section`.

---

## After the tasks (controller, with the user)

- Whole-branch review; existing pages unchanged except the header link (their tests pass unmodified).
- Push, PR, merge only when the user asks.
