import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Change, GraphNode, NodeDetail, Origin, Session } from '@agent-canvas/shared';
import { openStore, type Store } from '../src/store/store.js';
import { SEARCH_META, startSearchIndexBuild } from '../src/store/search-index.js';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const iso = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const NOW = T0 + 10 * 24 * 60 * 60_000; // ten days after T0

function session(id: string, minutes: number, over: Partial<Session> = {}): Change {
  return {
    type: 'session_upserted',
    session: {
      id,
      projectId: 'proj',
      origin: 'claude',
      cwd: null,
      title: `title ${id}`,
      gitBranch: null,
      status: 'idle',
      sourceDeleted: false,
      startedAt: iso(0),
      lastActivityAt: iso(minutes),
      ...over,
    },
  };
}

function node(sessionId: string, id: string, kind: GraphNode['kind'], minutes: number, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    sessionId,
    turnId: null,
    agentId: null,
    childAgentId: null,
    parentId: null,
    kind,
    status: kind === 'tool' || kind === 'subagent' ? 'succeeded' : null,
    timestamp: iso(minutes),
    confirmed: true,
    title: kind === 'tool' ? 'Bash' : kind,
    summary: '',
    toolName: kind === 'tool' ? 'Bash' : null,
    toolUseId: null,
    messageId: null,
    durationMs: null,
    endedAt: null,
    usage: null,
    systemSubtype: null,
    ...over,
  };
}

const added = (n: GraphNode, detail: Partial<NodeDetail> = {}): Change => ({ type: 'node_added', node: n, detail });
const text = (sessionId: string, id: string, minutes: number, body: string, kind: GraphNode['kind'] = 'text'): Change =>
  added(node(sessionId, id, kind, minutes, { summary: body.replace(/\s+/g, ' ').slice(0, 200) }), { text: body });

