import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GraphEdge, GraphNode } from '@agent-canvas/shared';
import { fileSources } from '../src/cli.js';
import { loadConfig, type Config } from '../src/config.js';
import { buddyNodeId } from '../src/normalize/buddy.js';
import { Pipeline } from '../src/pipeline.js';
import { BuddyFileSource, buddyRootsOf, workbuddyProjectDir, BUDDY_HEAD_LINE_MAX, BUDDY_HEAD_MAX_BYTES, type BuddyLookup } from '../src/sources/buddy/source.js';
import { readGuardedLines } from '../src/sources/guarded-reader.js';
import { readBuddyLines } from '../src/sources/buddy/line-guard.js';
import type { SourceRead } from '../src/sources/source.js';
import { openStore, type Store } from '../src/store/store.js';
import { Chain, CHILD, CWD, exampleChild, exampleMain, GRANDCHILD, sessionMeta, SID, T0, topicRecord } from './buddy-fixtures.js';

// BuddyFileSource (WorkBuddy, CodeBuddy Code): which files under each `<root>/projects` are sessions and subagent
// threads, which project each belongs to, and how two roots of one origin share a store. Temp directories only.

const SID2 = 'a1b2c3d4-0000-4000-8000-000000000002';
const SID3 = 'a1b2c3d4-0000-4000-8000-000000000003';
/** The engine's project directory name of CWD (format reference 1.3); the source never decodes it. */
const PROJ = 'home-dev-repo';
/** Project id of CWD (Claude Code's encoding, as every source uses). */
const PROJECT_ID = '-home-dev-repo';

let tmp: string;
let wb: string;
let wbAi: string;
let cb: string;
const stores: Store[] = [];
const pipelines: Pipeline[] = [];

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-buddy-source-'));
  wb = path.join(tmp, '.workbuddy');
  wbAi = path.join(tmp, '.workbuddy-ai');
  cb = path.join(tmp, '.codebuddy');
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of pipelines.splice(0)) {
    await p.close();
    await p.idle();
  }
  for (const s of stores.splice(0)) s.close();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

const body = (lines: readonly string[]): string => lines.map((l) => `${l}\n`).join('');
async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}
const mainAt = (root: string, sid: string, proj = PROJ): string => path.join(root, 'projects', proj, `${sid}.jsonl`);
const agentAt = (root: string, parent: string, agent: string, proj = PROJ): string => path.join(root, 'projects', proj, parent, 'subagents', `${agent}.jsonl`);
const cfg = (o: { workbuddyDirs?: string[]; codebuddyDir?: string | null } = {}): Config =>
  loadConfig({}, {
    projectsDir: path.join(tmp, 'claude-projects'),
    dataDir: path.join(tmp, 'data'),
    codexSessionsDir: null,
    cursorDbPath: null,
    geminiDir: null,
    grokDir: null,
    copilotDir: null,
    deepseekDir: null,
    workbuddyDirs: o.workbuddyDirs ?? [wb, wbAi],
    codebuddyDir: o.codebuddyDir === undefined ? cb : o.codebuddyDir,
    doubaoDirs: [],
  });
const open = (): Store => {
  const s = openStore(':memory:');
  stores.push(s);
  return s;
};
const newPipeline = (store: Store, c: Config): Pipeline => {
  const p = new Pipeline(store, c, { sources: fileSources(c, store) });
  pipelines.push(p);
  return p;
};
async function ingestAll(c: Config, store: Store = open()): Promise<{ store: Store; pipeline: Pipeline }> {
  const pipeline = newPipeline(store, c);
  await pipeline.scanAll();
  await pipeline.idle();
  expect(pipeline.ingestFailures()).toEqual([]);
  return { store, pipeline };
}
const buddyOf = (p: Pipeline, origin: 'workbuddy' | 'codebuddy'): BuddyFileSource => p.fileSources().find((s) => s.origin === origin) as BuddyFileSource;
function view(store: Store, sid: string) {
  const g = store.getGraph(sid);
  if (g === null) return null;
  const nodes: Record<string, GraphNode> = Object.fromEntries([...g.nodes].sort((a, b) => a.id.localeCompare(b.id)).map((n) => [n.id, n]));
  const edges: Record<string, GraphEdge> = Object.fromEntries([...g.edges].sort((a, b) => a.id.localeCompare(b.id)).map((e) => [e.id, e]));
  const details = Object.fromEntries(Object.keys(nodes).map((id) => [id, store.getNodeDetail(sid, id)]));
  return { session: g.session, nodes, edges, details };
}
/** Index of the line whose entry id is `id`. */
const indexOfId = (lines: readonly string[], id: string): number => lines.findIndex((l) => (JSON.parse(l) as { id?: string }).id === id);
/** Byte offset of line `i` of `lines` in a file written by `body`. */
const offsetOf = (lines: readonly string[], i: number): number => lines.slice(0, i).reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);

