import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { countedUsageNodes, type GraphEdge, type GraphNode, type GraphSnapshot } from '@agent-canvas/shared';
import { fileSources } from '../src/cli.js';
import { loadConfig, type Config } from '../src/config.js';
import { FilesService } from '../src/files/service.js';
import { deepseekNodeId } from '../src/normalize/deepseek.js';
import { Pipeline } from '../src/pipeline.js';
import { storeStatsSource } from '../src/stats/service.js';
import { openStore, type Store } from '../src/store/store.js';
import {
  appendBatch,
  CHILD,
  CWD,
  DshLog,
  exampleChild,
  exampleGrandchild,
  exampleMain,
  GRANDCHILD,
  HAS_ZSTD,
  NO_ZSTD_REASON,
  PROJECT,
  SID,
  sessionRel,
  T0,
  writeSession,
} from './deepseek-fixtures.js';

// Pipeline + store on temp directories: a dsh home (`<deepseekDir>/sessions/<project key>/<session dir>/session.v4.jsonl.zstd`)
// with a main session, its subagent and the subagent's own subagent.

if (!HAS_ZSTD) console.warn(NO_ZSTD_REASON);

let tmp: string;
let config: Config;
let home: string;
const stores: Store[] = [];
const pipelines: Pipeline[] = [];

const abs = (rel: string): string => path.join(home, 'sessions', ...rel.split('/'));
const open = (): Store => {
  const s = openStore(':memory:');
  stores.push(s);
  return s;
};
const cfg = (dir: string | null): Config =>
  loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, cursorDbPath: null, geminiDir: null, grokDir: null, copilotDir: null, deepseekDir: dir, workbuddyDirs: [], codebuddyDir: null, doubaoDirs: [] });
const newPipeline = (store: Store, c: Config = config): Pipeline => {
  const p = new Pipeline(store, c, { sources: fileSources(c, store, { zstd: true }) });
  pipelines.push(p);
  return p;
};
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

