# Today's Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "今天" number in every page's header (new input + output tokens today), a "今天" block at the top of the stats page, and a self-set line that sends one desktop notification when today's usage grows past it.

**Architecture:** A pure function on the server turns the stats page's session summaries into today's usage (same code paths as `aggregateStats`, so the numbers agree). A `TodayService` recomputes it from the shared `SessionSummaryCache` at most every 30 s while sessions change, keeps the "over the line" state in `meta`, pushes the result over the app's sessions-scope WebSocket and reports a crossing to the notification service. The web app shows it in the header and on the stats page; the line lives in the notification settings.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, React + Vite, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-24-today-usage-design.md` (binding).

## Global Constraints

- Numbers are the stats page's (spec 3): a turn counts on the local day it **started** (`localDayKey(turn.startMs)`), an extra (`SummaryExtra`, e.g. Copilot's `session.shutdown`) on its own day, undated ones nowhere, `activeMs` via `turnDurationMs(t, nowMs)`, tokens = the summary's `inputTokens` / `cachedInputTokens` / `outputTokens`.
- Main number = `input + output` (new input + output). Cache reads never count in it, nor in the line.
- "No token data" for an origin = the stats page's rule over **all** entries (`summary.usageNodes > 0` in some session of that origin). Ruling (planning): the spec's section 6 "only sessions active in the last 8 days are read" is dropped — the shared cache already holds every summary and only changed ones are re-read; reading all keeps "—" vs 0 identical to the stats page (spec 1.3 anti-goal). Spec section 6 is updated in Task 4.
- Recompute at most once per `TODAY_THROTTLE_MS = 30_000` while changes arrive; also every 30 s while today has an open turn (from the cache, nothing re-read); once at local midnight; at once on a line change. Never on a timer when nothing changed and nothing is open.
- Notification only for a crossing caused by usage growth (spec 5): same local day, same line, previous computation under the line, this one at or over it, start-up work done (`pipeline.startupDone()`), not importing, master switch and the `usage` switch on. Line set / lowered onto an exceeded value, switches turned on later, start-up / import / rebuild: colour only, never a later catch-up. Over-state `{ day, line, over }` in meta key `todayUsage`.
- Settings: `usageLineTokens` (integer, `0..100_000_000_000`, 0 = no line) and `usage` (boolean, notify switch, default `true`) in `NotificationSettings`; old pages that omit them keep the current values (as `putSettings` does for `loop` / `failures`). The line works with every switch off (header colour, stats block); the settings page never disables the line input.
- The stats API (`/api/stats`) and its numbers do not change. No `NORMALIZER_VERSION` change, no new tables, no new indexes.
- Tests: invented data only, temp dirs, never port 4317, never the real `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.cursor/hooks.json`, no real desktop notification (fake notifier). Root commands: `npx --yes pnpm@10 typecheck`, `npx --yes pnpm@10 test`, `npx --yes pnpm@10 build`; one file `npx --yes pnpm@10 exec vitest run <path>`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push; do not open a PR.

## Review Focus