describe('roots, labels and keys', () => {
  test('labels: the tool directory name without leading dots, unique in configured order; empty entries skipped', () => {
    expect(buddyRootsOf([wb, wbAi])).toEqual([
      { label: 'workbuddy', dir: wb },
      { label: 'workbuddy-ai', dir: wbAi },
    ]);
    expect(buddyRootsOf([cb])).toEqual([{ label: 'codebuddy', dir: cb }]);
    expect(buddyRootsOf([null, ''])).toEqual([]);
    const a = path.join(tmp, 'x', '.wb');
    const b = path.join(tmp, 'y', '.wb');
    const roots = buddyRootsOf([a, b]);
    expect(roots.map((r) => r.dir)).toEqual([a, b]);
    expect(new Set(roots.map((r) => r.label)).size).toBe(2);
    for (const r of roots) expect(r.label).toMatch(/^[^\\/:]+$/);
  });

  test('origin, roots, depth, line identity, reader', async () => {
    await fs.mkdir(path.join(wb, 'projects'), { recursive: true });
    await fs.mkdir(path.join(wbAi, 'projects'), { recursive: true });
    const s = new BuddyFileSource('workbuddy', buddyRootsOf([wb, wbAi]));
    expect(s.origin).toBe('workbuddy');
    expect(s.rootDir).toBe(path.join(wb, 'projects'));
    expect(s.watchDepth).toBe(3);
    expect(s.watchRoots).toEqual([
      { dir: path.join(wb, 'projects'), depth: 3 },
      { dir: path.join(wbAi, 'projects'), depth: 3 },
    ]);
    expect(s.lineIdentity).toBe('offset');
    expect(s.readLines).toBe(readBuddyLines);
    expect(new BuddyFileSource('codebuddy', buddyRootsOf([cb])).origin).toBe('codebuddy');
  });

  test('keys carry the root label: the same relative path under two roots gives two keys, each back to its own file', () => {
    const s = new BuddyFileSource('workbuddy', buddyRootsOf([wb, wbAi]));
    const a = s.keyOf(mainAt(wb, SID));
    const b = s.keyOf(mainAt(wbAi, SID));
    expect(a).toBe(`workbuddy:workbuddy/${PROJ}/${SID}.jsonl`);
    expect(b).toBe(`workbuddy:workbuddy-ai/${PROJ}/${SID}.jsonl`);
    expect(s.pathOf(a!)).toBe(mainAt(wb, SID));
    expect(s.pathOf(b!)).toBe(mainAt(wbAi, SID));
    const child = s.keyOf(agentAt(wbAi, SID, CHILD));
    expect(child).toBe(`workbuddy:workbuddy-ai/${PROJ}/${SID}/subagents/${CHILD}.jsonl`);
    expect(s.pathOf(child!)).toBe(agentAt(wbAi, SID, CHILD));
    const nested = s.keyOf(agentAt(wb, CHILD, GRANDCHILD));
    expect(nested).toBe(`workbuddy:workbuddy/${PROJ}/${CHILD}/subagents/${GRANDCHILD}.jsonl`);
    expect(s.pathOf('workbuddy:other/x/y.jsonl')).toBeNull();
    expect(s.pathOf(`codebuddy:workbuddy/${PROJ}/${SID}.jsonl`)).toBeNull();
  });

  test('only <project>/<uuid>.jsonl and <project>/<uuid or agent stem>/subagents/agent-*.jsonl are files of the source', () => {
    const s = new BuddyFileSource('workbuddy', buddyRootsOf([wb, wbAi]));
    const p = (...parts: string[]): string => path.join(wb, 'projects', ...parts);
    for (const other of [
      p(PROJ, `${SID}.meta.json`),
      p(PROJ, SID, 'subagents', `${CHILD}.meta.json`),
      p(PROJ, SID, 'subagents', 'helper.jsonl'), // not an agent store id
      p(PROJ, SID, 'tool-results', 'out-1.txt'),
      p(PROJ, SID, 'tool-results', `${CHILD}.jsonl`),
      p(PROJ, 'not-a-session', 'subagents', `${CHILD}.jsonl`),
      p(PROJ, 'notes.jsonl'),
      p(PROJ, `.${SID}.jsonl`), // a tombstone-like name: not a UUID
      p(PROJ, `${SID}.deleted.jsonl`),
      p(PROJ, `${SID}.jsonl.tmp`),
      p(PROJ, `${CHILD}.jsonl`), // a store id at project level is not a session
      p(PROJ, SID, 'subagents', CHILD, `${GRANDCHILD}.jsonl`),
      p(`${SID}.jsonl`),
      p(PROJ, SID, `${CHILD}.jsonl`),
      path.join(wb, 'workbuddy.db'),
      path.join(wb, 'traces', `${SID}.jsonl`),
      path.join(wb, `${SID}.jsonl`),
      path.join(tmp, `${SID}.jsonl`),
    ]) {
      expect(s.keyOf(other), other).toBeNull();
    }
  });

  test('listing: sessions and subagent threads of every root; sidecars, tool results, tombstones, the database and traces are not listed nor opened', async () => {
    const lines = exampleMain().lines;
    await write(mainAt(wb, SID), body(lines));
    await write(agentAt(wb, SID, CHILD), body(exampleChild().lines));
    await write(agentAt(wb, CHILD, GRANDCHILD), body(exampleChild().lines));
    await write(mainAt(wbAi, SID2), body(lines));
    await write(path.join(wb, 'projects', PROJ, `${SID}.meta.json`), '{"title":"x"}');
    await write(path.join(wb, 'projects', PROJ, SID, 'subagents', `${CHILD}.meta.json`), '{}');
    await write(path.join(wb, 'projects', PROJ, SID, 'tool-results', 'big.txt'), 'x');
    await write(path.join(wb, 'projects', PROJ, `.${SID3}.jsonl`), body(lines));
    await write(path.join(wb, 'workbuddy.db'), 'SQLite format 3\u0000');
    await write(path.join(wb, 'traces', `${SID}.jsonl`), body(lines));
    const s = new BuddyFileSource('workbuddy', buddyRootsOf([wb, wbAi]));
    expect(await s.listFiles()).toEqual([mainAt(wb, SID), agentAt(wb, CHILD, GRANDCHILD), agentAt(wb, SID, CHILD), mainAt(wbAi, SID2)].sort());

    const opened: string[] = [];
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(((p: Parameters<typeof fs.open>[0], ...rest: unknown[]) => {
      opened.push(String(p));
      return (realOpen as (...a: unknown[]) => ReturnType<typeof fs.open>)(p, ...rest);
    }) as typeof fs.open);
    const c = cfg();
    await ingestAll(c);
    expect(opened.length).toBeGreaterThan(0);
    for (const f of opened) expect(f, f).not.toMatch(/workbuddy\.db|[\\/]traces[\\/]|\.meta\.json|tool-results|[\\/]\.a1b2/);
  });
});

