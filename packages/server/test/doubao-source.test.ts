import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GraphEdge, GraphNode } from '@agent-canvas/shared';
import { fileSources } from '../src/cli.js';
import { loadConfig, type Config } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { DOUBAO_ASSIGNMENT_MAX_BYTES, DOUBAO_PROJECT, DoubaoFileSource, readDoubaoLines } from '../src/sources/doubao/source.js';
import { readGuardedLines } from '../src/sources/guarded-reader.js';
import { openStore, type Store } from '../src/store/store.js';
import { agentFile, assignment, body, CONV, exampleChild, exampleMain, fileLine, LEAF, MAIN, MTIME, ORG, sessionsDir, T1, user, write, writeExample } from './doubao-fixtures.js';

// DoubaoFileSource: which files under each "User Data"-level root are conversations and agent threads, the reader's
// synthetic first line, duplicates across roots and profiles. Temp directories only.

const CONV2 = '7391000000000000456';

let tmp: string;
/** The two Windows-style roots: `<x>/DoubaoWork/User Data` and `<x>/Doubao/User Data`. */
let work: string;
let app: string;
const stores: Store[] = [];
const pipelines: Pipeline[] = [];

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-doubao-source-'));
  work = path.join(tmp, 'DoubaoWork', 'User Data');
  app = path.join(tmp, 'Doubao', 'User Data');
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

