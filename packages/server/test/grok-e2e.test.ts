import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { GraphEdge, GraphNode, GraphSnapshot } from '@agent-canvas/shared';
import { fileSources } from '../src/cli.js';
import { loadConfig, type Config } from '../src/config.js';
import { FilesService } from '../src/files/service.js';
import { grokNodeId } from '../src/normalize/grok.js';
import { Pipeline } from '../src/pipeline.js';
import { GrokFileSource } from '../src/sources/grok/source.js';
import { storeStatsSource } from '../src/stats/service.js';
import { openStore, type Store } from '../src/store/store.js';
import { CHILD, CHILD_SUMMARY_REL, CHILD_UPDATES_REL, chunk, CWD, exampleLines, ext, PROJECT, SID, summaryJson, SUMMARY_REL, T0, upd, UPDATES_REL } from './grok-fixtures.js';

// Pipeline + store on temp directories: a Grok root (`<grokDir>/sessions/<encoded cwd>/<id>/`) with a main session and
// a subagent session directory.

let tmp: string;
let config: Config;
let grokDir: string;
let sessionsDir: string;
const stores: Store[] = [];

const abs = (rel: string): string => path.join(sessionsDir, ...rel.split('/'));
async function writeRel(rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
  await fs.writeFile(abs(rel), content);
}
const body = (ls: string[]): string => ls.map((l) => `${l}\n`).join('');
const open = (): Store => {
  const s = openStore(':memory:');
  stores.push(s);
  return s;
};
const cfg = (dir: string | null): Config =>
  loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, deepseekDir: null, workbuddyDirs: [], codebuddyDir: null, doubaoDirs: [], qwenDir: null, geminiDir: null, copilotDir: null, grokDir: dir });
const newPipeline = (store: Store, c: Config = config): Pipeline => new Pipeline(store, c, { sources: fileSources(c, store) });
function view(store: Store, sessionId: string) {
  const g: GraphSnapshot | null = store.getGraph(sessionId);
  if (g === null) return null;
  const nodes: Record<string, GraphNode> = Object.fromEntries([...g.nodes].sort((a, b) => a.id.localeCompare(b.id)).map((n) => [n.id, n]));
  const edges: Record<string, GraphEdge> = Object.fromEntries([...g.edges].sort((a, b) => a.id.localeCompare(b.id)).map((e) => [e.id, e]));
  return { session: g.session, nodes, edges };
}
/** View plus every node's stored detail. */
function full(store: Store, sessionId: string) {
  const v = view(store, sessionId);
  if (v === null) return null;
  return { ...v, details: Object.fromEntries(Object.keys(v.nodes).map((id) => [id, store.getNodeDetail(sessionId, id)])) };
}