describe('three roots, two origins (spec 4.1)', () => {
  test('the same session lines under the two WorkBuddy roots and the CodeBuddy root give workbuddy / workbuddy / codebuddy', async () => {
    const lines = exampleMain().lines;
    await write(mainAt(wb, SID), body(lines));
    await write(mainAt(wbAi, SID2), body(lines));
    await write(mainAt(cb, SID3), body(lines));
    const { store, pipeline } = await ingestAll(cfg());
    expect(pipeline.fileSources().map((s) => s.origin)).toEqual(['claude', 'workbuddy', 'codebuddy']);
    expect(store.getSession(SID)).toMatchObject({ origin: 'workbuddy', projectId: PROJECT_ID, cwd: CWD, title: 'Fix failing fixture test' });
    expect(store.getSession(SID2)).toMatchObject({ origin: 'workbuddy', projectId: PROJECT_ID });
    expect(store.getSession(SID3)).toMatchObject({ origin: 'codebuddy', projectId: PROJECT_ID });
    // Each one's graph is the same apart from the session id in its node ids.
    const strip = (sid: string) => Object.keys(view(store, sid)!.nodes).map((id) => id.replace(sid, 'S'));
    expect(strip(SID2)).toEqual(strip(SID));
    expect(strip(SID3)).toEqual(strip(SID));
    expect(store.listProjects(Date.now()).map((p) => [p.id, p.origins])).toEqual([[PROJECT_ID, ['workbuddy', 'codebuddy']]]);
  });

  test('an override directory is one root: one WorkBuddy source with that root only', async () => {
    const custom = path.join(tmp, 'custom-wb');
    await write(mainAt(custom, SID), body(exampleMain().lines));
    await write(mainAt(wb, SID2), body(exampleMain().lines)); // the default root, not configured now
    const { store, pipeline } = await ingestAll(cfg({ workbuddyDirs: [custom], codebuddyDir: null }));
    const s = buddyOf(pipeline, 'workbuddy');
    expect(s.watchRoots).toEqual([{ dir: path.join(custom, 'projects'), depth: 3 }]);
    expect(store.getSession(SID)).toMatchObject({ origin: 'workbuddy' });
    expect(store.getSession(SID2)).toBeNull();
    expect(pipeline.fileSources().map((x) => x.origin)).toEqual(['claude', 'workbuddy']);
  });

  test('missing roots: no source, nothing created; with one root present only that root is held', async () => {
    const c = cfg();
    expect(fileSources(c).map((s) => s.origin)).toEqual(['claude']);
    await ingestAll(c);
    for (const d of [wb, wbAi, cb]) await expect(fs.stat(d)).rejects.toThrow();

    await write(mainAt(wbAi, SID), body(exampleMain().lines));
    await fs.mkdir(wb); // the tool directory exists, its projects directory does not
    const { store, pipeline } = await ingestAll(c);
    const s = buddyOf(pipeline, 'workbuddy');
    expect(s.watchRoots).toEqual([{ dir: path.join(wbAi, 'projects'), depth: 3 }]);
    expect(store.getSession(SID)).toMatchObject({ origin: 'workbuddy' });
    expect(await fs.readdir(wb)).toEqual([]);
    await expect(fs.stat(cb)).rejects.toThrow();
    // A source handed a root that does not exist lists nothing, watches nothing, creates nothing.
    const ghost = path.join(tmp, '.ghost');
    const g = new BuddyFileSource('codebuddy', buddyRootsOf([ghost]));
    expect(await g.listFiles()).toEqual([]);
    expect(g.watchRoots).toEqual([]);
    expect(await g.classify(`codebuddy:ghost/${PROJ}/${SID}.jsonl`)).toBeNull();
    await expect(fs.stat(ghost)).rejects.toThrow();
  });
});

