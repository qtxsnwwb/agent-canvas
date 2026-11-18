import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { GraphEdge, GraphNode, GraphSnapshot } from '@agent-canvas/shared';
import { fileSources } from '../src/cli.js';
import { loadConfig, type Config } from '../src/config.js';
import { FilesService } from '../src/files/service.js';
import { geminiNodeId } from '../src/normalize/gemini.js';
import { Pipeline } from '../src/pipeline.js';
import { GeminiFileSource } from '../src/sources/gemini/source.js';
import { storeStatsSource } from '../src/stats/service.js';
import { openStore, type Store } from '../src/store/store.js';
import { CALL_READ, dispatchMsg, exampleLines, legacyJson, M1, M2, m2, m3, m4, m5, MAIN_REL, metaLine, SID, SUB_ID, SUB_REL, subagentLines, userMsg } from './gemini-fixtures.js';

// Pipeline + store on temp directories: a Gemini CLI root with one project directory (`.project_root` naming its
// working directory), a main session with a subagent, and a legacy `.json` session.

let tmp: string;
let config: Config;
let gemTmp: string;
const stores: Store[] = [];
const CWD = '/home/dev/demo-app';
const PROJECT = '-home-dev-demo-app';
const LEGACY_SID = '7e7e7e7e-0000-4000-8000-000000000001';
const LEGACY_REL = 'demo-app/chats/session-2026-11-10T08-00-7e7e7e7e.json';

const abs = (rel: string): string => path.join(gemTmp, ...rel.split('/'));
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
const newPipeline = (store: Store): Pipeline => new Pipeline(store, config, { sources: fileSources(config, store) });
/** Graph (nodes by id), edges by id and the session: comparable across arrival orders and rebuilds. */
function view(store: Store, sessionId: string) {
  const g: GraphSnapshot | null = store.getGraph(sessionId);
  if (g === null) return null;
  const nodes: Record<string, GraphNode> = Object.fromEntries([...g.nodes].sort((a, b) => a.id.localeCompare(b.id)).map((n) => [n.id, n]));
  const edges: Record<string, GraphEdge> = Object.fromEntries([...g.edges].sort((a, b) => a.id.localeCompare(b.id)).map((e) => [e.id, e]));
  return { session: g.session, nodes, edges };
}
const mainLines = (): string[] => [...exampleLines(), JSON.stringify(dispatchMsg())];

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-gemini-e2e-'));
  const geminiDir = path.join(tmp, '.gemini');
  gemTmp = path.join(geminiDir, 'tmp');
  await fs.mkdir(gemTmp, { recursive: true });
  config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, grokDir: null, copilotDir: null, deepseekDir: null, workbuddyDirs: [], codebuddyDir: null, doubaoDirs: [], qwenDir: null, geminiDir });
  await writeRel('demo-app/.project_root', CWD);
});
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