const cfg = (doubaoDirs: string[] = [work, app]): Config =>
  loadConfig({}, {
    projectsDir: path.join(tmp, 'claude-projects'),
    dataDir: path.join(tmp, 'data'),
    codexSessionsDir: null,
    cursorDbPath: null,
    geminiDir: null,
    grokDir: null,
    copilotDir: null,
    deepseekDir: null,
    workbuddyDirs: [],
    codebuddyDir: null,
    doubaoDirs,
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
const doubaoOf = (p: Pipeline): DoubaoFileSource => p.fileSources().find((s) => s.origin === 'doubao') as DoubaoFileSource;
function view(store: Store, sid: string) {
  const g = store.getGraph(sid);
  if (g === null) return null;
  const nodes: Record<string, GraphNode> = Object.fromEntries([...g.nodes].sort((a, b) => a.id.localeCompare(b.id)).map((n) => [n.id, n]));
  const edges: Record<string, GraphEdge> = Object.fromEntries([...g.edges].sort((a, b) => a.id.localeCompare(b.id)).map((e) => [e.id, e]));
  const details = Object.fromEntries(Object.keys(nodes).map((id) => [id, store.getNodeDetail(sid, id)]));
  return { session: g.session, nodes, edges, details };
}

describe('roots, labels and keys', () => {
  test('origin, project, line identity, reader, watch depth', () => {
    const s = new DoubaoFileSource([work, app]);
    expect(s.origin).toBe('doubao');
    expect(DOUBAO_PROJECT).toBe('doubao-work');
    expect(s.lineIdentity).toBe('offset');
    expect(s.readLines).toBe(readDoubaoLines);
    expect(s.watchDepth).toBe(4);
    expect(s.rootDir).toBe(work);
  });

  test('labels from the variant directory ("User Data" takes its parent\'s name); keys back to their files', () => {
    const s = new DoubaoFileSource([work, app]);
    const a = agentFile(work, MAIN, 'trajectory.jsonl');
    const b = agentFile(app, ORG, 'assignment.md', { profile: 'Profile 3', ns: '.doubao' });
    expect(s.keyOf(a)).toBe(`doubao:DoubaoWork/Default/.doubaowork/${CONV}/${MAIN}/trajectory.jsonl`);
    expect(s.keyOf(b)).toBe(`doubao:Doubao/Profile 3/.doubao/${CONV}/${ORG}/assignment.md`);
    expect(s.pathOf(s.keyOf(a)!)).toBe(a);
    expect(s.pathOf(s.keyOf(b)!)).toBe(b);
    // macOS roots are named after the variant themselves.
    const mac = new DoubaoFileSource([path.join(tmp, 'Library', 'DoubaoWork'), path.join(tmp, 'Library', 'Doubao')]);
    expect(mac.keyOf(agentFile(path.join(tmp, 'Library', 'Doubao'), MAIN, 'trajectory.jsonl'))).toBe(`doubao:Doubao/Default/.doubaowork/${CONV}/${MAIN}/trajectory.jsonl`);
    // Two roots with the same name are told apart.
    const twins = new DoubaoFileSource([path.join(tmp, 'x', 'Doubao'), path.join(tmp, 'y', 'Doubao')]);
    const k1 = twins.keyOf(agentFile(path.join(tmp, 'x', 'Doubao'), MAIN, 'trajectory.jsonl'))!;
    const k2 = twins.keyOf(agentFile(path.join(tmp, 'y', 'Doubao'), MAIN, 'trajectory.jsonl'))!;
    expect(k1).not.toBe(k2);
    expect(twins.pathOf(k2)).toBe(agentFile(path.join(tmp, 'y', 'Doubao'), MAIN, 'trajectory.jsonl'));
    expect(s.pathOf('doubao:Other/Default/.doubaowork/1/m_a/trajectory.jsonl')).toBeNull();
    expect(s.pathOf(`grok:DoubaoWork/Default/.doubaowork/${CONV}/${MAIN}/trajectory.jsonl`)).toBeNull();
  });

  test('only <profile>/<ns>/agent_mode/workspace/.sessions/<conv>/agents/<agent>/system/{trajectory.jsonl,assignment.md}', () => {
    const s = new DoubaoFileSource([work]);
    const sess = sessionsDir(work);
    for (const other of [
      path.join(sess, CONV, 'board.md'),
      path.join(sess, CONV, 'memory', 'MEMORY.md'),
      path.join(sess, CONV, 'attachments', 'a.png'),
      path.join(sess, CONV, 'agents', MAIN, 'system', 'other.jsonl'),
      path.join(sess, CONV, 'agents', MAIN, 'trajectory.jsonl'),
      path.join(sess, CONV, 'agents', 'bad id', 'system', 'trajectory.jsonl'),
      path.join(sess, 'bad.conv', 'agents', MAIN, 'system', 'trajectory.jsonl'),
      agentFile(work, MAIN, 'trajectory.jsonl', { profile: 'Guest Profile' }),
      agentFile(work, MAIN, 'trajectory.jsonl', { profile: 'Profile x' }),
      agentFile(work, MAIN, 'trajectory.jsonl', { ns: '.other' }),
      path.join(work, 'Default', '.doubaowork', 'agent_mode', 'workspace', '.skills', 'x', 'SKILL.md'),
      path.join(work, 'coding', 'snapshot', '1', CONV, 'k', `${MAIN}.json`),
      path.join(work, 'Local State'),
      path.join(tmp, 'elsewhere.jsonl'),
    ]) {
      expect(s.keyOf(other), other).toBeNull();
    }
  });
});

describe('discovery', () => {
  test('both variants, both namespaces, several profiles; nothing else is listed or opened', async () => {
    await writeExample(work);
    await writeExample(work, { profile: 'Profile 1', conv: CONV2, ns: '.doubao' });
    await writeExample(app, { profile: 'Profile 12', conv: '42' });
    // Not profiles, not sessions trees, not session files.
    await writeExample(work, { profile: 'System Profile', conv: '43' });
    await write(path.join(sessionsDir(work), CONV, 'board.md'), '# board');
    await write(path.join(work, 'Default', 'Preferences'), '{}');
    await write(path.join(work, 'Local State'), '{}');
    await write(path.join(work, 'Default', 'IndexedDB', 'x.ldb'), 'x');
    const s = new DoubaoFileSource([work, app]);
    const listed = await s.listFiles();
    const expected = [
      ...[MAIN, ORG].flatMap((a) => [agentFile(work, a, 'assignment.md'), agentFile(work, a, 'trajectory.jsonl')]),
      ...[MAIN, ORG].flatMap((a) => [agentFile(work, a, 'assignment.md', { profile: 'Profile 1', conv: CONV2, ns: '.doubao' }), agentFile(work, a, 'trajectory.jsonl', { profile: 'Profile 1', conv: CONV2, ns: '.doubao' })]),
      ...[MAIN, ORG].flatMap((a) => [agentFile(app, a, 'assignment.md', { profile: 'Profile 12', conv: '42' }), agentFile(app, a, 'trajectory.jsonl', { profile: 'Profile 12', conv: '42' })]),
    ].sort();
    expect(listed).toEqual(expected);
    expect(s.watchRoots).toEqual(
      [sessionsDir(work), sessionsDir(work, 'Profile 1', '.doubao'), sessionsDir(app, 'Profile 12')].map((dir) => ({ dir, depth: 4 })),
    );

    const opened: string[] = [];
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(((p: Parameters<typeof fs.open>[0], ...rest: unknown[]) => {
      opened.push(String(p));
      return (realOpen as (...a: unknown[]) => ReturnType<typeof fs.open>)(p, ...rest);
    }) as typeof fs.open);
    const { store } = await ingestAll(cfg());
    expect(opened.length).toBeGreaterThan(0);
    for (const f of opened) expect(f, f).toMatch(/[\\/]\.sessions[\\/][^\\/]+[\\/]agents[\\/][^\\/]+[\\/]system[\\/](trajectory\.jsonl|assignment\.md)$/);
    for (const sid of [CONV, CONV2, '42']) expect(store.getSession(sid)).toMatchObject({ origin: 'doubao', projectId: DOUBAO_PROJECT });
    expect(store.getSession('43')).toBeNull();
  });

  test('classification: main trajectory / assignment are session / title; other agents agent / agent_meta', async () => {
    await writeExample(work);
    const s = new DoubaoFileSource([work]);
    await s.listFiles();
    const k = (agent: string, file: 'trajectory.jsonl' | 'assignment.md') => s.keyOf(agentFile(work, agent, file))!;
    expect(await s.classify(k(MAIN, 'trajectory.jsonl'))).toEqual({ kind: 'session', projectId: DOUBAO_PROJECT, sessionId: CONV });
    expect(await s.classify(k(MAIN, 'assignment.md'))).toEqual({ kind: 'title', projectId: DOUBAO_PROJECT, sessionId: CONV });
    expect(await s.classify(k(ORG, 'trajectory.jsonl'))).toEqual({ kind: 'agent', projectId: DOUBAO_PROJECT, sessionId: CONV, agentId: ORG });
    expect(await s.classify(k(ORG, 'assignment.md'))).toEqual({ kind: 'agent_meta', projectId: DOUBAO_PROJECT, sessionId: CONV, agentId: ORG });
    expect(s.mainSessionOf(k(MAIN, 'trajectory.jsonl'))).toBe(CONV);
    expect(s.mainSessionOf(k(ORG, 'trajectory.jsonl'))).toBeNull();
    expect(s.mainSessionOf(k(MAIN, 'assignment.md'))).toBeNull();
    expect(s.projectOfKey(k(ORG, 'trajectory.jsonl'))).toBe(DOUBAO_PROJECT);
    expect(s.projectOfTranscript(agentFile(work, ORG, 'trajectory.jsonl'))).toBe(DOUBAO_PROJECT);
    // A new conversation seen only through a change event (no listing yet) is classified too.
    await writeExample(work, { conv: CONV2 });
    expect(await s.classify(s.keyOf(agentFile(work, ORG, 'trajectory.jsonl', { conv: CONV2 }))!)).toMatchObject({ kind: 'agent', sessionId: CONV2 });
  });

  test('an assignment.md over the size cap is not read', async () => {
    await writeExample(work);
    await write(agentFile(work, ORG, 'assignment.md'), assignment([{ at: T1, text: 'x'.repeat(DOUBAO_ASSIGNMENT_MAX_BYTES) }]));
    const s = new DoubaoFileSource([work]);
    await s.listFiles();
    expect(await s.classify(s.keyOf(agentFile(work, ORG, 'assignment.md'))!)).toBeNull();
    expect(await s.classify(s.keyOf(agentFile(work, MAIN, 'assignment.md'))!)).toMatchObject({ kind: 'title' });
  });

  test('main agent: none or several m_ directories — the conversation is not read and counted as unknown', async () => {
    await writeExample(work); // fine
    await write(agentFile(work, ORG, 'trajectory.jsonl', { conv: CONV2 }), body(exampleChild().lines)); // no main
    await write(agentFile(work, 'm_x1', 'trajectory.jsonl', { conv: '44' }), body(exampleMain().lines));
    await write(agentFile(work, 'm_x2', 'trajectory.jsonl', { conv: '44' }), body(exampleMain().lines)); // two mains
    await write(agentFile(work, 'm_', 'trajectory.jsonl', { conv: '45' }), body(exampleMain().lines)); // `m_` alone is no main
    const { store, pipeline } = await ingestAll(cfg([work]));
    const s = doubaoOf(pipeline);
    expect(store.getSession(CONV)).not.toBeNull();
    for (const sid of [CONV2, '44', '45']) expect(store.getSession(sid)).toBeNull();
    expect(s.status()).toMatchObject({ unknownSessions: 3, duplicateSessions: 0 });
    expect(await s.classify(s.keyOf(agentFile(work, 'm_x1', 'trajectory.jsonl', { conv: '44' }))!)).toBeNull();
    // Counted once per conversation however often scanned.
    await pipeline.scanAll();
    await pipeline.idle();
    expect(s.status()).toMatchObject({ unknownSessions: 3 });
  });

  test('watch roots: only the .sessions directories found, never a profile tree; none for a root without one', async () => {
    await fs.mkdir(path.join(work, 'Default', 'Cache'), { recursive: true });
    await fs.mkdir(sessionsDir(app, 'Profile 2', '.doubao'), { recursive: true });
    const s = new DoubaoFileSource([work, app]);
    expect(s.watchRoots).toEqual([{ dir: sessionsDir(app, 'Profile 2', '.doubao'), depth: 4 }]);
    expect(await s.listFiles()).toEqual([]);
  });

  test('missing roots: no source, nothing created; a source handed a missing root lists and watches nothing', async () => {
    const c = cfg();
    expect(fileSources(c).map((s) => s.origin)).toEqual(['claude']);
    await ingestAll(c);
    for (const d of [work, app]) await expect(fs.stat(d)).rejects.toThrow();
    await writeExample(app);
    const { store, pipeline } = await ingestAll(c);
    expect(pipeline.fileSources().map((s) => s.origin)).toEqual(['claude', 'doubao']);
    expect(doubaoOf(pipeline).watchRoots).toEqual([{ dir: sessionsDir(app), depth: 4 }]);
    expect(store.getSession(CONV)).toMatchObject({ origin: 'doubao' });
    await expect(fs.stat(work)).rejects.toThrow();
    // A root that exists but holds no profile: the source runs, reads nothing, creates nothing.
    await fs.mkdir(work, { recursive: true });
    await ingestAll(c);
    expect(await fs.readdir(work)).toEqual([]);
    const ghost = new DoubaoFileSource([path.join(tmp, 'ghost')]);
    expect(await ghost.listFiles()).toEqual([]);
    expect(ghost.watchRoots).toEqual([]);
    expect(await ghost.classify(`doubao:ghost/Default/.doubaowork/${CONV}/${MAIN}/trajectory.jsonl`)).toBeNull();
    await expect(fs.stat(path.join(tmp, 'ghost'))).rejects.toThrow();
  });
});

describe('the same conversation under another root or profile', () => {
  test('the first read wins; the other copy and its agents are skipped and counted', async () => {
    await writeExample(work);
    // Another copy with another history, in another profile of the other root.
    await write(agentFile(app, MAIN, 'trajectory.jsonl', { profile: 'Profile 1' }), body([user('a different copy')]));
    await write(agentFile(app, LEAF, 'trajectory.jsonl', { profile: 'Profile 1' }), body(exampleChild().lines));
    const { store, pipeline } = await ingestAll(cfg());
    const s = doubaoOf(pipeline);
    // The skipped copy's threads (no assignment.md) are not counted as fallbacks.
    expect(s.status()).toEqual({ duplicateSessions: 1, unknownSessions: 0, mtimeFallbacks: 0 });
    const text = JSON.stringify(view(store, CONV));
    expect(text).not.toContain('a different copy');
    expect(text).not.toContain(LEAF);
    expect(await s.classify(s.keyOf(agentFile(app, LEAF, 'trajectory.jsonl', { profile: 'Profile 1' }))!)).toBeNull();
    expect(s.mainSessionOf(s.keyOf(agentFile(app, MAIN, 'trajectory.jsonl', { profile: 'Profile 1' }))!)).toBeNull();
    expect(s.mainSessionOf(s.keyOf(agentFile(work, MAIN, 'trajectory.jsonl'))!)).toBe(CONV);
    await pipeline.scanAll();
    await pipeline.idle();
    expect(s.status()).toMatchObject({ duplicateSessions: 1 });
  });

  test('a copy already stored wins after a restart, even when the other root lists first', async () => {
    await writeExample(app);
    const store = open();
    await ingestAll(cfg([app]), store);
    const before = view(store, CONV)!;
    // `DoubaoWork` sorts before `Doubao`… either way: the stored copy keeps the session.
    await write(agentFile(work, MAIN, 'trajectory.jsonl'), body([user('a different copy')]));
    const { pipeline } = await ingestAll(cfg([work, app]), store);
    expect(doubaoOf(pipeline).status()).toMatchObject({ duplicateSessions: 1 });
    expect(view(store, CONV)).toEqual(before);
  });

  test('the winner deleted: the other copy takes over, not flagged; both deleted: flagged in the same run', async () => {
    await writeExample(work);
    const store = open();
    await ingestAll(cfg([work]), store);
    await writeExample(app);
    const { pipeline } = await ingestAll(cfg(), store);
    const before = view(store, CONV)!;
    const s = doubaoOf(pipeline);
    expect(s.status()).toMatchObject({ duplicateSessions: 1 });
    await fs.rm(path.join(sessionsDir(work), CONV), { recursive: true });
    await pipeline.scanAll();
    await pipeline.idle();
    expect(pipeline.ingestFailures()).toEqual([]);
    expect(store.getSession(CONV)).toMatchObject({ sourceDeleted: false });
    expect(view(store, CONV)!.nodes).toEqual(before.nodes);
    expect(s.status()).toMatchObject({ duplicateSessions: 0 });
    expect(s.mainSessionOf(s.keyOf(agentFile(app, MAIN, 'trajectory.jsonl'))!)).toBe(CONV);
    await fs.rm(path.join(sessionsDir(app), CONV), { recursive: true });
    await pipeline.scanAll();
    await pipeline.idle();
    expect(store.getSession(CONV)).toMatchObject({ sourceDeleted: true });
  });

  test('one root: a deleted conversation is flagged, and cleared when it comes back', async () => {
    await writeExample(work);
    const { store, pipeline } = await ingestAll(cfg([work]));
    await fs.rm(path.join(sessionsDir(work), CONV), { recursive: true });
    await pipeline.scanAll();
    await pipeline.idle();
    expect(store.getSession(CONV)).toMatchObject({ sourceDeleted: true });
    await writeExample(work);
    await pipeline.scanAll();
    await pipeline.idle();
    expect(store.getSession(CONV)).toMatchObject({ sourceDeleted: false });
  });
});

describe('mtime fallbacks (diagnostics)', () => {
  test('threads whose assignment.md is missing, too big, or has no time that parses', async () => {
    await writeExample(work); // both threads have times
    await writeExample(work, { conv: CONV2 });
    await fs.rm(agentFile(work, ORG, 'assignment.md', { conv: CONV2 })); // missing
    await write(agentFile(work, MAIN, 'assignment.md', { conv: CONV2 }), assignment([{ at: 'not a time', text: 'x' }])); // no time
    await writeExample(work, { conv: '46' });
    await write(agentFile(work, ORG, 'assignment.md', { conv: '46' }), 'x'.repeat(DOUBAO_ASSIGNMENT_MAX_BYTES + 1)); // too big
    const { pipeline } = await ingestAll(cfg([work]));
    const s = doubaoOf(pipeline);
    expect(s.status()).toEqual({ duplicateSessions: 0, unknownSessions: 0, mtimeFallbacks: 3 });
    // Fixed: counted again from the files at the next scan.
    await write(agentFile(work, ORG, 'assignment.md', { conv: CONV2 }), exampleChild().assignment);
    await pipeline.scanAll();
    await pipeline.idle();
    expect(s.status()).toMatchObject({ mtimeFallbacks: 2 });
  });
});

describe('the reader: a synthetic first line carrying the modification time', () => {
  test('emitted once when a file is read from its start; offsets strictly increasing; appends read on without it', async () => {
    const file = agentFile(work, MAIN, 'trajectory.jsonl');
    const lines = exampleMain().lines;
    await write(file, body(lines.slice(0, 3)));
    const t = new Date(MTIME);
    await fs.utimes(file, t, t);
    const first = await readDoubaoLines(file, 0, 1 << 20, null);
    const shared = await readGuardedLines(file, 0, 1 << 20, null);
    expect(first.lines[0]).toEqual({ offset: -1, text: fileLine(MTIME) });
    expect(first.lines.slice(1)).toEqual(shared.lines);
    expect(first.newOffset).toBe(shared.newOffset);
    expect(first.state).toBe(shared.state);
    expect(first.truncated).toBe(false);
    for (let i = 1; i < first.lines.length; i++) expect(first.lines[i]!.offset).toBeGreaterThan(first.lines[i - 1]!.offset);
    // Nothing new: nothing, no state.
    expect(await readDoubaoLines(file, first.newOffset, 1 << 20, first.state ?? null)).toEqual({ lines: [], newOffset: first.newOffset, truncated: false });
    await fs.appendFile(file, body(lines.slice(3, 5)));
    const next = await readDoubaoLines(file, first.newOffset, 1 << 20, first.state ?? null);
    expect(next.lines.map((l) => l.text)).toEqual(lines.slice(3, 5));
    expect(next.truncated).toBe(false);
  });

  test('an empty file gives nothing (the line comes with the first rows); budget slices carry it only on the first', async () => {
    const file = agentFile(work, MAIN, 'trajectory.jsonl');
    await write(file, '');
    expect(await readDoubaoLines(file, 0, 1 << 20, null)).toEqual({ lines: [], newOffset: 0, truncated: false });
    await fs.appendFile(file, body(exampleMain().lines));
    const texts: string[] = [];
    let from = 0;
    let state: string | null = null;
    for (;;) {
      const r = await readDoubaoLines(file, from, 200, state);
      texts.push(...r.lines.map((l) => l.text));
      if (r.state !== undefined) state = r.state;
      if (r.newOffset === from) break;
      from = r.newOffset;
    }
    expect(texts.filter((x) => x.includes('__agentCanvas'))).toHaveLength(1);
    expect(texts.slice(1)).toEqual(exampleMain().lines);
  });

  test('a rewrite reads again from the start with a new synthetic line; a vanished file is not a rewrite', async () => {
    const file = agentFile(work, MAIN, 'trajectory.jsonl');
    const lines = exampleMain().lines;
    await write(file, body(lines));
    const first = await readDoubaoLines(file, 0, 1 << 20, null);
    await write(file, body(lines.slice(0, 2)));
    const later = MTIME + 60_000;
    await fs.utimes(file, new Date(later), new Date(later));
    const again = await readDoubaoLines(file, first.newOffset, 1 << 20, first.state ?? null);
    expect(again.truncated).toBe(true);
    expect(again.lines.map((l) => l.text)).toEqual([fileLine(later), ...lines.slice(0, 2)]);
    expect(again.lines[0]!.offset).toBe(-1);
    // Gone between the pipeline's stat and the read: nothing read, nothing changed.
    await fs.rm(file);
    expect(await readDoubaoLines(file, again.newOffset, 1 << 20, again.state ?? null)).toEqual({ lines: [], newOffset: again.newOffset, truncated: false });
  });

  test('through the pipeline: the synthetic line is stored once per file generation and makes no unknown record', async () => {
    await writeExample(work);
    const { store, pipeline } = await ingestAll(cfg([work]));
    const key = doubaoOf(pipeline).keyOf(agentFile(work, MAIN, 'trajectory.jsonl'))!;
    const raw = store.rawForSession(CONV).filter((e) => e.source === 'transcript' && e.file === key);
    expect(raw.filter((e) => e.source === 'transcript' && e.offset === -1)).toHaveLength(1);
    expect(store.diagnostics().unknownRecords).toEqual([]);
    await fs.appendFile(agentFile(work, MAIN, 'trajectory.jsonl'), body([user('one more')]));
    await pipeline.ingestFile(agentFile(work, MAIN, 'trajectory.jsonl'));
    await pipeline.idle();
    expect(store.rawForSession(CONV).filter((e) => e.source === 'transcript' && e.file === key && e.offset === -1)).toHaveLength(1);
  });
});