describe('the same session under two WorkBuddy roots', () => {
  test('the first read wins, the other copy (and its subagents) is skipped and counted', async () => {
    const main = exampleMain();
    const other = new Chain();
    other.prompt('a different copy');
    other.reply('copy', 'resp-z');
    // `.workbuddy-ai/…` sorts before `.workbuddy/…`, so the full scan reads that copy first.
    await write(mainAt(wbAi, SID), body(main.lines));
    await write(mainAt(wb, SID), body(other.lines));
    await write(agentAt(wb, SID, CHILD), body(exampleChild().lines));
    const { store, pipeline } = await ingestAll(cfg({ codebuddyDir: null }));
    const s = buddyOf(pipeline, 'workbuddy');
    expect(s.status()).toEqual({ duplicateSessions: 1 });
    expect(store.getSession(SID)).toMatchObject({ origin: 'workbuddy', title: 'Fix failing fixture test' });
    const nodes = Object.values(view(store, SID)!.nodes);
    expect(nodes.some((n) => n.agentId === CHILD)).toBe(false);
    expect(nodes.some((n) => JSON.stringify(n).includes('a different copy'))).toBe(false);
    expect(await s.classify(`workbuddy:workbuddy/${PROJ}/${SID}.jsonl`)).toBeNull();
    expect(await s.classify(`workbuddy:workbuddy/${PROJ}/${SID}/subagents/${CHILD}.jsonl`)).toBeNull();
    expect(s.mainSessionOf(`workbuddy:workbuddy/${PROJ}/${SID}.jsonl`)).toBeNull();
    expect(s.mainSessionOf(`workbuddy:workbuddy-ai/${PROJ}/${SID}.jsonl`)).toBe(SID);
    // Counted once however often the copy is asked about.
    await pipeline.scanAll();
    await pipeline.idle();
    expect(s.status()).toEqual({ duplicateSessions: 1 });
    // Diagnostics: only the count; the server lists the configured roots itself.
    expect((s.status() as { dirs?: unknown }).dirs).toBeUndefined();
  });

  test('a copy already stored wins after a restart, even when the other root lists first', async () => {
    const main = exampleMain();
    await write(mainAt(wb, SID), body(main.lines));
    const store = open();
    await ingestAll(cfg({ workbuddyDirs: [wb], codebuddyDir: null }), store);
    const before = view(store, SID)!;
    expect(before.session.origin).toBe('workbuddy');
    // Now the other root (listed first) has a copy too, with another history, and both roots are configured.
    const other = new Chain();
    other.prompt('a different copy');
    await write(mainAt(wbAi, SID), body(other.lines));
    const { pipeline } = await ingestAll(cfg({ codebuddyDir: null }), store);
    expect(buddyOf(pipeline, 'workbuddy').status()).toEqual({ duplicateSessions: 1 });
    expect(view(store, SID)).toEqual(before);
  });

  /** The graph of `lines` read once from a fresh store, under a WorkBuddy root of its own. */
  async function freshWb(lines: string[]): Promise<ReturnType<typeof view>> {
    const root = path.join(await fs.mkdtemp(path.join(tmp, 'fresh-')), '.workbuddy');
    await write(mainAt(root, SID), body(lines));
    const { store } = await ingestAll(cfg({ workbuddyDirs: [root], codebuddyDir: null }));
    return view(store, SID);
  }
  /** A turn appended after the example session's last reply. */
  function moreTurn(): string[] {
    const more = new Chain({ prefix: 'n', t0: T0 + 100_000 }).at(exampleMain().ids.a2!);
    more.prompt('one more thing');
    more.reply('Done, one more.', 'resp-n');
    return more.lines;
  }

  test('a session file moved to the other root while running is taken over there: appended turns appear, not flagged deleted, nothing duplicated', async () => {
    const main = exampleMain();
    await write(mainAt(wb, SID), body(main.lines));
    await fs.mkdir(path.join(wbAi, 'projects'), { recursive: true });
    const { store, pipeline } = await ingestAll(cfg({ codebuddyDir: null }));
    const s = buddyOf(pipeline, 'workbuddy');
    expect(s.status()).toEqual({ duplicateSessions: 0 });
    // The upgrade moves the file to the other root; the tool then appends a turn there.
    await fs.mkdir(path.dirname(mainAt(wbAi, SID)), { recursive: true });
    await fs.rename(mainAt(wb, SID), mainAt(wbAi, SID));
    const turn = moreTurn();
    await fs.appendFile(mainAt(wbAi, SID), body(turn));
    await pipeline.scanAll();
    await pipeline.idle();
    expect(pipeline.ingestFailures()).toEqual([]);
    expect(store.getSession(SID)).toMatchObject({ origin: 'workbuddy', sourceDeleted: false });
    expect(store.listProjects(Date.now()).flatMap((p) => store.listSessions(p.id)).map((x) => x.id)).toEqual([SID]);
    const after = view(store, SID)!;
    const expected = (await freshWb([...main.lines, ...turn]))!;
    expect(after.nodes).toEqual(expected.nodes);
    expect(after.edges).toEqual(expected.edges);
    expect(JSON.stringify(after.nodes)).toContain('one more thing');
    expect(s.status()).toEqual({ duplicateSessions: 0 });
    expect(s.mainSessionOf(`workbuddy:workbuddy-ai/${PROJ}/${SID}.jsonl`)).toBe(SID);
    expect(s.mainSessionOf(`workbuddy:workbuddy/${PROJ}/${SID}.jsonl`)).toBeNull();
  });

  test('both copies present: the stored one wins across restarts; when it vanishes the other copy takes over without a restart', async () => {
    const main = exampleMain();
    await write(mainAt(wb, SID), body(main.lines));
    const store = open();
    await ingestAll(cfg({ workbuddyDirs: [wb], codebuddyDir: null }), store);
    await write(mainAt(wbAi, SID), body(main.lines)); // an identical copy under the other root (listed first)
    const first = await ingestAll(cfg({ codebuddyDir: null }), store);
    expect(buddyOf(first.pipeline, 'workbuddy').status()).toEqual({ duplicateSessions: 1 });
    expect(buddyOf(first.pipeline, 'workbuddy').mainSessionOf(`workbuddy:workbuddy/${PROJ}/${SID}.jsonl`)).toBe(SID);
    const before = view(store, SID)!;
    const { pipeline } = await ingestAll(cfg({ codebuddyDir: null }), store); // restart, both still present
    const s = buddyOf(pipeline, 'workbuddy');
    expect(s.status()).toEqual({ duplicateSessions: 1 });
    expect(s.mainSessionOf(`workbuddy:workbuddy/${PROJ}/${SID}.jsonl`)).toBe(SID);
    expect(view(store, SID)).toEqual(before);
    // The winning file goes away; the other copy gets a new turn.
    await fs.rm(mainAt(wb, SID));
    const turn = moreTurn();
    await fs.appendFile(mainAt(wbAi, SID), body(turn));
    await pipeline.scanAll();
    await pipeline.idle();
    expect(pipeline.ingestFailures()).toEqual([]);
    expect(store.getSession(SID)).toMatchObject({ sourceDeleted: false });
    const expected = (await freshWb([...main.lines, ...turn]))!;
    expect(view(store, SID)!.nodes).toEqual(expected.nodes);
    expect(view(store, SID)!.edges).toEqual(expected.edges);
    expect(s.status()).toEqual({ duplicateSessions: 0 });
    // A further turn on the new holder is read through a change event as usual.
    const again = new Chain({ prefix: 'q', t0: T0 + 200_000 }).at('n-2'); // after moreTurn's reply
    again.prompt('and another');
    await fs.appendFile(mainAt(wbAi, SID), body(again.lines));
    await pipeline.ingestFile(mainAt(wbAi, SID));
    await pipeline.idle();
    expect(JSON.stringify(view(store, SID)!.nodes)).toContain('and another');
  });
});

