# Full-Text Search and Database Slimming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Search inside sessions (replies, commands, tool output) with a jump to the matching step, and shrink the database without losing data.

**Architecture:** Raw event bodies and node details are stored compressed (Node's built-in zlib), with a resumable one-time migration and a `VACUUM`. A contentless FTS5 trigram index over one text per node is maintained in the same transaction as node writes. The search route gains content hits; the web shows them and jumps to the node through a new `#/s/<id>/n/<nodeId>` address.

**Tech Stack:** unchanged — TypeScript, pnpm workspace (`npx --yes pnpm@10 <cmd>`), Fastify, better-sqlite3 (SQLite 3.53 with FTS5 + trigram), React, Vitest. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-13-search-and-storage-design.md` (binding).

## Global Constraints

- No data loss: a rebuild after the change gives the same graph as before; raw records remain replayable byte for byte.
- Existing behaviour and tests stay unchanged except where the storage format or the search response legitimately changes.
- TDD for logic: failing test first. Vitest, node environment, no jsdom, no component tests.
- Tests use temp dirs only; never read or write under the user's real home directory; the real service on port 4317 is not touched and its port not used. The real database is never opened by an implementer.
- Fixtures are synthetic.
- No new runtime dependency.
- Search treats the query as literal text: nothing the user types is interpreted as FTS or LIKE syntax.
- User-facing text is Simplified Chinese, in the tone of the existing pages.
- Commits: English Conventional Commits ending with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. Do not push.
- Before each commit: `npx --yes pnpm@10 test`, `npx --yes pnpm@10 typecheck`, `npx --yes pnpm@10 build` all pass — read the actual pass/fail lines.
- Names fixed: codec in `packages/server/src/store/codec.ts` (`encodeBody(text): { data: Buffer | string; enc: 0 | 1 }`, `decodeBody(data, enc): string`); migration in `packages/server/src/store/migrate-storage.ts`; `Diagnostics.storage` block; CLI command `agent-canvas compact`; search index module `packages/server/src/store/search-index.ts`; shared types `ContentHit` and the extended search response in `packages/shared/src/api.ts`; web route `#/s/<sessionId>/n/<encoded nodeId>`.

## Review Focus

1. Interrupted migration: the process is killed between batches, during a batch, and during `VACUUM`; the next start continues and the database is intact; old-format and new-format rows coexist and both read correctly at every moment.
2. Query text with FTS5 / LIKE special characters (`"`, `*`, `(`, `)`, `:`, `-`, `^`, `%`, `_`, `\`, NUL), very long queries, and the 2-versus-3 character boundary incl. surrogate pairs and CJK: literal matching, no syntax error, no crash.
3. The index never disagrees with the nodes: node inserted, updated in place (many times, e.g. Cursor bubbles), deleted, session dropped, session re-derived, full rebuild, crash between node write and index write (must be impossible: same transaction).
4. Performance at the real shape (about 215,000 nodes, 350,000 raw rows, 1.3 GB of raw text): ingest and rebuild not slower than 1.3× today; search under 300 ms; migration yields to the event loop; `VACUUM` skipped when disk space is short.
5. A corrupt compressed row, a truncated database file, an index that is missing or stale at start-up: reported in diagnostics, service keeps working, nothing else lost.

---

### Task 1: Compressed storage, change-log bound, migration, compact

**Files:** `packages/server/src/store/{codec.ts (new),migrate-storage.ts (new),schema.ts,store.ts}`; `packages/server/src/{cli-commands.ts,api/server.ts,pipeline.ts}` as needed for wiring and diagnostics; `packages/shared/src/api.ts` (`Diagnostics.storage`); tests in `packages/server/test/`.

**Produces:** spec section 4 and the storage parts of 5 — the codec; `raw_event.body` and `node_detail.detail` stored through it with an encoding marker column, old and new rows coexisting; `CHANGE_LOG_MAX_ROWS = 50_000`; the resumable background migration with progress in `meta`; the free-space check and `VACUUM`; `agent-canvas compact`; `Diagnostics.storage` (`migrating`, `done`, `total`, `vacuumPending`, `lastError`, file size); a default-skipped benchmark for ingest, rebuild and migration at the real shape.

### Task 2: Search index and content search

**Files:** `packages/server/src/store/{search-index.ts (new),schema.ts,store.ts}`; `packages/server/src/api/server.ts`; `packages/shared/src/api.ts`; tests in `packages/server/test/`.

**Consumes:** the codec and store changes of Task 1 (node details are read through `decodeBody`).

**Produces:** spec section 3.1–3.3 and the index parts of 5 — the per-node index text; the contentless FTS5 trigram table maintained in the node write transaction; the consistency check and background reindex at start-up; literal query handling incl. the 2-character path; `GET /api/search` extended with `content: ContentHit[]`, `origin` / `projectId` filters and truncation flags; snippets cut from the node detail; measurements (index size, search time) written into the spec.

### Task 3: Web — node address, content hits

**Files:** `packages/web/src/{route.ts,App.tsx,client.ts,search.ts,pages/Home.tsx,pages/Session.tsx,pages/Stats.tsx,styles.css}`; tests in `packages/web/test/`.

**Produces:** spec section 3.4 — (a) the address `#/s/<sessionId>/n/<nodeId>` that opens a session with that node selected and brought into view (reusing the file panel's locate logic), and the stats page's slowest-calls rows linking to it; (b) the content group in the home search results with highlighted snippets, each linking to the node address; states for loading, no result, too-short query, the 2-character note and the "index is rebuilding" note.