const MAIN = sessionRel(SID);
const CHILD_REL = sessionRel(CHILD);
const GRAND_REL = sessionRel(GRANDCHILD);
const files = (): [string, { header: string; lines: string[] }][] => [
  [MAIN, exampleMain()],
  [CHILD_REL, exampleChild()],
  [GRAND_REL, exampleGrandchild()],
];
/** Each file written whole: the header frame, then the rows in batches of 5 frames' worth. */
async function writeAll(): Promise<void> {
  for (const [rel, f] of files()) {
    const batches: string[][] = [];
    for (let i = 0; i < f.lines.length; i += 5) batches.push(f.lines.slice(i, i + 5));
    await writeSession(abs(rel), f.header, batches);
  }
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-dsh-e2e-'));
  home = path.join(tmp, '.dsh');
  await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
  config = cfg(home);
});
afterEach(async () => {
  for (const p of pipelines.splice(0)) {
    await p.close();
    await p.idle();
  }
  for (const s of stores.splice(0)) s.close();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

describe.skipIf(!HAS_ZSTD)('DeepSeek Harness end to end', () => {
  test('one-shot ingest = frame-by-frame appended ingest = rebuild from raw events; restart re-ingests nothing', { timeout: 60_000 }, async () => {
    await writeAll();
    const s1 = open();
    const p1 = newPipeline(s1);
    await p1.scanAll();
    await p1.idle();
    expect(p1.ingestFailures()).toEqual([]);
    expect(s1.diagnostics().unknownRecords).toEqual([]);
    const oneShot = full(s1, SID)!;
    expect(oneShot.session).toMatchObject({ origin: 'deepseek', projectId: PROJECT, cwd: 'D:\\Projects\\Demo\\packages\\api', title: 'Fix the parser test', startedAt: new Date(T0).toISOString() });
    for (const id of [CHILD, GRANDCHILD]) expect(s1.getSession(id), id).toBeNull(); // threads of the root, not sessions
    // The session's cwd moved (working-directory/change): the project keeps its id; its cwd comes only from sessions whose cwd encodes to it.
    expect(s1.listProjects(Date.now()).map((x) => [x.id, x.origins])).toEqual([[PROJECT, ['deepseek']]]);
    const SUB = deepseekNodeId(SID, null, 'call:2.1.call_00_s');
    const DEEP = deepseekNodeId(SID, CHILD, 'call:1.1.call_00_g');
    expect(oneShot.nodes[SUB]).toMatchObject({ kind: 'subagent', childAgentId: CHILD });
    expect(oneShot.nodes[DEEP]).toMatchObject({ kind: 'subagent', childAgentId: GRANDCHILD });
    expect(Object.values(oneShot.nodes).find((n) => n.agentId === GRANDCHILD && n.kind === 'prompt')!.parentId).toBe(DEEP);
    // Usage: on exactly one node per assistant message, every one counted.
    const withUsage = Object.values(oneShot.nodes).filter((n) => n.usage !== null);
    expect(withUsage.map((n) => n.messageId).sort()).toEqual(['cmsg-1', 'cmsg-2', 'gmsg-1', 'msg-1', 'msg-2', 'msg-3', 'msg-4']);
    expect(countedUsageNodes(Object.values(oneShot.nodes))).toHaveLength(withUsage.length);

    // Frame by frame, child and grandchild first (their lines arrive before the root's rows).
    for (const [rel] of files()) await fs.rm(abs(rel));
    const s2 = open();
    const p2 = newPipeline(s2);
    const ordered = [files()[2]!, files()[1]!, files()[0]!];
    // The root header must exist for a child to be placed: write every header first.
    for (const [rel, f] of ordered) await writeSession(abs(rel), f.header);
    for (const [rel, f] of ordered) {
      for (const line of f.lines) {
        await appendBatch(abs(rel), [line]);
        await p2.ingestFile(abs(rel));
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

  test('Review Focus 3: subagent files ingested before the root file and after it give the same graph', { timeout: 30_000 }, async () => {
    await writeAll();
    const after = open();
    const pa = newPipeline(after);
    for (const rel of [MAIN, CHILD_REL, GRAND_REL]) await pa.ingestFile(abs(rel));
    await pa.idle();
    const before = open();
    const pb = newPipeline(before);
    for (const rel of [GRAND_REL, CHILD_REL, MAIN]) await pb.ingestFile(abs(rel));
    await pb.idle();
    expect(pa.ingestFailures()).toEqual([]);
    expect(pb.ingestFailures()).toEqual([]);
    const want = full(after, SID)!;
    expect(full(before, SID)).toEqual(want);
    pb.rebuild();
    expect(full(before, SID)).toEqual(want);
  });

  test('Review Focus 1: a rewritten main file (truncated, re-appended with other rows) removes the stale nodes everywhere, live and after rebuild', { timeout: 30_000 }, async () => {
    await writeAll();
    const store = open();
    const p = newPipeline(store);
    await p.scanAll();
    await p.idle();
    const searchHits = (q: string): string[] => store.searchContent(q, { nowMs: Date.parse('2026-11-17T00:00:00Z'), timeBudgetMs: 60_000 }).hits.map((h) => h.nodeId);
    const filesOf = async (): Promise<string> => JSON.stringify(await new FilesService(storeStatsSource(store)).session(SID));
    expect(await filesOf()).toContain('D:/Projects/Demo/src/parser.ts');

    // Rewritten: same header, one turn of different content (not shorter than the old byte offset is not required here).
    const l = new DshLog();
    l.turnStart(1);
    l.user('Something else entirely');
    l.assistant(1, 1, [{ type: 'text', text: 'Different reply.' }], { id: 'new-1' });
    l.turnEnd(1);
    await writeSession(abs(MAIN), exampleMain().header, [l.lines]);
    await p.ingestFile(abs(MAIN));
    await p.idle();
    expect(p.ingestFailures()).toEqual([]);

    const fresh = open();
    const pf = newPipeline(fresh);
    await pf.scanAll();
    await pf.idle();
    const want = full(fresh, SID)!;
    const check = async (): Promise<void> => {
      expect(full(store, SID)).toEqual(want);
      const main = Object.values(want.nodes).filter((n) => n.agentId === null);
      expect(main.map((n) => n.kind)).toEqual(['prompt', 'text']);
      expect(want.session.title).toBe('Something else entirely');
      expect(searchHits('Running')).toEqual([]);
      expect(await filesOf()).not.toContain('parser.ts');
    };
    await check();
    p.rebuild();
    while (store.searchIndexBatch(10_000, 10_000_000).more);
    await check();
  });

  test('no phantom sessions: a subagent whose root is missing makes nothing until the root appears', { timeout: 30_000 }, async () => {
    const c = exampleChild();
    await writeSession(abs(CHILD_REL), c.header, [c.lines]);
    const store = open();
    const p = newPipeline(store);
    await p.scanAll();
    await p.idle();
    expect(store.getSession(CHILD)).toBeNull();
    expect(store.getSession(SID)).toBeNull();
    expect(store.listProjects(Date.now())).toEqual([]);
    const m = exampleMain();
    await writeSession(abs(MAIN), m.header, [m.lines]);
    await p.scanAll();
    await p.idle();
    expect(store.getSession(SID)).toMatchObject({ title: 'Fix the parser test' });
    expect(store.getSession(CHILD)).toBeNull();
    expect(store.getGraph(SID)!.nodes.find((n) => n.agentId === CHILD && n.kind === 'prompt')!.parentId).toBe(deepseekNodeId(SID, null, 'call:2.1.call_00_s'));
  });
});