describe('classification', () => {
  async function source(): Promise<BuddyFileSource> {
    const s = new BuddyFileSource('codebuddy', buddyRootsOf([cb]));
    await s.listFiles();
    return s;
  }
  const k = (rel: string): string => `codebuddy:codebuddy/${PROJ}/${rel}`;

  test('a session file, its subagent, and a nested subagent (resolved to the root session)', async () => {
    await write(mainAt(cb, SID), body(exampleMain().lines));
    await write(agentAt(cb, SID, CHILD), body(exampleChild().lines));
    await write(agentAt(cb, CHILD, GRANDCHILD), body(exampleChild().lines));
    const s = await source();
    expect(await s.classify(k(`${SID}.jsonl`))).toEqual({ kind: 'session', projectId: PROJECT_ID, sessionId: SID });
    expect(await s.classify(k(`${SID}/subagents/${CHILD}.jsonl`))).toEqual({ kind: 'agent', projectId: PROJECT_ID, sessionId: SID, agentId: CHILD });
    expect(await s.classify(k(`${CHILD}/subagents/${GRANDCHILD}.jsonl`))).toEqual({ kind: 'agent', projectId: PROJECT_ID, sessionId: SID, agentId: GRANDCHILD });
    expect(s.mainSessionOf(k(`${SID}.jsonl`))).toBe(SID);
    expect(s.mainSessionOf(k(`${SID}/subagents/${CHILD}.jsonl`))).toBeNull();
    expect(s.projectOfKey(k(`${SID}.jsonl`))).toBeNull();
    expect(s.projectOfTranscript(mainAt(cb, SID))).toBe(PROJECT_ID);
  });

  test('a subagent takes its root session project whatever its own cwd says; it waits while the root has none', async () => {
    const child = new Chain({ prefix: 'c', sessionId: 'rt', cwd: '/elsewhere' });
    child.user('Review', { isMeta: true });
    await write(agentAt(cb, SID, CHILD), body(child.lines));
    const s = await source();
    expect(await s.classify(k(`${SID}/subagents/${CHILD}.jsonl`))).toBeNull(); // no main file yet
    await write(mainAt(cb, SID), body([sessionMeta({}, { id: 'm' })]));
    expect(await s.classify(k(`${SID}/subagents/${CHILD}.jsonl`))).toBeNull(); // main has no cwd yet
    await fs.appendFile(mainAt(cb, SID), body(exampleMain().lines.slice(1)));
    expect(await s.classify(k(`${SID}/subagents/${CHILD}.jsonl`))).toEqual({ kind: 'agent', projectId: PROJECT_ID, sessionId: SID, agentId: CHILD });
  });

  test('a nested subagent under an agent stem not seen yet is not classified until the listing finds the stem', async () => {
    await write(mainAt(cb, SID), body(exampleMain().lines));
    await write(agentAt(cb, CHILD, GRANDCHILD), body(exampleChild().lines));
    const s = await source();
    expect(await s.classify(k(`${CHILD}/subagents/${GRANDCHILD}.jsonl`))).toBeNull();
    await write(agentAt(cb, SID, CHILD), body(exampleChild().lines));
    await s.listFiles();
    expect(await s.classify(k(`${CHILD}/subagents/${GRANDCHILD}.jsonl`))).toMatchObject({ kind: 'agent', sessionId: SID, agentId: GRANDCHILD });
  });

  test('a cycle of agent stems is never classified', async () => {
    await write(agentAt(cb, 'agent-a', 'agent-b'), body(exampleChild().lines));
    await write(agentAt(cb, 'agent-b', 'agent-a'), body(exampleChild().lines));
    const s = await source();
    expect(await s.classify(k('agent-a/subagents/agent-b.jsonl'))).toBeNull();
  });

  test('project from a later line when the first lines have no cwd; not classified (not a wrong project) until one is written; an unchanged file is not read again', async () => {
    const head = [sessionMeta({ 'codebuddy.ai/hostKind': 'cli' }, { id: 'm' }), topicRecord('a topic', { id: 't' })];
    await write(mainAt(cb, SID), body(head));
    const s = await source();
    expect(await s.classify(k(`${SID}.jsonl`))).toBeNull();
    const opens = vi.spyOn(fs, 'open');
    expect(await s.classify(k(`${SID}.jsonl`))).toBeNull();
    expect(await s.classify(k(`${SID}.jsonl`))).toBeNull();
    expect(opens).not.toHaveBeenCalled();
    opens.mockRestore();
    const c = new Chain({ cwd: 'D:\\Work\\Repo' });
    c.prompt('hello');
    await fs.appendFile(mainAt(cb, SID), body(c.lines));
    expect(await s.classify(k(`${SID}.jsonl`))).toEqual({ kind: 'session', projectId: 'D--Work-Repo', sessionId: SID });
  });

  test('a first line of several MB is skipped without being held, the cwd is taken from the next line', async () => {
    const huge = sessionMeta({ blob: 'x'.repeat(BUDDY_HEAD_LINE_MAX * 3) }, { id: 'm' });
    const c = new Chain();
    c.prompt('hi');
    await write(mainAt(cb, SID), body([huge]));
    const s = await source();
    expect(await s.classify(k(`${SID}.jsonl`))).toBeNull();
    await fs.appendFile(mainAt(cb, SID), body(c.lines));
    expect(await s.classify(k(`${SID}.jsonl`))).toEqual({ kind: 'session', projectId: PROJECT_ID, sessionId: SID });
  });

  test('the head scan is bounded: a cwd past BUDDY_HEAD_MAX_BYTES is not looked for, and the file is not scanned again while it only grows', async () => {
    const huge = sessionMeta({ blob: 'x'.repeat(BUDDY_HEAD_MAX_BYTES + 1024) }, { id: 'm' });
    const c = new Chain();
    c.prompt('hi');
    await write(mainAt(cb, SID), body([huge, ...c.lines]));
    const s = await source();
    let read = 0;
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const h = await realOpen(...args);
      const realRead = h.read.bind(h) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
      (h as unknown as { read: unknown }).read = async (...a: unknown[]) => {
        const r = await realRead(...a);
        read += r.bytesRead;
        return r;
      };
      return h;
    }) as typeof fs.open);
    expect(await s.classify(k(`${SID}.jsonl`))).toBeNull();
    expect(read).toBeLessThanOrEqual(BUDDY_HEAD_MAX_BYTES);
    read = 0;
    await fs.appendFile(mainAt(cb, SID), body(c.lines));
    expect(await s.classify(k(`${SID}.jsonl`))).toBeNull();
    expect(read).toBe(0);
  });

  test('a huge first line that carries the cwd: the next line gives it', async () => {
    const c = new Chain();
    c.prompt('p'.repeat(BUDDY_HEAD_LINE_MAX * 2));
    c.reply('ok', 'r1');
    await write(mainAt(cb, SID), body(c.lines));
    const s = await source();
    expect(await s.classify(k(`${SID}.jsonl`))).toMatchObject({ kind: 'session', projectId: PROJECT_ID });
  });

  test('a partial last line is not read for the cwd', async () => {
    const c = new Chain();
    c.prompt('hi');
    await write(mainAt(cb, SID), c.lines[0]!); // no newline yet
    const s = await source();
    expect(await s.classify(k(`${SID}.jsonl`))).toBeNull();
    await fs.appendFile(mainAt(cb, SID), '\n');
    expect(await s.classify(k(`${SID}.jsonl`))).toMatchObject({ kind: 'session', projectId: PROJECT_ID });
  });

  test('the class is taken from the stored raw events when there are any (nothing is read)', async () => {
    const lookup: BuddyLookup = {
      storedFile: (key) => (key === k(`${SID}.jsonl`) ? { sessionId: SID, agentId: null, projectId: 'stored-project' } : null),
      knownProjectIds: () => [],
    };
    const s = new BuddyFileSource('codebuddy', buddyRootsOf([cb]), lookup);
    expect(await s.classify(k(`${SID}.jsonl`))).toEqual({ kind: 'session', projectId: 'stored-project', sessionId: SID });
    expect(s.mainSessionOf(k(`${SID}.jsonl`))).toBe(SID);
  });
});