describe('Gemini CLI end to end', () => {
  test('fileSources: a GeminiFileSource only when <geminiDir>/tmp exists; nothing is created on disk otherwise', async () => {
    expect(fileSources(config).some((s) => s instanceof GeminiFileSource)).toBe(true);
    const noTmp = path.join(tmp, 'empty-gemini');
    await fs.mkdir(noTmp);
    const c2 = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, grokDir: null, copilotDir: null, deepseekDir: null, workbuddyDirs: [], codebuddyDir: null, doubaoDirs: [], qwenDir: null, geminiDir: noTmp });
    const store = open();
    const p = new Pipeline(store, c2, { sources: fileSources(c2, store) });
    expect(p.fileSources().map((s) => s.origin)).toEqual(['claude']);
    await p.scanAll();
    await p.idle();
    expect(await fs.readdir(noTmp)).toEqual([]);
    const c3 = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, grokDir: null, copilotDir: null, deepseekDir: null, workbuddyDirs: [], codebuddyDir: null, doubaoDirs: [], qwenDir: null, geminiDir: null });
    expect(fileSources(c3).map((s) => s.origin)).toEqual(['claude']);
  });

  test('one-shot ingest = line-by-line appended ingest = rebuild from raw events; restart re-ingests nothing', async () => {
    await writeRel(MAIN_REL, body(mainLines()));
    await writeRel(SUB_REL, body(subagentLines()));
    const s1 = open();
    const p1 = newPipeline(s1);
    await p1.scanAll();
    await p1.idle();
    expect(p1.ingestFailures()).toEqual([]);
    expect(s1.diagnostics().unknownRecords).toEqual([]);
    const oneShot = view(s1, SID)!;
    expect(oneShot.session).toMatchObject({ origin: 'gemini', projectId: PROJECT, cwd: CWD, title: 'Add --verbose flag to CLI' });
    expect(Object.keys(oneShot.nodes)).toHaveLength(6 + 1 + 2);
    const dispatch = geminiNodeId(SID, null, 'a1e0c3d2-0006-4f00-8000-000000000006', 'call:call_dispatch_0');
    expect(oneShot.nodes[dispatch]).toMatchObject({ kind: 'subagent', childAgentId: SUB_ID });
    expect(oneShot.nodes[geminiNodeId(SID, SUB_ID, 'sub-0001', 'prompt')]).toMatchObject({ parentId: dispatch });
    expect(s1.listProjects(Date.now()).map((x) => [x.id, x.cwd, x.origins])).toEqual([[PROJECT, CWD, ['gemini']]]);

    // Line by line, the main file first, then the subagent's: appended and ingested one line at a time.
    await fs.rm(abs(MAIN_REL));
    await fs.rm(abs(SUB_REL));
    const s2 = open();
    const p2 = newPipeline(s2);
    await p2.scanAll();
    let mainBody = '';
    for (const line of mainLines()) {
      mainBody += `${line}\n`;
      await writeRel(MAIN_REL, mainBody);
      await p2.ingestFile(abs(MAIN_REL));
    }
    let subBody = '';
    for (const line of subagentLines()) {
      subBody += `${line}\n`;
      await writeRel(SUB_REL, subBody);
      await p2.ingestFile(abs(SUB_REL));
    }
    await p2.rescan(); // the project directory's .project_root: placed for the new session
    await p2.idle();
    expect(p2.ingestFailures()).toEqual([]);
    expect(view(s2, SID)).toEqual(oneShot);

    p1.rebuild();
    expect(view(s1, SID)).toEqual(oneShot);
    p2.rebuild();
    expect(view(s2, SID)).toEqual(oneShot);

    const again = newPipeline(s2);
    await again.scanAll();
    await again.idle();
    expect(view(s2, SID)).toEqual(oneShot);
  });

  test('legacy .json written whole twice (a message added): no duplicate nodes; rebuild gives the same', async () => {
    const msgs = (n: number) => [userMsg('L1', 'legacy prompt'), { ...m2(2), id: 'L2' }, { ...m3, id: 'L3' }, { ...m4(), id: 'L4' }, { ...m5, id: 'L5' }].slice(0, n);
    const legacy = (n: number) => legacyJson(msgs(n), { summary: 'Legacy title' }, LEGACY_SID);
    await writeRel(LEGACY_REL, legacy(2));
    const store = open();
    const p = newPipeline(store);
    await p.scanAll();
    await p.idle();
    const first = view(store, LEGACY_SID)!;
    expect(Object.keys(first.nodes)).toHaveLength(4); // prompt, thinking, text, read_file

    await writeRel(LEGACY_REL, legacy(5));
    await p.ingestFile(abs(LEGACY_REL));
    await p.idle();
    const second = view(store, LEGACY_SID)!;
    expect(Object.keys(second.nodes)).toHaveLength(6);
    expect(new Set(Object.values(second.nodes).map((n) => n.id)).size).toBe(6);
    expect(second.session).toMatchObject({ title: 'Legacy title', projectId: PROJECT, cwd: CWD, origin: 'gemini' });
    // The same content again: nothing new stored.
    await p.ingestFile(abs(LEGACY_REL));
    await p.idle();
    expect(view(store, LEGACY_SID)).toEqual(second);
    p.rebuild();
    expect(view(store, LEGACY_SID)).toEqual(second);
  });

  test('no .project_root / projects.json: project gemini:<slug>, cwd unknown, for .jsonl and legacy .json, also after rebuild', async () => {
    await writeRel('hashdir/chats/session-2026-11-16T09-41-3f9c2a1b.jsonl', body(exampleLines()));
    await writeRel('hashdir/chats/session-2026-11-10T08-00-7e7e7e7e.json', legacyJson([userMsg('L1', 'legacy prompt')], {}, LEGACY_SID));
    const store = open();
    const p = newPipeline(store);
    await p.scanAll();
    await p.idle();
    const before = [view(store, SID), view(store, LEGACY_SID)];
    for (const v of before) expect(v!.session).toMatchObject({ projectId: 'gemini:hashdir', cwd: null });
    p.rebuild();
    expect([view(store, SID), view(store, LEGACY_SID)]).toEqual(before);
  });

  test('I4: a launch that writes only metadata and deletes its file again leaves no session behind', async () => {
    await writeRel(MAIN_REL, body([metaLine(), JSON.stringify({ $set: { lastUpdated: '2026-11-16T09:41:08.000Z' } })]));
    const store = open();
    const p = newPipeline(store);
    await p.scanAll();
    await p.idle();
    expect(store.getSession(SID)).toBeNull();
    await fs.rm(abs(MAIN_REL));
    await p.scanAll();
    await p.idle();
    expect(store.getSession(SID)).toBeNull();
    expect(store.listProjects(Date.now())).toEqual([]);
    p.rebuild();
    expect(store.getSession(SID)).toBeNull();
    // In a file that stays, the first message appended makes the session.
    const other = 'demo-app/chats/session-2026-11-16T11-00-3f9c2a1b.jsonl';
    await writeRel(other, body([metaLine()]));
    await p.scanAll();
    await p.idle();
    expect(store.getSession(SID)).toBeNull();
    await fs.appendFile(abs(other), `${JSON.stringify(userMsg(M1, 'now'))}\n`);
    await p.ingestFile(abs(other));
    await p.idle();
    expect(store.getSession(SID)).toMatchObject({ startedAt: '2026-11-16T09:41:07.120Z', title: 'now' });
  });

  test('a rewind removes the node from the graph, the content search and the by-file view (live and after rebuild)', async () => {
    await writeRel(MAIN_REL, body(exampleLines()));
    const store = open();
    const p = newPipeline(store);
    await p.scanAll();
    await p.idle();
    const READ = geminiNodeId(SID, null, M2, `call:${CALL_READ}`);
    const searchHits = (q: string): string[] => store.searchContent(q, { nowMs: Date.parse('2026-11-17T00:00:00Z'), timeBudgetMs: 60_000 }).hits.map((h) => h.nodeId);
    const files = async (): Promise<string> => JSON.stringify(await new FilesService(storeStatsSource(store)).session(SID));
    expect(view(store, SID)!.nodes[READ]).toBeDefined();
    expect(searchHits('parseArgs')).toContain(READ);
    expect(await files()).toContain('/home/dev/demo-app/src/cli.ts');

    await fs.appendFile(abs(MAIN_REL), `${JSON.stringify({ $rewindTo: M2 })}\n`);
    await p.ingestFile(abs(MAIN_REL));
    await p.idle();
    const check = async (): Promise<void> => {
      const v = view(store, SID)!;
      expect(Object.keys(v.nodes)).toEqual([geminiNodeId(SID, null, M1, 'prompt')]);
      expect(Object.keys(v.edges)).toEqual([]);
      expect(store.getNodeDetail(SID, READ)).toBeNull();
      expect(searchHits('parseArgs')).toEqual([]);
      expect(await files()).not.toContain('/home/dev/demo-app/src/cli.ts');
    };
    await check();
    p.rebuild();
    // The rebuild leaves the content index to the background build: index everything now.
    while (store.searchIndexBatch(10_000, 10_000_000).more);
    await check();
  });
});