1. A turn that started yesterday 23:50 and runs past midnight: counts for yesterday only, today's number does not include it, and midnight resets the over-state. (Task 1, Task 2)
2. A running 100,000-node session producing changes every second: the summary is re-read at most once per 30 s, ingest is not slowed (one recompute's event-loop time stated). (Task 2)
3. Service restart on a day already over the line: no notification at start, none later that day for the same line; the header is coloured at once. (Task 2)
4. An old settings page (no `usage` / `usageLineTokens` in its PUT) does not reset the line. (Task 2)
5. Origins without tokens only (a Cursor-only day): main number "—", no notification, block says why; Copilot before exit: 0 with the "退出时才记总数" note. (Tasks 1, 3)

---

### Task 1: Today's usage, computed

**Files:**
- Create: `packages/shared/src/today.ts` (exported from the shared index), `packages/server/src/stats/today.ts`
- Test: `packages/server/test/today.test.ts`

**Interfaces:**
- Consumes: `SessionSummary`, `turnDurationMs` (`stats/summary.ts`), `localDayKey`, `addDays` (`stats/aggregate.ts`), `StatsTokens`, `ORIGINS`.
- Produces:
  ```ts
  // shared/src/today.ts
  export interface TodayOrigin {
    origin: Origin;
    turns: number; activeMs: number;
    tokens: StatsTokens | null;        // null: the origin has no token data (stats rule, all entries)
  }
  export interface TodayUsage {
    day: string;                        // YYYY-MM-DD, local
    asOf: string;                       // ISO time of the computation (the block's "截至")
    turns: number; activeMs: number;
    tokens: StatsTokens | null;         // null only when today has origins and none of them has token data
    main: number | null;                // tokens.input + tokens.output; null when tokens is null
    byOrigin: TodayOrigin[];            // origins with a turn or an extra today, ORIGINS order
    usualMain: number | null;           // spec 3.3; null when no session of the 7 days belongs to an origin with token data
    lineTokens: number | null;          // filled by TodayService (null: no line)
    over: boolean;                      // filled by TodayService: main !== null && line !== null && main >= line
  }
  // server/src/stats/today.ts
  export function computeToday(
    entries: readonly { session: Session; summary: SessionSummary }[],
    nowMs: number, dayKey?: (ms: number) => string,
  ): Omit<TodayUsage, 'lineTokens' | 'over'>;
  ```
  Nothing ran today: `turns 0`, `byOrigin []`, `tokens` all zeros and `main 0` (the block says "今天还没有用过"). `tokens` / `main` are null only when today has origins and none of them has token data. Totals sum the origins with token data.
  `usualMain`: for each of the 7 local days before today, sum `input + output` of turns that started that day at a time of day (local, to the minute) earlier than now's, plus extras dated likewise; average over 7 (empty days 0).

- [ ] **Step 1: Failing tests (`today.test.ts`).** Build summaries through `summarizeSession` from invented nodes (as `stats` tests do).
  - `agrees with the stats page`: random sessions over 10 days (several origins incl. one without usage, open turns, extras, undated turns) → for every field, `computeToday(...)` equals `aggregateStats({ range: '7d', origin: null, projectId: null, ... })`'s `byDay` entry for today (`turns`, `activeMs`, `tokens`, and each `byOrigin` entry; an origin in `coverage.noTokenData` ↔ `tokens: null`).
  - `a turn that started yesterday 23:50 counts for yesterday`: today has 0 turns and main 0.
  - `an extra counts on its own day` (Copilot shutdown at 09:00 today of a session started yesterday).
  - `Cursor-only day`: main null, byOrigin Cursor with tokens null.
  - `Copilot before exit`: an origin that had usage in an older session → tokens zeros, not null.
  - `usualMain to the minute`: now 10:45; past days with turns at 10:44 (counted) and 10:46 (not); a day without turns counts 0; expected value stated by hand.
  - `usualMain null` when the 7 days have only Cursor sessions.
- [ ] **Step 2: Run; expect failure.**
- [ ] **Step 3: Implement.** Reuse the stats helpers; no copy of `turnDurationMs` or the token rule.
- [ ] **Step 4: Run; expect pass; typecheck.**
- [ ] **Step 5: Commit:** `feat(today): today's usage from the stats summaries`.

### Task 2: Service, settings, notification, API and push

**Files:**
- Create: `packages/server/src/stats/today-service.ts`
- Modify: `packages/shared/src/notifications.ts` (fields `usage`, `usageLineTokens`, kind `'usage'`, limits), `packages/server/src/notify/service.ts` (`putSettings` keeps missing new fields; `notifyUsage`), `packages/server/src/api/server.ts` (route `GET /api/today`, WS message, wiring, settings PUT → `today.settingsChanged()`), `packages/server/src/cli-commands.ts` (pass the notification hook and `startupDone`), `packages/shared/src/api.ts` (WS message `{ type: 'today'; usage: TodayUsage }`)
- Test: `packages/server/test/today-service.test.ts`, extend the notification settings tests and the server/API tests

**Interfaces:**
- Consumes: Task 1 (`computeToday`, `TodayUsage`); `StatsService.summaryCache()`; `loadNotificationSettings`.
- Produces:
  ```ts
  export const TODAY_THROTTLE_MS = 30_000;
  export const TODAY_META_KEY = 'todayUsage';
  export interface TodayServiceDeps {
    cache: Pick<SessionSummaryCache<SessionSummary>, 'snapshot'>;
    store: Pick<Store, 'getMeta' | 'setMeta'>;
    line: () => number | null;            // usageLineTokens, 0 -> null
    ready: () => boolean;                 // startupDone() && !importing()
    onCross?: (usage: TodayUsage) => void; // the notification service decides switches
    now?: () => number; dayKey?: (ms: number) => string; timers?: Timers;
  }
  export class TodayService {
    get(): Promise<TodayUsage>;           // the latest; computes when none yet or dirty and due
    noteChanges(changes: readonly SeqChange[]): void;
    settingsChanged(): void;              // recompute now (from the cache), never notifies for this
    onUpdate(listener: (u: TodayUsage) => void): () => void;
    close(): void;
  }
  // NotificationService
  notifyUsage(usage: TodayUsage): void;   // sends iff enabled && usage switch; text below
  ```
  Notification: title `今天的用量超过了你设的线`, body `新输入 + 输出 ${fmt(main)}，提醒线 ${fmt(line)}` (fmt: the web's token short form, e.g. `1.2M` — move `formatTokens` from `packages/web/src/canvas/replay.ts` into `shared` and re-export it from `replay.ts`, so web callers and their tests are unchanged), url `${baseUrl}/#/stats`. No session content.
  Over-state rule (meta `todayUsage` JSON `{ day, line, over }`): after each computation, if the stored day or line differs from now's (or nothing stored, or this is the first computation since start) → store `over = current` with no notification; else if `!stored.over && current` and `ready()` → `onCross`; store `over = current` either way (so a crossing while not ready is consumed, never sent later). `settingsChanged` runs the same path (a line change differs → baseline, no notification).
  Pushes go to sessions-scope connections whenever the result changes (ignoring `asOf`).

- [ ] **Step 1: Failing tests (`today-service.test.ts`, fake timers and clock, a fake cache returning invented summaries):**
  - throttle: 100 change batches in 10 s → one recompute at +30 s; no change and no open turn → no recompute in 5 min; an open turn → one every 30 s with no re-read (`snapshot` returns cached entries; count source reads).
  - midnight: a computation runs at the next local 00:00 and `day` changes; over-state resets.
  - crossing: under → over with ready → `onCross` once; stays over → none; another crossing same day and line → none.
  - line raised above current → later growth past it → `onCross` once; line lowered onto an exceeded value → none, `over: true` pushed.
  - not ready (start-up / import) when crossing → none then, none after ready.
  - restart: meta says `{ today, line, over: true }` → no `onCross`; meta from yesterday → baseline, no `onCross`.
  - `notifyUsage`: master off or `usage` off → nothing delivered (fake notifier); both on → one message with the stated title / body / url.
  - settings: validation of the two fields (types, range, 0 allowed); a PUT without them keeps the stored values; defaults `usage: true`, `usageLineTokens: 0`.
  - API: `GET /api/today` returns `TodayUsage` with `lineTokens` / `over`; a sessions-scope WebSocket gets `{ type: 'today' }` after a change (within the throttle, fake timers) and after a settings PUT.
  - Review Focus 2: a 100,000-node running session in a temp store, changes every second for 60 s (fake clock) → its summary read at most 3 times; report one recompute's wall time.
- [ ] **Step 2: Run; expect failure.**
- [ ] **Step 3: Implement.** Wire in `buildServer` like the attention service (fed by `pipeline.onChanges`, closed on `onClose`); the line from `notifications?.getSettings().settings` when present, else `loadNotificationSettings(store)`; `ready` from `pipeline.startupDone?.() ?? true` and `!pipeline.importing()`; `onCross` → `notifications?.notifyUsage`. The first computation happens on the first `get()` or change (not at construction; it would delay listening).
- [ ] **Step 4: Run; expect pass; whole server suite; typecheck.**
- [ ] **Step 5: Commit:** `feat(today): service, line setting, notification and push`.

### Task 3: The page

**Files:**
- Create: `packages/web/src/today.ts` (pure helpers: header text and label, block rows, percent of line, notes)
- Modify: `packages/web/src/client.ts` (`api.today()`, a live watcher on the shared sessions feed like the attention one: fetch on open, then pushes), `packages/web/src/App.tsx` (header item after 待处理), `packages/web/src/pages/Stats.tsx` (the 今天 block above the range switch, independent of the filters), `packages/web/src/pages/Notifications.tsx` (the line and the switch), `packages/web/src/styles.css`
- Test: `packages/web/test/today.test.ts` and the existing App / Stats / Notifications page tests extended

**Interfaces:**
- Consumes: Task 2's `GET /api/today`, WS `{ type: 'today' }`, settings fields.
- Produces: nothing for later tasks.

Per spec section 4 and its sketches:
- Header: `今天 1.2M` (main via `formatTokenCount`; `今天` alone before the first result; `今天 —` when main is null); over → a warning class; aria-label `今天，新输入加输出 1,234,567 token` plus `，已超过你设的 N` when over; link `#/stats`.
- Stats block (above the range buttons, not affected by them): title `今天（截至 HH:MM，数字最多晚 30 秒）`; rows 新输入 + 输出 / 过去 7 天同一时刻平均 (hidden when `usualMain` null) / 缓存读取 / `轮数 N · 工作时长 …` (`formatSpan`) / 提醒线 (`没有设提醒线`, `提醒线：2M（已用 60%）`, `已超过提醒线 2M`) with a 修改 link to `#/notifications`; the per-origin table (columns 来源 / 新输入+输出 / 缓存读取 / 轮数 / 工作时长; `—` for tokens null); notes: origins without token data `Cursor、豆包没有 token 数据，不在这个数里`; Copilot present → `Copilot CLI 只在会话退出时记总数`; nothing today → `今天还没有用过`.
- Settings: in the list of kinds, `今天的新输入 + 输出超过提醒线时提醒我` (switch, disabled with the master like the others) and the line input in 万 token (integer 1..10,000,000, empty = no line; saved as `× 10_000` tokens), never disabled; a sentence that the line also colours the header without notifications.
- Masking: nothing to mask (no conversation text).

- [ ] **Step 1: Failing tests:** helper outputs for each header state and label; block rows for: normal, over, no line, Cursor-only, nothing today, Copilot note, `usualMain` null; Stats page renders the block with filters changed (block unchanged); settings page: line input enabled with the master off, 万 conversion both ways, empty → 0, invalid input message; the live watcher updates on a push and refetches on reconnect.
- [ ] **Step 2: Run; expect failure.** **Step 3: Implement.** **Step 4: Run; expect pass; whole suite; `npx --yes pnpm@10 build`.**
- [ ] **Step 5: Look at it** in the built-in browser against a throwaway server on temp dirs (temp HOME / USERPROFILE, every `AGENT_CANVAS_*` tool variable temp or empty, throwaway port — never 4317, notifications master off or a fake notifier — no real desktop notification) with invented sessions: a normal day, over the line, Cursor-only, nothing today; widths 375 and 1280. Describe what you saw.
- [ ] **Step 6: Commit:** `feat(today): header number, stats block and line setting`.

### Task 4: Docs

**Files:**
- Modify: `docs/manual.md` (a section on 今天的用量, near 统计 and 通知), the spec (status line; section 6 per the Global Constraints ruling)

- [ ] **Step 1:** Manual (spec section 8): what the header number is; why cache reads are left out; a turn counts on the day it started; up to 30 s late; how to set the line and that it works without notifications; when it notifies and when it does not (once per day and line; not at start-up, import, rebuild; not for a line set onto an exceeded value; no catch-up after switching on); origins without tokens; Copilot at exit. Plain Chinese, no claim of real-data verification.
- [ ] **Step 2: Full verification:** `npx --yes pnpm@10 typecheck && npx --yes pnpm@10 build && npx --yes pnpm@10 test && npx --yes pnpm@10 release`.
- [ ] **Step 3: Commit:** `docs(today): manual section`.

---

## After the tasks (controller, with the user)

- Whole-branch review; `/api/stats` and the stats page's numbers unchanged (their tests pass unmodified).
- Push, PR, merge only when the user asks.