describe('content search', () => {
  let tmp: string;
  let store: Store;
  const dbPath = (): string => path.join(tmp, 'data.db');
  // A generous time budget: a loaded machine must not cut results (the budget itself is tested on its own).
  const find = (q: string, options: Parameters<Store['searchContent']>[1] = {}) =>
    store.searchContent(q, { nowMs: NOW, timeBudgetMs: 60_000, ...options });
  const ids = (q: string, options: Parameters<Store['searchContent']>[1] = {}): string[] => find(q, options).hits.map((h) => h.nodeId);
  /** Rows in the index (contentless: counted through its docsize table, on a second connection). */
  const indexRows = (): number => {
    const db = new Database(dbPath(), { readonly: true });
    try {
      return db.prepare('SELECT COUNT(*) FROM search_fts_docsize').pluck().get() as number;
    } finally {
      db.close();
    }
  };
  const indexBytes = (): number => {
    const db = new Database(dbPath(), { readonly: true });
    try {
      return db.prepare('SELECT COALESCE(SUM(length(block)), 0) FROM search_fts_data').pluck().get() as number;
    } finally {
      db.close();
    }
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-search-'));
    store = openStore(dbPath());
  });
  afterEach(async () => {
    store.close();
    await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
  });

  describe('index maintenance', () => {
    test('a new database has a complete index; nodes are found by their full text', () => {
      expect(store.searchIndexStatus()).toEqual({ indexing: false, indexed: 0, total: 0, skipped: 0, lastError: null });
      const long = `${'intro '.repeat(100)}the needle-in-text is here`;
      store.applyChanges([session('s1', 5), text('s1', 'n1', 1, long, 'prompt')]);
      const r = find('needle-in-text');
      expect(r).toMatchObject({ truncated: false, shortQuery: false });
      expect(r.hits).toEqual([
        {
          sessionId: 's1',
          projectId: 'proj',
          origin: 'claude',
          sessionTitle: 'title s1',
          nodeId: 'n1',
          kind: 'prompt',
          toolName: null,
          at: iso(1),
          agentId: null,
          snippet: { before: 'intro intro intro intro intro intro the ', match: 'needle-in-text', after: ' is here', clippedStart: true, clippedEnd: false },
        },
      ]);
    });

    test('a node updated in place many times (streamed Cursor bubble): only its latest text, one row, the index does not grow', () => {
      store.applyChanges([session('s1', 5), text('s1', 'n1', 1, 'version-0 start')]);
      const sizes: number[] = [];
      for (let i = 1; i <= 600; i++) {
        store.applyChanges([
          { type: 'node_updated', sessionId: 's1', id: 'n1', patch: { summary: `version-${i}` }, detail: { text: `version-${i} ${'body '.repeat(50)}` } },
        ]);
        if (i % 100 === 0) sizes.push(indexBytes());
      }
      expect(ids('version-600')).toEqual(['n1']);
      expect(ids('version-599')).toEqual([]);
      expect(ids('version-0 ')).toEqual([]);
      expect(indexRows()).toBe(1);
      // bounded: the last measurement is not above the first by more than a few pages
      expect(sizes[sizes.length - 1]!).toBeLessThan(sizes[0]! + 64 * 1024);
    });

    test('an update in the same call as the add, and a patch without detail that changes an indexed field', () => {
      store.applyChanges([
        session('s1', 5),
        added(node('s1', 't1', 'tool', 1, { summary: 'ls' }), { input: { command: 'ls first-command' } }),
        { type: 'node_updated', sessionId: 's1', id: 't1', patch: { status: 'succeeded' }, detail: { output: 'tool-output-text' } },
        added(node('s1', 'sys', 'system', 2, { summary: 'old system summary' }), {}),
      ]);
      expect(ids('first-command')).toEqual(['t1']);
      expect(ids('tool-output-text')).toEqual(['t1']);
      store.applyChanges([{ type: 'node_updated', sessionId: 's1', id: 'sys', patch: { summary: 'new system summary' } }]);
      expect(ids('old system')).toEqual([]);
      expect(ids('new system')).toEqual(['sys']);
      // a patch of fields the text does not depend on leaves the row alone (and the tool keeps both parts)
      store.applyChanges([{ type: 'node_updated', sessionId: 's1', id: 't1', patch: { durationMs: 5 } }]);
      expect(ids('first-command')).toEqual(['t1']);
      expect(indexRows()).toBe(2);
    });

    test('a node re-added (replaced, new rowid) keeps exactly one row', () => {
      store.applyChanges([session('s1', 5), text('s1', 'n1', 1, 'first-version')]);
      store.applyChanges([text('s1', 'n1', 1, 'second-version')]);
      store.applyChanges([text('s1', 'n1', 1, 'third-version'), text('s1', 'n1', 1, 'fourth-version')]);
      expect(ids('first-version')).toEqual([]);
      expect(ids('third-version')).toEqual([]);
      expect(ids('fourth-version')).toEqual(['n1']);
      expect(indexRows()).toBe(1);
    });

    test('a session deleted (re-derive) and everything cleared (rebuild) remove their rows', () => {
      store.applyChanges([session('s1', 5), text('s1', 'a', 1, 'shared-term one'), session('s2', 6), text('s2', 'b', 1, 'shared-term two')]);
      expect(indexRows()).toBe(2);
      store.transaction(() => store.deleteDerivedForSession('s1'));
      expect(ids('shared-term')).toEqual(['b']);
      expect(indexRows()).toBe(1);
      store.clearDerived();
      expect(ids('shared-term')).toEqual([]);
      expect(indexRows()).toBe(0);
      expect(store.searchIndexStatus().indexing).toBe(false);
    });

    test('a failed applyChanges call leaves no index row behind (same transaction)', () => {
      store.applyChanges([session('s1', 5)]);
      expect(() =>
        store.transaction(() => {
          store.applyChanges([text('s1', 'n1', 1, 'rolled-back-text')]);
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(indexRows()).toBe(0);
      expect(ids('rolled-back-text')).toEqual([]);
    });

    test('empty text: no row; unknown nodes are not indexed', () => {
      store.applyChanges([
        session('s1', 5),
        added(node('s1', 'th', 'thinking', 1), { text: '' }),
        added(node('s1', 'u', 'unknown', 2, { summary: 'malformed-line' }), { raw: {} }),
      ]);
      expect(indexRows()).toBe(0);
      expect(ids('malformed-line')).toEqual([]);
    });

    test('a database without the index: built in batches at start-up, searchable as it goes', () => {
      store.applyChanges([session('s1', 5), ...Array.from({ length: 30 }, (_, i) => text('s1', `n${i}`, i, `old-row <${i}>`))]);
      store.close();
      const db = new Database(dbPath());
      db.exec(`DROP TABLE search_fts; DELETE FROM meta WHERE key LIKE 'search_index%'`);
      db.close();
      store = openStore(dbPath());
      expect(store.searchIndexStatus()).toMatchObject({ indexing: true, indexed: 0 });
      expect(ids('old-row')).toEqual([]);
      // a node written meanwhile is indexed at once
      store.applyChanges([text('s1', 'live', 100, 'old-row live')]);
      expect(ids('old-row')).toEqual(['live']);
      expect(store.searchIndexBatch(10, 1 << 20)).toEqual({ more: true, indexed: 10, skipped: 0 });
      // total: the node rowid range the build covers (the 30 old nodes and the one written before it started)
      expect(store.searchIndexStatus()).toMatchObject({ indexing: true, indexed: 10, total: 31 });
      // a node in the built part updated, one in the unbuilt part updated: both end up right
      store.applyChanges([
        { type: 'node_updated', sessionId: 's1', id: 'n0', patch: {}, detail: { text: 'renamed-zero' } },
        { type: 'node_updated', sessionId: 's1', id: 'n25', patch: {}, detail: { text: 'renamed-25' } },
      ]);
      let more = true;
      while (more) more = store.searchIndexBatch(10, 1 << 20).more;
      expect(store.searchIndexStatus()).toEqual({ indexing: false, indexed: 0, total: 0, skipped: 0, lastError: null });
      for (const i of [1, 9, 10, 24, 29]) expect(ids(`old-row <${i}>`), String(i)).toEqual([`n${i}`]);
      expect(ids('old-row <0>')).toEqual([]);
      expect(ids('renamed-zero')).toEqual(['n0']);
      expect(ids('renamed-25')).toEqual(['n25']);
      expect(indexRows()).toBe(31);
      // reopening: complete, nothing to do
      store.close();
      store = openStore(dbPath());
      expect(store.searchIndexStatus().indexing).toBe(false);
      expect(store.searchIndexBatch(10, 1 << 20)).toEqual({ more: false, indexed: 0, skipped: 0 });
    });

    test('the background build waits for start-up, pauses while writes are held or importing, then completes', async () => {
      store.applyChanges([session('s1', 5), ...Array.from({ length: 25 }, (_, i) => text('s1', `n${i}`, i, `job-row <${i}>`))]);
      store.close();
      const db = new Database(dbPath());
      db.exec(`DROP TABLE search_fts; DELETE FROM meta WHERE key LIKE 'search_index%'`);
      db.close();
      store = openStore(dbPath());
      const state = { startupDone: false, importing: false, held: false };
      let batches = 0;
      const counted = {
        searchIndexStatus: () => store.searchIndexStatus(),
        searchIndexBatch: (rows: number, bytes: number) => {
          batches += 1;
          if (state.held) throw new Error('wrote while held');
          return store.searchIndexBatch(rows, bytes);
        },
      };
      const lines: string[] = [];
      const job = startSearchIndexBuild(
        counted,
        { startupDone: () => state.startupDone, importing: () => state.importing, writesHeld: () => state.held },
        { pollMs: 5, batchRows: 4, log: (l) => lines.push(l) },
      );
      await new Promise((r) => setTimeout(r, 40));
      expect(batches).toBe(0); // start-up not done
      state.held = true;
      state.startupDone = true;
      await new Promise((r) => setTimeout(r, 40));
      expect(batches).toBe(0); // writes held (VACUUM)
      state.held = false;
      state.importing = true;
      await new Promise((r) => setTimeout(r, 40));
      expect(batches).toBe(0);
      state.importing = false;
      await job.done;
      expect(job.lastError()).toBeNull();
      expect(batches).toBe(7); // 25 nodes, 4 per batch
      expect(store.searchIndexStatus().indexing).toBe(false);
      expect(ids('job-row <24>')).toEqual(['n24']);
      expect(lines).toEqual(['agent-canvas: building the search index (one-time, in the background)…', 'agent-canvas: search index built']);
      // a complete index: the job does nothing
      const again = startSearchIndexBuild(counted, { startupDone: () => true, importing: () => false, writesHeld: () => false });
      await again.done;
      expect(batches).toBe(7);
    });

    test('stopping the background build ends it before its next batch', async () => {
      store.applyChanges([session('s1', 5), text('s1', 'n1', 1, 'stop-row')]);
      store.close();
      const db = new Database(dbPath());
      db.exec(`DROP TABLE search_fts; DELETE FROM meta WHERE key LIKE 'search_index%'`);
      db.close();
      store = openStore(dbPath());
      const job = startSearchIndexBuild(store, { startupDone: () => false, importing: () => false, writesHeld: () => false }, { pollMs: 10_000 });
      await job.stop();
      expect(store.searchIndexStatus().indexing).toBe(true);
    });

    test('an interrupted build continues where it stopped', () => {
      store.applyChanges([session('s1', 5), ...Array.from({ length: 20 }, (_, i) => text('s1', `n${i}`, i, `resume-row ${i}`))]);
      store.close();
      const db = new Database(dbPath());
      db.exec(`DROP TABLE search_fts; DELETE FROM meta WHERE key LIKE 'search_index%'`);
      db.close();
      store = openStore(dbPath());
      store.searchIndexBatch(8, 1 << 20);
      store.close();
      store = openStore(dbPath());
      expect(store.searchIndexStatus()).toMatchObject({ indexing: true, indexed: 8 });
      expect(store.searchIndexBatch(100, 1 << 20)).toEqual({ more: false, indexed: 12, skipped: 0 });
      expect(find('resume-row').hits).toHaveLength(5);
      expect(indexRows()).toBe(20);
    });

    test('an index with more rows than nodes is found inconsistent at open and rebuilt', () => {
      store.applyChanges([session('s1', 5), text('s1', 'n1', 1, 'kept-row')]);
      store.close();
      const db = new Database(dbPath());
      db.prepare(`INSERT INTO search_fts (rowid, text) VALUES (999, 'orphan-row')`).run();
      db.close();
      store = openStore(dbPath());
      expect(store.searchIndexStatus().indexing).toBe(true);
      while (store.searchIndexBatch(100, 1 << 20).more);
      expect(ids('orphan-row')).toEqual([]);
      expect(ids('kept-row')).toEqual(['n1']);
      expect(store.getMeta(SEARCH_META.complete)).toBe('1');
    });
  });

  describe('queries', () => {
    test('literal: FTS5 and LIKE syntax typed by the user is plain text, never an error', () => {
      const specials = ['say "hi" now', 'a*b*c', '(paren)', 'key:value', '-dash-', '^caret', '100%_done', 'C:\\Users\\x', 'NOT AND', 'OR NOT', 'NEAR(x y)', 'x AND y'];
      store.applyChanges([session('s1', 5), ...specials.map((s, i) => text('s1', `n${i}`, i, `before ${s} after`))]);
      specials.forEach((s, i) => {
        expect(ids(s), s).toEqual([`n${i}`]);
      });
      for (const q of ['"', '""', '"*"', '***', '(((', 'a"b', '\\\\\\', '%%%', '___', 'NOT', 'NEAR', 'AND OR', '^^^', ':::']) {
        expect(() => find(q), q).not.toThrow();
      }
      expect(ids('%%%')).toEqual([]);
      expect(ids('___')).toEqual([]);
      expect(ids('a*b')).toEqual(['n1']);
      expect(ids('ab')).toEqual([]); // not a wildcard
    });

    test('NUL in the query: no error; the runs around it are looked up and the whole is matched literally', () => {
      store.applyChanges([session('s1', 5), text('s1', 'n1', 1, 'abc\u0000def'), text('s1', 'n2', 2, 'abc def')]);
      expect(ids('abc\u0000def')).toEqual(['n1']);
      expect(() => find('a\u0000b\u0000c')).not.toThrow();
      expect(ids('a\u0000b\u0000c')).toEqual([]);
    });

    test('ASCII case-insensitive, other letters literal', () => {
      store.applyChanges([session('s1', 5), text('s1', 'n1', 1, 'Hello World'), text('s1', 'n2', 2, 'café crème'), text('s1', 'n3', 3, 'CAFÉ')]);
      expect(ids('hello world')).toEqual(['n1']);
      expect(ids('HELLO WORLD')).toEqual(['n1']);
      expect(ids('café')).toEqual(['n2']);
      expect(ids('CAFÉ')).toEqual(['n3']);
      expect(ids('cafÉ')).toEqual(['n3']); // ASCII letters fold, É does not
      expect(ids('CAFé')).toEqual(['n2']);
    });

    test('2 versus 3 code points (surrogate pairs and CJK)', () => {
      const old = T0 - 60 * 24 * 60 * 60_000; // two months before T0: older than 30 days before NOW
      store.applyChanges([
        session('recent', 5),
        text('recent', 'p', 1, '我们讨论中文检索的实现', 'prompt'),
        text('recent', 'r', 2, '回复：中文检索已经完成 😀😀 done'),
        added(node('recent', 't', 'tool', 3), { input: { command: 'echo 中文检索' }, output: '😀😀😀' }),
        session('old', -1, { lastActivityAt: new Date(old).toISOString() }),
        text('old', 'o', -2, '很久以前的中文检索'),
      ]);
      const two = find('中文');
      expect(two.shortQuery).toBe(true);
      expect(two.hits.map((h) => h.nodeId)).toEqual(['r', 'p']); // prompts and replies of recent sessions only
      const three = find('中文检');
      expect(three.shortQuery).toBe(false);
      expect(three.hits.map((h) => h.nodeId)).toEqual(['t', 'r', 'p', 'o']);
      expect(find('😀😀')).toMatchObject({ shortQuery: true, hits: [{ nodeId: 'r' }] });
      expect(find('😀😀😀')).toMatchObject({ shortQuery: false, hits: [{ nodeId: 't' }] });
      expect(find('😀')).toEqual({ hits: [], truncated: false, shortQuery: false });
      expect(find(' x ')).toEqual({ hits: [], truncated: false, shortQuery: false });
    });

    test('2 code points: found beyond the summary (the full text is read when the summary is cut)', () => {
      const long = `${'x'.repeat(300)} 结尾`;
      store.applyChanges([session('s1', 5), added(node('s1', 'n1', 'text', 1, { summary: `${'x'.repeat(199)}…` }), { text: long })]);
      expect(find('结尾').hits.map((h) => h.snippet.match)).toEqual(['结尾']);
      expect(find('Xx').hits).toHaveLength(1);
    });

    test('tool output: only the first 8 KB is searchable; subagent nodes are found', () => {
      const output = `early-marker ${'o'.repeat(9000)} late-marker`;
      store.applyChanges([
        session('s1', 5),
        added(node('s1', 't1', 'tool', 1), { input: { command: 'cat big' }, output }),
        added(node('s1', 'sub-text', 'text', 2, { agentId: 'agent-1' }), { text: 'inside the subagent thread' }),
      ]);
      expect(ids('early-marker')).toEqual(['t1']);
      expect(ids('late-marker')).toEqual([]);
      expect(find('subagent thread').hits).toMatchObject([{ nodeId: 'sub-text', agentId: 'agent-1' }]);
    });

    test('order and limits: sessions by last activity, nodes by time, 5 per session, 50 sessions, truncated', () => {
      const changes: Change[] = [];
      for (let s = 0; s < 55; s++) {
        changes.push(session(`s${String(s).padStart(2, '0')}`, s));
        changes.push(text(`s${String(s).padStart(2, '0')}`, `n${s}`, s, `common-term ${s}`));
      }
      changes.push(session('busy', 1000));
      for (let i = 0; i < 7; i++) changes.push(text('busy', `b${i}`, i, `common-term busy ${i}`));
      store.applyChanges(changes);
      const r = find('common-term');
      expect(r.truncated).toBe(true);
      const sessions = [...new Set(r.hits.map((h) => h.sessionId))];
      expect(sessions).toHaveLength(50);
      expect(sessions[0]).toBe('busy');
      expect(sessions[1]).toBe('s54');
      expect(sessions[49]).toBe('s06');
      expect(r.hits.filter((h) => h.sessionId === 'busy').map((h) => h.nodeId)).toEqual(['b6', 'b5', 'b4', 'b3', 'b2']);
      // only the per-session limit
      expect(find('common-term busy')).toMatchObject({ truncated: true });
      expect(find('common-term busy').hits).toHaveLength(5);
      // nothing cut
      expect(find('common-term 54')).toMatchObject({ truncated: false, hits: [{ nodeId: 'n54' }] });
    });

    test('many candidates (sessions walked) give the same order and limits', () => {
      const changes: Change[] = [];
      for (let s = 0; s < 60; s++) {
        const id = `s${String(s).padStart(2, '0')}`;
        changes.push(session(id, s));
        for (let i = 0; i < 40; i++) changes.push(text(id, `${id}-${i}`, i, `plentiful word ${i}`));
      }
      store.applyChanges(changes);
      const r = find('plentiful');
      expect(r.truncated).toBe(true);
      expect(r.hits).toHaveLength(250);
      expect(r.hits[0]).toMatchObject({ sessionId: 's59', nodeId: 's59-39' });
      expect(r.hits[249]).toMatchObject({ sessionId: 's10', nodeId: 's10-35' });
    });

    test('the decode / time budget stops verification and says truncated', () => {
      store.applyChanges([session('s1', 5), text('s1', 'n1', 1, 'budget-term')]);
      expect(find('budget-term', { timeBudgetMs: -1 })).toEqual({ hits: [], truncated: true, shortQuery: false });
      expect(find('bu', { timeBudgetMs: -1 })).toMatchObject({ truncated: true, shortQuery: true });
    });

    test('filters: origin and project', () => {
      store.applyChanges([
        session('c', 5),
        text('c', 'n1', 1, 'filter-term claude'),
        session('x', 6, { origin: 'codex', projectId: 'other' }),
        text('x', 'n2', 1, 'filter-term codex'),
      ]);
      expect(ids('filter-term')).toEqual(['n2', 'n1']);
      expect(ids('filter-term', { origin: 'claude' })).toEqual(['n1']);
      expect(ids('filter-term', { origin: 'cursor' as Origin })).toEqual([]);
      expect(ids('filter-term', { projectId: 'other' })).toEqual(['n2']);
      expect(ids('filter-term', { projectId: 'other', origin: 'claude' })).toEqual([]);
      expect(find('filter-term', { origin: 'codex' }).hits[0]).toMatchObject({ origin: 'codex', projectId: 'other' });
    });

    test('the snippet comes from the first occurrence in the index text (tool name before input)', () => {
      store.applyChanges([session('s1', 5), added(node('s1', 't1', 'tool', 1, { title: 'Grep', toolName: 'Grep' }), { input: { pattern: 'Grep for this' } })]);
      expect(find('grep').hits[0]!.snippet).toEqual({ before: '', match: 'Grep', after: ' Grep for this', clippedStart: false, clippedEnd: false });
    });

    test('a very long query is cut to 200 code points', () => {
      const body = 'q'.repeat(200);
      store.applyChanges([session('s1', 5), text('s1', 'n1', 1, body)]);
      expect(ids('q'.repeat(500))).toEqual(['n1']);
    });

    test('an undecodable detail: its node is not returned, nothing throws', () => {
      store.applyChanges([session('s1', 5), text('s1', 'n1', 1, 'damaged-term'), text('s1', 'n2', 2, 'damaged-term ok')]);
      store.close();
      const db = new Database(dbPath());
      db.prepare(`UPDATE node_detail SET data = ?, enc = 1 WHERE node_id = 'n1'`).run(Buffer.from([1, 2, 3, 4]));
      db.close();
      store = openStore(dbPath());
      expect(ids('damaged-term')).toEqual(['n2']);
      expect(store.unreadableDetailCount()).toBe(1); // counted like any undecodable detail
    });
  });

  describe('robustness and waste (review round 1)', () => {
    /** Drops the index as a database from before it would have none. */
    const dropIndex = (mutate?: (db: Database.Database) => void): void => {
      store.close();
      const db = new Database(dbPath());
      db.exec(`DROP TABLE search_fts; DELETE FROM meta WHERE key LIKE 'search_index%'`);
      mutate?.(db);
      db.close();
      store = openStore(dbPath());
    };

    test('a poison node row and an undecodable detail do not stop the build: the rest is indexed, both are counted', async () => {
      store.applyChanges([session('s1', 5), ...Array.from({ length: 12 }, (_, i) => text('s1', `n${i}`, i, `poison-run <${i}>`))]);
      dropIndex((db) => {
        // (a body that is not JSON cannot even be written: the node_main_prompt index parses every body)
        db.prepare(`UPDATE node SET body = '42' WHERE id = 'n3'`).run();
        db.prepare(`UPDATE node_detail SET data = ?, enc = 1 WHERE node_id = 'n7'`).run(Buffer.from([9, 9, 9]));
      });
      const lines: string[] = [];
      const job = startSearchIndexBuild(store, { startupDone: () => true, importing: () => false, writesHeld: () => false }, { pollMs: 1, batchRows: 5, log: (l) => lines.push(l) });
      await job.done;
      expect(job.status()).toEqual({ indexing: false, indexed: 0, total: 0, skipped: 2, lastError: null });
      expect(ids('poison-run <11>')).toEqual(['n11']);
      expect(ids('poison-run <4>')).toEqual(['n4']);
      expect(indexRows()).toBe(11); // n3 has no row; n7 is indexed from its summary (its detail cannot be read)
      expect(lines.some((l) => l.includes('could not be read fully'))).toBe(true);
      expect(store.unreadableDetailCount()).toBeGreaterThanOrEqual(1);
    });

    test('a failing batch is reported (indexing stays true: incomplete) and the next start retries', async () => {
      store.applyChanges([session('s1', 5), text('s1', 'n1', 1, 'retry-term')]);
      dropIndex();
      const failing = {
        searchIndexStatus: () => store.searchIndexStatus(),
        searchIndexBatch: (): { more: boolean } => {
          throw new Error('SQLITE_CORRUPT: database disk image is malformed');
        },
      };
      const host = { startupDone: () => true, importing: () => false, writesHeld: () => false };
      const job = startSearchIndexBuild(failing, host, { pollMs: 1 });
      await job.done;
      expect(job.status()).toMatchObject({ indexing: true, lastError: 'SQLITE_CORRUPT: database disk image is malformed' });
      // the next start: a new build on the same database completes
      const again = startSearchIndexBuild(store, host, { pollMs: 1 });
      await again.done;
      expect(again.status()).toMatchObject({ indexing: false, lastError: null });
      expect(ids('retry-term')).toEqual(['n1']);
    });

    test('an update that leaves the index text as it was does not touch the index', () => {
      const statements: string[] = [];
      store.close();
      store = openStore(dbPath(), { verbose: (sql) => statements.push(String(sql)) });
      store.applyChanges([
        session('s1', 5),
        text('s1', 'n1', 1, 'stable text'),
        added(node('s1', 'sys', 'system', 2, { summary: 'system summary' }), {}),
      ]);
      const touches = (): number => statements.filter((s) => s.includes('search_fts')).length;
      statements.length = 0;
      store.applyChanges([
        { type: 'node_updated', sessionId: 's1', id: 'n1', patch: { summary: 'stable text' }, detail: { text: 'stable text' } }, // same text again
        { type: 'node_updated', sessionId: 's1', id: 'sys', patch: { summary: 'system summary' } }, // a field set to its value
        { type: 'node_updated', sessionId: 's1', id: 'n1', patch: { durationMs: 3 } },
      ]);
      expect(touches()).toBe(0);
      store.applyChanges([{ type: 'node_updated', sessionId: 's1', id: 'n1', patch: {}, detail: { text: 'changed text' } }]);
      expect(touches()).toBeGreaterThan(0);
      expect(ids('changed text')).toEqual(['n1']);
      expect(ids('stable text')).toEqual([]);
    });

    test('a match at the 8 KB output cut: the snippet ends there with an ellipsis', () => {
      const output = `${'o'.repeat(8180)}NEEDLE-AT-CUT${'p'.repeat(12_000)}`;
      store.applyChanges([session('s1', 5), added(node('s1', 't1', 'tool', 1), { input: { command: 'cat' }, output })]);
      const hit = find('o NEEDLE').hits[0];
      expect(hit).toBeUndefined(); // no space there
      const s = find('oooNEED').hits[0]!.snippet;
      expect(s.clippedEnd).toBe(true);
      expect(s.after).not.toContain('p');
    });

    test('a match across the join of two index parts is no match', () => {
      store.applyChanges([session('s1', 5), added(node('s1', 't1', 'tool', 1, { title: 'Bash', toolName: 'Bash' }), { input: { command: 'cmd-start here' } })]);
      expect(ids('Bash\ncmd-start')).toEqual([]);
      expect(ids('cmd-start')).toEqual(['t1']);
    });

    test('a patch-only update of a node whose stored detail cannot be decoded leaves its index row alone', () => {
      store.applyChanges([session('s1', 5), added(node('s1', 'sys', 'system', 1, { summary: 'old-summary' }), { text: 'full system text' })]);
      store.close();
      const db = new Database(dbPath());
      db.prepare(`UPDATE node_detail SET data = ?, enc = 1 WHERE node_id = 'sys'`).run(Buffer.from([1, 2, 3]));
      db.close();
      store = openStore(dbPath());
      store.applyChanges([{ type: 'node_updated', sessionId: 's1', id: 'sys', patch: { summary: 'new-summary' } }]);
      expect(indexRows()).toBe(1);
    });

    test('node rowids, and with them the index, survive VACUUM', () => {
      store.applyChanges([
        session('a', 5),
        ...Array.from({ length: 20 }, (_, i) => text('a', `a${i}`, i, `gone-${i}`)),
        session('b', 6),
        ...Array.from({ length: 20 }, (_, i) => text('b', `b${i}`, i, `kept-row <${i}>`)),
      ]);
      store.transaction(() => store.deleteDerivedForSession('a')); // a gap of rowids before b's
      store.vacuum();
      expect(ids('kept-row <7>')).toEqual(['b7']);
      expect(ids('kept-row <19>')).toEqual(['b19']);
      expect(indexRows()).toBe(20);
    });
  });
});