describe('projects (spec 4.7, 2.4)', () => {
  test('workbuddyProjectDir: only a last segment of the form YYYY-MM-DD-HH-MM-SS is replaced by its parent', () => {
    expect(workbuddyProjectDir('/Users/a/WorkBuddy AI/2026-10-27-13-46-52')).toBe('/Users/a/WorkBuddy AI');
    expect(workbuddyProjectDir('/Users/a/WorkBuddy AI/2026-10-27-13-46-52/')).toBe('/Users/a/WorkBuddy AI');
    expect(workbuddyProjectDir('C:\\Users\\a\\WorkBuddy\\2026-10-27-13-46-52')).toBe('C:\\Users\\a\\WorkBuddy');
    expect(workbuddyProjectDir('C:\\2026-10-27-13-46-52')).toBe('C:\\');
    expect(workbuddyProjectDir('/2026-10-27-13-46-52')).toBe('/');
    for (const same of [
      '/Users/a/2026-10-27',
      '/Users/a/2026-10-27-13-46-52-1',
      '/Users/a/x2026-10-27-13-46-52',
      '/Users/a/2026-10-27-13-46-5',
      '/Users/a/2026_10_27_13_46_52',
      '/Users/a/2026-10-27-13-46-52/src',
      '2026-10-27-13-46-52',
      '/home/dev/repo',
    ]) {
      expect(workbuddyProjectDir(same), same).toBe(same);
    }
  });

  test('a timestamp working directory: WorkBuddy files under the parent directory, CodeBuddy keeps it; the session cwd stays as written', async () => {
    const stamp = '/home/dev/WorkBuddy AI/2026-10-27-13-46-52';
    const c = new Chain({ cwd: stamp });
    c.prompt('hi');
    c.reply('hello', 'r1');
    await write(mainAt(wb, SID, 'home-dev-WorkBuddy AI-2026-10-27-13-46-52'), body(c.lines));
    await write(mainAt(cb, SID2, 'home-dev-WorkBuddy AI-2026-10-27-13-46-52'), body(c.lines));
    const { store } = await ingestAll(cfg());
    expect(store.getSession(SID)).toMatchObject({ origin: 'workbuddy', projectId: '-home-dev-WorkBuddy-AI', cwd: stamp });
    expect(store.getSession(SID2)).toMatchObject({ origin: 'codebuddy', projectId: '-home-dev-WorkBuddy-AI-2026-10-27-13-46-52', cwd: stamp });
  });

  test('the same directory as a Claude Code session is one project (letter case of the drive and trailing separator aside)', async () => {
    const claudeProjects = path.join(tmp, 'claude-projects');
    await fs.mkdir(path.join(claudeProjects, 'D--Work-Repo'), { recursive: true });
    const c = new Chain({ cwd: 'd:\\work\\repo\\' });
    c.prompt('hi');
    await write(mainAt(cb, SID, 'd-work-repo'), body(c.lines));
    const { store } = await ingestAll(cfg());
    expect(store.getSession(SID)).toMatchObject({ origin: 'codebuddy', projectId: 'D--Work-Repo' });
  });
});

