# Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Desktop notifications when an agent session needs the user: awaiting permission, a turn finished, a turn ended in error, or the session has been stuck.

**Architecture:** A pure `NotificationEngine` subscribes to the pipeline's change stream and decides what to notify; a `Notifier` delivers through the operating system's own notification mechanism (no new dependency); settings live in the `meta` table and are edited from a panel in the web app.

**Tech Stack:** unchanged — TypeScript, pnpm workspace (`npx --yes pnpm@10 <cmd>`), Fastify, better-sqlite3, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-12-notifications-design.md` (binding).

## Global Constraints

- Behaviour of collection, storage and the existing pages must not change; every existing test keeps passing unmodified.
- TDD for logic: failing test first. Vitest, node environment, no jsdom, no component tests.
- Tests never show a real system notification and never run a real system command for it: the command runner is injected. Tests use temp dirs only (`AGENT_CANVAS_PROJECTS_DIR`, `AGENT_CANVAS_DATA_DIR`, `AGENT_CANVAS_CODEX_DIR`, `AGENT_CANVAS_CURSOR_DB`); never read or write files under the user's real home directory.
- No new runtime dependency.
- Notification text and URLs are passed to the system as data, never interpolated into a shell or script string that is then executed.
- User-facing text is Simplified Chinese, in the tone of the existing pages.
- Commits: English Conventional Commits ending with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. Do not push.
- Before each commit: `npx --yes pnpm@10 test`, `npx --yes pnpm@10 typecheck`, `npx --yes pnpm@10 build` all pass — check the actual pass/fail lines, not just that the command returned.
- Names fixed: `NotificationEngine` in `packages/server/src/notify/engine.ts`; `Notifier` interface and the desktop implementation in `packages/server/src/notify/desktop.ts`; settings type `NotificationSettings` and defaults in `packages/shared` (shared with the web); meta key `notifications`; routes `GET|PUT /api/notifications/settings`, `POST /api/notifications/test`.

## Review Focus

1. A session title or project name containing quotes, newlines, `$`, backticks, `;`, `&`, angle brackets or PowerShell/AppleScript syntax: shown literally, never executed, on all three platforms.
2. Start-up import, automatic rebuild, a poll source's first round, and old sessions discovered later: no notification.
3. Status flapping (running ↔ idle several times in a few seconds): at most one notification of a kind per 30 s for a session; an error turn never also produces a "finished" notification.
4. The system notification mechanism missing, hanging, or failing: the service keeps working, deliveries are bounded (timeout, concurrency, queue), the reason is visible in settings and diagnostics.
5. Corrupt or out-of-range stored settings, and invalid `PUT` bodies: defaults (off) / HTTP 400, never a crash.

---

### Task 1: Engine, settings, delivery, API

**Files:** `packages/shared/src/{api.ts,notifications.ts (new),index.ts}`; `packages/server/src/notify/{engine.ts,desktop.ts,settings.ts,service.ts}` (new); `packages/server/src/{api/server.ts,cli-commands.ts}`; tests next to each.

**Produces:**
- `NotificationSettings` (`enabled`, `permission`, `finished`, `finishedMinSeconds`, `error`, `stuck`, `stuckMinutes`) with the defaults of spec section 2, a validator, and `NotificationStatus` (available, lastError/lastErrorAt, lastSentAt/lastSentKind) in `packages/shared`.
- `NotificationEngine` (spec 3, 4, 5.1): pure; inputs are changes, an injected clock, settings, an "importing" probe and a "session" lookup; output is notifications `{ kind, sessionId, title, body, url }`. Stuck checks driven by an injectable timer. The exact error markers used per origin are listed in the report and added to spec section 3.
- `Notifier` and the desktop implementation (spec 5.2) with an injected process runner; per-platform command construction as pure functions.
- Settings store on the `meta` table (spec 5.3), the three routes, and wiring in `start` (engine subscribed after the server is built; stopped on close). `Diagnostics` gains a `notifications` block.

### Task 2: Web — settings panel and diagnostics

**Files:** `packages/web/src/{App.tsx,pages/Notifications.tsx (new) or a panel component,pages/Diagnostics.tsx,client.ts,styles.css}`, pure helpers with tests.

**Produces:** spec 5.4 — the 通知 entry next to 诊断, the settings panel (switches, thresholds, test button, delivery status, the per-origin notes of spec 3.2), and the diagnostics line.