/** Main session: the example turn, then a second turn that dispatches the subagent, then streamed reply chunks. */
const mainLines = (): string[] => [
  ...exampleLines(),
  chunk('user', 'Now look for TODOs', { ts: T0 + 30, promptId: 'p2' }),
  upd({ sessionUpdate: 'tool_call', toolCallId: 'task_1', title: 'explore', kind: 'other', status: 'pending', rawInput: { description: 'Find TODOs', prompt: 'find TODOs', subagent_type: 'explore' }, _meta: { toolName: 'task' } }, { ts: T0 + 31, meta: { promptId: 'p2' } }),
  upd({ sessionUpdate: 'tool_call_update', toolCallId: 'task_1', status: 'completed', rawOutput: { subagent_id: CHILD, output: 'two TODOs' } }, { ts: T0 + 50, meta: { promptId: 'p2' } }),
  ...['There ', 'are ', 'two ', 'TODOs.'].map((t, i) => chunk('agent', t, { ts: T0 + 51 + i, promptId: 'p2' })),
  ext({ sessionUpdate: 'turn_completed', prompt_id: 'p2', usage: { inputTokens: 900, outputTokens: 40, cachedReadTokens: 100, cacheCreationTokens: 0, reasoningTokens: 0 } }, { ts: T0 + 56 }),
];
const childLines = (): string[] => [
  chunk('user', 'find TODOs', { ts: T0 + 32, promptId: 'c1' }),
  upd({ sessionUpdate: 'tool_call', toolCallId: 'g1', title: 'grep TODO', kind: 'search', status: 'pending', rawInput: { pattern: 'TODO', path: 'src' }, _meta: { toolName: 'grep' } }, { ts: T0 + 33, meta: { promptId: 'c1' } }),
  upd({ sessionUpdate: 'tool_call_update', toolCallId: 'g1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'src/a.ts:1 TODO\nsrc/b.ts:9 TODO' } }] }, { ts: T0 + 40, meta: { promptId: 'c1' } }),
  chunk('agent', 'Found two TODOs.', { ts: T0 + 45, promptId: 'c1' }),
];
const childSummary = (): string => summaryJson({ id: CHILD, kind: 'subagent', parent: SID, title: null, summary: 'find TODOs', extra: { hidden: true } });

async function writeAll(): Promise<void> {
  await writeRel(SUMMARY_REL, summaryJson());
  await writeRel(UPDATES_REL, body(mainLines()));
  await writeRel(CHILD_SUMMARY_REL, childSummary());
  await writeRel(CHILD_UPDATES_REL, body(childLines()));
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-grok-e2e-'));
  grokDir = path.join(tmp, '.grok');
  sessionsDir = path.join(grokDir, 'sessions');
  await fs.mkdir(sessionsDir, { recursive: true });
  config = cfg(grokDir);
});
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

describe('Grok Build end to end', () => {
  test('fileSources: a GrokFileSource only when <grokDir>/sessions exists; nothing is created otherwise', async () => {
    expect(fileSources(config).some((s) => s instanceof GrokFileSource)).toBe(true);
    const bare = path.join(tmp, 'bare-grok');
    await fs.mkdir(bare);
    const c2 = cfg(bare);
    const store = open();
    const p = newPipeline(store, c2);
    expect(p.fileSources().map((s) => s.origin)).toEqual(['claude']);
    await p.scanAll();
    await p.idle();
    expect(await fs.readdir(bare)).toEqual([]);
    expect(fileSources(cfg(null)).map((s) => s.origin)).toEqual(['claude']);
    expect(fileSources(cfg(path.join(tmp, 'missing'))).map((s) => s.origin)).toEqual(['claude']);
  });

  test('one-shot ingest = line-by-line appended ingest = rebuild from raw events; restart re-ingests nothing', { timeout: 30_000 }, async () => {
    await writeAll();
    const s1 = open();
    const p1 = newPipeline(s1);
    await p1.scanAll();
    await p1.idle();
    expect(p1.ingestFailures()).toEqual([]);
    expect(s1.diagnostics().unknownRecords).toEqual([]);
    const oneShot = full(s1, SID)!;
    expect(oneShot.session).toMatchObject({ origin: 'grok', projectId: PROJECT, cwd: CWD, title: 'Fix failing unit test in parser', gitBranch: 'main' });
    expect(Object.keys(oneShot.nodes)).toHaveLength(11);
    expect(s1.getSession(CHILD)).toBeNull(); // the subagent is a thread of its parent, not a session
    expect(s1.listProjects(Date.now()).map((x) => [x.id, x.cwd, x.origins])).toEqual([[PROJECT, CWD, ['grok']]]);
    const TASK = grokNodeId(SID, null, 'call:task_1');
    expect(oneShot.nodes[TASK]).toMatchObject({ kind: 'subagent', childAgentId: CHILD });
    const reply = Object.values(oneShot.nodes).find((n) => n.kind === 'text' && n.turnId !== null && n.parentId === TASK)!;
    expect(oneShot.details[reply.id]?.text).toBe('There are two TODOs.');

    // Line by line, the files written in another order (child first, summaries after their first lines).
    for (const rel of [UPDATES_REL, SUMMARY_REL, CHILD_UPDATES_REL, CHILD_SUMMARY_REL]) await fs.rm(abs(rel));
    const s2 = open();
    const p2 = newPipeline(s2);
    await p2.scanAll();
    let childText = '';
    for (const [i, line] of childLines().entries()) {
      childText += `${line}\n`;
      await writeRel(CHILD_UPDATES_REL, childText);
      await p2.ingestFile(abs(CHILD_UPDATES_REL));
      if (i === 0) {
        await writeRel(CHILD_SUMMARY_REL, childSummary());
        await p2.ingestFile(abs(CHILD_SUMMARY_REL));
        await p2.ingestFile(abs(CHILD_UPDATES_REL));
      }
    }
    let text = '';
    for (const [i, line] of mainLines().entries()) {
      text += `${line}\n`;
      await writeRel(UPDATES_REL, text);
      await p2.ingestFile(abs(UPDATES_REL));
      if (i === 1) {
        await writeRel(SUMMARY_REL, summaryJson());
        await p2.ingestFile(abs(SUMMARY_REL));
        await p2.ingestFile(abs(UPDATES_REL));
      }
    }
    await p2.idle();
    expect(p2.ingestFailures()).toEqual([]);
    expect(full(s2, SID)).toEqual(oneShot);

    p1.rebuild();
    expect(full(s1, SID)).toEqual(oneShot);
    p2.rebuild();
    expect(full(s2, SID)).toEqual(oneShot);
    const again = newPipeline(s2);
    await again.scanAll();
    await again.idle();
    expect(full(s2, SID)).toEqual(oneShot);
  });

  test('Review Focus 3: the child session directory ingested before the parent and after it gives the same graph', async () => {
    await writeAll();
    const after = open();
    const pa = newPipeline(after);
    for (const rel of [SUMMARY_REL, UPDATES_REL, CHILD_SUMMARY_REL, CHILD_UPDATES_REL]) await pa.ingestFile(abs(rel));
    await pa.idle();
    const before = open();
    const pb = newPipeline(before);
    for (const rel of [CHILD_SUMMARY_REL, CHILD_UPDATES_REL, SUMMARY_REL, UPDATES_REL]) await pb.ingestFile(abs(rel));
    await pb.idle();
    expect(pa.ingestFailures()).toEqual([]);
    expect(pb.ingestFailures()).toEqual([]);
    const want = full(after, SID)!;
    expect(full(before, SID)).toEqual(want);
    const first = Object.values(want.nodes).find((n) => n.agentId === CHILD && n.kind === 'prompt')!;
    expect(first.parentId).toBe(grokNodeId(SID, null, 'call:task_1'));
    pb.rebuild();
    expect(full(before, SID)).toEqual(want);
  });

  test('Review Focus 2: a rewind removes the nodes from the graph, the content search and the by-file view (live and after rebuild)', async () => {
    await writeAll();
    const store = open();
    const p = newPipeline(store);
    await p.scanAll();
    await p.idle();
    const TASK = grokNodeId(SID, null, 'call:task_1');
    const EDIT = grokNodeId(SID, null, 'call:call_2');
    const searchHits = (q: string): string[] => store.searchContent(q, { nowMs: Date.parse('2026-11-17T00:00:00Z'), timeBudgetMs: 60_000 }).hits.map((h) => h.nodeId);
    const files = async (): Promise<string> => JSON.stringify(await new FilesService(storeStatsSource(store)).session(SID));
    expect(view(store, SID)!.nodes[EDIT]).toBeDefined();
    expect(searchHits('TODOs')).not.toEqual([]);
    expect(await files()).toContain(`${CWD}/src/parser.ts`);

    // Rewind to prompt index 0: both turns go; the subagent thread stays, detached.
    await fs.appendFile(abs(UPDATES_REL), `${ext({ sessionUpdate: 'rewind_marker', target_prompt_index: 0 }, { ts: T0 + 60 })}\n`);
    await p.ingestFile(abs(UPDATES_REL));
    await p.idle();
    const check = async (): Promise<void> => {
      const v = view(store, SID)!;
      expect(Object.values(v.nodes).every((n) => n.agentId === CHILD)).toBe(true);
      expect(Object.keys(v.nodes)).toHaveLength(3);
      expect(Object.values(v.edges).some((e) => e.from === TASK)).toBe(false);
      expect(Object.values(v.nodes).find((n) => n.kind === 'prompt')!.parentId).toBeNull();
      expect(store.getNodeDetail(SID, EDIT)).toBeNull();
      expect(searchHits('parser')).toEqual([]);
      expect(searchHits('There')).toEqual([]);
      expect(await files()).not.toContain(`${CWD}/src/parser.ts`);
    };
    await check();
    p.rebuild();
    while (store.searchIndexBatch(10_000, 10_000_000).more);
    await check();
  });

  test('title: generated_title, else session_summary; a rewritten summary.json updates it', async () => {
    await writeRel(SUMMARY_REL, summaryJson({ title: null, summary: 'From the summary' }));
    await writeRel(UPDATES_REL, body(exampleLines()));
    const store = open();
    const p = newPipeline(store);
    await p.scanAll();
    await p.idle();
    expect(store.getSession(SID)?.title).toBe('From the summary');
    await writeRel(SUMMARY_REL, summaryJson({ title: 'Generated title', summary: 'From the summary' }));
    await p.ingestFile(abs(SUMMARY_REL));
    await p.idle();
    expect(store.getSession(SID)?.title).toBe('Generated title');
    // Counter-only rewrites store nothing new.
    const raw = store.hasRawForSession(SID);
    expect(raw).toBe(true);
    p.rebuild();
    expect(store.getSession(SID)?.title).toBe('Generated title');
  });

  test('no phantom sessions: no summary.json, or summary.json with an empty updates.jsonl, makes nothing until content', async () => {
    await writeRel(UPDATES_REL, body(exampleLines()));
    const store = open();
    const p = newPipeline(store);
    await p.scanAll();
    await p.idle();
    expect(store.getSession(SID)).toBeNull();
    await fs.writeFile(abs(UPDATES_REL), '');
    await writeRel(SUMMARY_REL, summaryJson());
    await p.scanAll();
    await p.idle();
    expect(store.getSession(SID)).toBeNull();
    expect(store.listProjects(Date.now())).toEqual([]);
    await fs.appendFile(abs(UPDATES_REL), `${chunk('user', 'hello')}\n`);
    await p.ingestFile(abs(UPDATES_REL));
    await p.idle();
    expect(store.getSession(SID)).toMatchObject({ title: 'Fix failing unit test in parser', projectId: PROJECT });
  });

  test('C1: byte-identical lines (repeated chunks, tool updates, rewind markers) are all applied; live = one-shot = rebuild = re-hydrate', { timeout: 30_000 }, async () => {
    const same = (t: string): string => chunk('agent', t, { ts: T0 + 1, promptId: 'p' });
    const lines = [
      chunk('user', 'zero', { ts: T0, promptId: 'p0' }),
      chunk('user', 'go', { ts: T0 + 1, promptId: 'p' }),
      ...['1', '\n\n', '2', '\n\n', '3', '\n\n'].map(same),
      upd({ sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'execute', rawInput: { command: 'x' } }, { ts: T0 + 1, meta: { promptId: 'p' } }),
      upd({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' }, { ts: T0 + 1, meta: { promptId: 'p' } }),
      upd({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' }, { ts: T0 + 1, meta: { promptId: 'p' } }),
      upd({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }, { ts: T0 + 1, meta: { promptId: 'p' } }),
      ...['a', 'a', 'a'].map(same),
      ext({ sessionUpdate: 'rewind_marker', target_prompt_index: 1 }, { ts: T0 + 2 }),
      chunk('user', 'again', { ts: T0 + 2, promptId: 'p2' }),
      ...['b', 'b'].map((t) => chunk('agent', t, { ts: T0 + 2, promptId: 'p2' })),
      ext({ sessionUpdate: 'rewind_marker', target_prompt_index: 1 }, { ts: T0 + 2 }),
      chunk('user', 'last', { ts: T0 + 3, promptId: 'p3' }),
      ...['c', 'c', 'c'].map((t) => chunk('agent', t, { ts: T0 + 3, promptId: 'p3' })),
    ];
    const textsOf = (v: NonNullable<ReturnType<typeof full>>): unknown[] => Object.values(v.nodes).filter((n) => n.kind === 'text').map((n) => v.details[n.id]?.text);

    // Before the rewinds: every repeated chunk is there, the repeated updates did no harm.
    await writeRel(SUMMARY_REL, summaryJson());
    await writeRel(UPDATES_REL, body(lines.slice(0, 15)));
    const s0 = open();
    const p0 = newPipeline(s0);
    await p0.scanAll();
    await p0.idle();
    const v0 = full(s0, SID)!;
    expect(textsOf(v0).sort()).toEqual(['1\n\n2\n\n3\n\n', 'aaa']);
    expect(Object.values(v0.nodes).find((n) => n.kind === 'tool')!.status).toBe('succeeded');

    // The whole file: two identical rewind markers, each applied.
    await writeRel(UPDATES_REL, body(lines));
    const s1 = open();
    const p1 = newPipeline(s1);
    await p1.scanAll();
    await p1.idle();
    const want = full(s1, SID)!;
    expect(textsOf(want)).toEqual(['ccc']);
    expect(Object.values(want.nodes).map((n) => n.kind).sort()).toEqual(['prompt', 'prompt', 'text']);

    // Live, one line at a time, a fresh pipeline (re-hydration from the stored lines) for every line.
    const s2 = open();
    let text = '';
    for (const line of lines) {
      text += `${line}\n`;
      await writeRel(UPDATES_REL, text);
      const p = newPipeline(s2);
      await p.ingestFile(abs(SUMMARY_REL));
      await p.ingestFile(abs(UPDATES_REL));
      await p.idle();
      expect(p.ingestFailures()).toEqual([]);
    }
    expect(full(s2, SID)).toEqual(want);
    p1.rebuild();
    expect(full(s1, SID)).toEqual(want);

    // A re-read of the unchanged file from offset 0 adds nothing.
    const rawBefore = s1.rawForSessionAfter(SID, 0, 10_000, 1e9).length;
    s1.setOffset(`grok:${UPDATES_REL}`, 0, 0);
    const again = newPipeline(s1);
    await again.ingestFile(abs(UPDATES_REL));
    await again.idle();
    expect(s1.rawForSessionAfter(SID, 0, 10_000, 1e9).length).toBe(rawBefore);
    expect(full(s1, SID)).toEqual(want);
  });

  test('C1: a file rewritten shorter with shifted offsets: the thread shows the new content, as a fresh read of it does (live and rebuild)', async () => {
    const before = [chunk('user', 'first', { ts: T0, promptId: 'p1' }), chunk('agent', 'x', { ts: T0, promptId: 'p1' }), chunk('agent', 'y', { ts: T0, promptId: 'p1' }), chunk('agent', 'z', { ts: T0, promptId: 'p1' })];
    const after = [chunk('user', 'first', { ts: T0, promptId: 'p1' }), chunk('agent', 'y', { ts: T0, promptId: 'p1' })];
    await writeRel(SUMMARY_REL, summaryJson());
    await writeRel(UPDATES_REL, body(before));
    const store = open();
    const p = newPipeline(store);
    await p.scanAll();
    await p.idle();
    await writeRel(UPDATES_REL, body(after));
    await p.ingestFile(abs(UPDATES_REL));
    await p.idle();
    const fresh = open();
    const pf = newPipeline(fresh);
    await pf.scanAll();
    await pf.idle();
    const want = full(fresh, SID)!;
    expect(Object.values(want.nodes).filter((n) => n.kind === 'text').map((n) => want.details[n.id]?.text)).toEqual(['y']);
    expect(full(store, SID)).toEqual(want);
    p.rebuild();
    expect(full(store, SID)).toEqual(want);
  });

  test('I1: grandchild and orphan subagents: no phantom session; the grandchild hangs off the dispatch in the child thread, in any order', { timeout: 30_000 }, async () => {
    const GRAND = '22222222-3333-4444-8555-666666666666';
    const ORPHAN = '33333333-3333-4444-8555-666666666666';
    const MISSING = '44444444-3333-4444-8555-666666666666';
    const rel = (id: string, f: string): string => `%2Fhome%2Fdev%2Fdemo/${id}/${f}`;
    const childWithDispatch = [
      ...childLines(),
      upd({ sessionUpdate: 'tool_call', toolCallId: 'task_g', kind: 'other', rawInput: { prompt: 'deeper', subagent_type: 'explore' }, _meta: { toolName: 'task' } }, { ts: T0 + 46, meta: { promptId: 'c1' } }),
      upd({ sessionUpdate: 'tool_call_update', toolCallId: 'task_g', status: 'completed', rawOutput: { subagent_id: GRAND } }, { ts: T0 + 48, meta: { promptId: 'c1' } }),
    ];
    const files: [string, string][] = [
      [SUMMARY_REL, summaryJson()],
      [UPDATES_REL, body(mainLines())],
      [CHILD_SUMMARY_REL, childSummary()],
      [CHILD_UPDATES_REL, body(childWithDispatch)],
      [rel(GRAND, 'summary.json'), summaryJson({ id: GRAND, kind: 'subagent', parent: CHILD, title: null })],
      [rel(GRAND, 'updates.jsonl'), body([chunk('user', 'deeper', { ts: T0 + 47, promptId: 'g1' }), chunk('agent', 'nothing', { ts: T0 + 47, promptId: 'g1' })])],
      [rel(ORPHAN, 'summary.json'), summaryJson({ id: ORPHAN, kind: 'subagent', parent: MISSING, title: null })],
      [rel(ORPHAN, 'updates.jsonl'), body([chunk('user', 'lost', { ts: T0 + 5, promptId: 'o1' })])],
    ];
    for (const [r, c] of files) await writeRel(r, c);
    const results = [];
    for (const order of [files.map(([r]) => r), [...files.map(([r]) => r)].reverse()]) {
      const store = open();
      const p = newPipeline(store);
      for (const r of order) await p.ingestFile(abs(r));
      await p.idle();
      expect(p.ingestFailures()).toEqual([]);
      for (const id of [CHILD, GRAND, ORPHAN, MISSING]) expect(store.getSession(id), id).toBeNull();
      results.push(full(store, SID));
      // A full scan and a rebuild change nothing.
      await p.scanAll();
      await p.idle();
      p.rebuild();
      expect(full(store, SID)).toEqual(results[results.length - 1]);
      for (const id of [CHILD, GRAND, ORPHAN, MISSING]) expect(store.getSession(id), id).toBeNull();
      // The orphan's parent appears: the orphan becomes a thread of it.
      await writeRel(rel(MISSING, 'summary.json'), summaryJson({ id: MISSING, title: 'Found parent' }));
      await writeRel(rel(MISSING, 'updates.jsonl'), body([chunk('user', 'parent prompt', { ts: T0 + 1 })]));
      await p.ingestFile(abs(rel(MISSING, 'summary.json')));
      await p.idle();
      expect(store.getSession(MISSING)).toMatchObject({ title: 'Found parent' });
      expect(store.getGraph(MISSING)!.nodes.map((n) => n.agentId).sort()).toEqual([ORPHAN, null].sort());
      await fs.rm(abs(rel(MISSING, 'summary.json')));
      await fs.rm(abs(rel(MISSING, 'updates.jsonl')));
    }
    expect(results[1]).toEqual(results[0]);
    const v = results[0]!;
    const grandFirst = Object.values(v.nodes).find((n) => n.agentId === GRAND && n.kind === 'prompt')!;
    expect(grandFirst.parentId).toBe(grokNodeId(SID, CHILD, 'call:task_g'));
    expect(v.nodes[grokNodeId(SID, CHILD, 'call:task_g')]).toMatchObject({ kind: 'subagent', childAgentId: GRAND, agentId: CHILD });
  });

  test('M2: summary.json written after updates.jsonl: the session appears as soon as the summary is read', async () => {
    await writeRel(UPDATES_REL, body(exampleLines()));
    const store = open();
    const p = newPipeline(store);
    await p.ingestFile(abs(UPDATES_REL));
    await p.idle();
    expect(store.getSession(SID)).toBeNull();
    await writeRel(SUMMARY_REL, summaryJson());
    await p.ingestFile(abs(SUMMARY_REL));
    await p.idle();
    expect(store.getSession(SID)).toMatchObject({ title: 'Fix failing unit test in parser' });
  });
});