describe('subagent threads through the pipeline (spec 4.6)', () => {
  test('linked through toolResult.subAgent.sessionId; the thread is the file stem; arrival order does not matter', async () => {
    const main = exampleMain();
    const child = exampleChild();
    await write(mainAt(cb, SID), body(main.lines));
    await write(agentAt(cb, SID, CHILD), body(child.lines));
    const { store } = await ingestAll(cfg());
    const v = view(store, SID)!;
    const sub = buddyNodeId(SID, null, `@${offsetOf(main.lines, indexOfId(main.lines, main.ids.sub!))}`);
    expect(v.nodes[sub]).toMatchObject({ kind: 'subagent', childAgentId: CHILD });
    const childReply = buddyNodeId(SID, CHILD, `@${offsetOf(child.lines, 1)}`);
    expect(v.nodes[childReply]).toMatchObject({ agentId: CHILD, parentId: sub });
    expect(Object.values(v.edges).some((e) => e.kind === 'spawn')).toBe(true);
    expect(store.getSession(CHILD)).toBeNull();

    // Child first, then the parent: the same graph.
    await fs.rm(path.join(cb, 'projects'), { recursive: true });
    await write(agentAt(cb, SID, CHILD), body(child.lines));
    await write(mainAt(cb, SID), body([main.lines[0]!])); // session-meta only: no cwd yet, the child waits
    const s2 = open();
    const p2 = newPipeline(s2, cfg());
    await p2.scanAll();
    await p2.idle();
    expect(s2.getSession(CHILD)).toBeNull();
    expect(s2.getSession(SID)).toBeNull();
    await fs.appendFile(mainAt(cb, SID), body(main.lines.slice(1)));
    await p2.scanAll();
    await p2.idle();
    expect(p2.ingestFailures()).toEqual([]);
    expect(view(s2, SID)).toEqual(v);
  });

  test('without toolResult.subAgent the thread hangs under the session, unlinked', async () => {
    const main = exampleMain();
    const lines = main.lines.map((l) => (l.includes('"subAgent"') ? JSON.stringify((({ providerData, ...rest }) => ({ ...rest, providerData: { ...providerData, toolResult: { content: 'Looks good.' } } }))(JSON.parse(l))) : l));
    await write(mainAt(cb, SID), body(lines));
    await write(agentAt(cb, SID, CHILD), body(exampleChild().lines));
    const { store } = await ingestAll(cfg());
    const v = view(store, SID)!;
    expect(Object.values(v.nodes).some((n) => n.childAgentId === CHILD)).toBe(false);
    expect(Object.values(v.edges).some((e) => e.kind === 'spawn')).toBe(false);
    expect(v.nodes[buddyNodeId(SID, CHILD, `@${offsetOf(exampleChild().lines, 1)}`)]).toMatchObject({ agentId: CHILD, parentId: null });
  });
});

describe('rewrites (format reference 7: a failed batch is truncated away)', () => {
  async function fresh(lines: string[]): Promise<ReturnType<typeof view>> {
    const dir = await fs.mkdtemp(path.join(tmp, 'fresh-'));
    const root = path.join(dir, '.codebuddy');
    await write(mainAt(root, SID), body(lines));
    const store = open();
    const pipeline = newPipeline(store, cfg({ workbuddyDirs: [], codebuddyDir: root }));
    await pipeline.scanAll();
    await pipeline.idle();
    return view(store, SID);
  }

  test('a shrink (rollback of a batch) re-derives the session: what is left, nothing stale', async () => {
    const main = exampleMain();
    await write(mainAt(cb, SID), body(main.lines));
    const { store, pipeline } = await ingestAll(cfg());
    const all = Object.keys(view(store, SID)!.nodes).length;
    const kept = main.lines.slice(0, 8);
    await fs.writeFile(mainAt(cb, SID), body(kept));
    await pipeline.ingestFile(mainAt(cb, SID));
    await pipeline.idle();
    const after = view(store, SID)!;
    expect(Object.keys(after.nodes).length).toBeLessThan(all);
    expect(after.nodes).toEqual((await fresh(kept))!.nodes);
    expect(after.edges).toEqual((await fresh(kept))!.edges);
    // Then the retried batch is appended again: as if written once.
    await fs.appendFile(mainAt(cb, SID), body(main.lines.slice(8)));
    await pipeline.ingestFile(mainAt(cb, SID));
    await pipeline.idle();
    expect(view(store, SID)!.nodes).toEqual((await fresh(main.lines))!.nodes);
  });

  test('a rewrite that keeps the size re-derives the session too (the abandoned batch replaced by one of the same length)', async () => {
    const main = exampleMain();
    await write(mainAt(cb, SID), body(main.lines));
    const { store, pipeline } = await ingestAll(cfg());
    // The last batch (the final reply) rolled back and another one of exactly the same length written in its place.
    const last = main.lines[main.lines.length - 1]!;
    const rec = JSON.parse(last) as { content: { text: string }[]; zz?: string };
    rec.content[0]!.text = 'No.';
    rec.zz = '';
    rec.zz = 'x'.repeat(Buffer.byteLength(last) - Buffer.byteLength(JSON.stringify(rec)));
    const changed = [...main.lines.slice(0, -1), JSON.stringify(rec)];
    expect(Buffer.byteLength(body(changed))).toBe(Buffer.byteLength(body(main.lines)));
    await fs.writeFile(mainAt(cb, SID), body(changed));
    const later = new Date(Date.now() + 5_000);
    await fs.utimes(mainAt(cb, SID), later, later);
    await pipeline.scanAll();
    await pipeline.idle();
    const after = view(store, SID)!;
    const expected = (await fresh(changed))!;
    expect(after.nodes).toEqual(expected.nodes);
    expect(after.details).toEqual(expected.details);
    expect(JSON.stringify(after)).not.toContain('The reviewer agrees.');
    expect(JSON.stringify(after)).toContain('No.');
  });
});

describe('the Buddy line guard (a same-size rewrite that keeps the last 64 bytes)', () => {
  /** The example's last reply with another text of the same length: the file keeps its size and its last 64 bytes. */
  function sameEnd(lines: string[]): string[] {
    const last = lines[lines.length - 1]!;
    const changed = last.replace('The reviewer agrees.', 'The reviewer objects');
    expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(last));
    expect(changed.slice(-64)).toBe(last.slice(-64));
    return [...lines.slice(0, -1), changed];
  }

  test('the shared guard misses it; the Buddy reader reports a rewrite and reads again from the start', async () => {
    const lines = exampleMain().lines;
    const file = mainAt(cb, SID);
    await write(file, body(lines));
    const size = Buffer.byteLength(body(lines));
    const g = await readGuardedLines(file, 0, 1 << 20, null);
    const b = await readBuddyLines(file, 0, 1 << 20, null);
    expect(b.lines).toEqual(g.lines);
    expect(b.newOffset).toBe(size);
    expect(b.truncated).toBe(false);
    // Nothing new: nothing read, no state written.
    expect(await readBuddyLines(file, size, 1 << 20, b.state ?? null)).toEqual({ lines: [], newOffset: size, truncated: false, state: undefined });
    await fs.writeFile(file, body(sameEnd(lines)));
    expect((await readGuardedLines(file, size, 1 << 20, g.state ?? null)).truncated).toBe(false);
    const again = await readBuddyLines(file, size, 1 << 20, b.state ?? null);
    expect(again.truncated).toBe(true);
    expect(again.lines.map((l) => l.text)).toEqual(sameEnd(lines));
    // After that, appends read on normally and nothing is reported rewritten.
    const turn = new Chain({ prefix: 'n' });
    turn.prompt('more');
    await fs.appendFile(file, body(turn.lines));
    const next = await readBuddyLines(file, again.newOffset, 1 << 20, again.state ?? null);
    expect(next).toMatchObject({ truncated: false, lines: [{ offset: size, text: turn.lines[0] }] });
  });

  test('plain appends read in slices give the lines of the shared reader; a shrink is a rewrite', async () => {
    const lines = exampleMain().lines;
    const file = mainAt(cb, SID);
    await write(file, body(lines));
    const g: string[] = [];
    const b: string[] = [];
    for (const [read, out] of [[readGuardedLines, g], [readBuddyLines, b]] as const) {
      let from = 0;
      let state: string | null = null;
      for (;;) {
        const r: SourceRead = await read(file, from, 300, state);
        out.push(...r.lines.map((l) => `${l.offset}:${l.text}`));
        if (r.state !== undefined) state = r.state;
        if (r.newOffset === from) break;
        from = r.newOffset;
      }
    }
    expect(b).toEqual(g);
    const full = await readBuddyLines(file, 0, 1 << 20, null);
    await fs.writeFile(file, body(lines.slice(0, 3)));
    expect((await readBuddyLines(file, full.newOffset, 1 << 20, full.state ?? null)).truncated).toBe(true);
  });

  test('through the pipeline: the session is re-derived', async () => {
    const main = exampleMain();
    await write(mainAt(cb, SID), body(main.lines));
    const { store, pipeline } = await ingestAll(cfg());
    await fs.writeFile(mainAt(cb, SID), body(sameEnd(main.lines)));
    const later = new Date(Date.now() + 5_000);
    await fs.utimes(mainAt(cb, SID), later, later);
    await pipeline.scanAll();
    await pipeline.idle();
    const text = JSON.stringify(view(store, SID));
    expect(text).toContain('The reviewer objects');
    expect(text).not.toContain('The reviewer agrees.');
  });
});
