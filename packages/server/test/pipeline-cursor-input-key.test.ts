import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { detectAnomalies, type Origin } from '@agent-canvas/shared';
import { loadConfig, type Config } from '../src/config.js';
import { inputKeyOf } from '../src/normalize/input-key.js';
import { Pipeline } from '../src/pipeline.js';
import { ClaudeFileSource } from '../src/sources/claude.js';
import type { PollSink, PollSource } from '../src/sources/poll.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';
import { CursorConv } from './cursor-records.js';

// Final review, Important 2: a Cursor bubble whose newer record has no params. Its inputKey (and so the anomalies) must
// be a function of the records read: the same whatever the poll batching, after a rebuild and after hydration.
// Temp dirs and synthetic records only.

class FakePollSource implements PollSource {
  readonly origin: Origin = 'cursor';
  sink: PollSink | null = null;
  start(sink: PollSink): void {
    this.sink = sink;
  }
  async stop(): Promise<void> {}
  poke(): void {}
  status(): { lastPollAt: string | null; lastError: string | null } {
    return { lastPollAt: null, lastError: null };
  }
}

const ROOT = 'c1';
const TOOL = 'run_terminal_command_v2';
const PARAMS = { command: 'npm test' };

/** The reviewer's scenario: 4 × the same call loading → error; b4 then loses its params; 6 different failing reads. */
function records(): RawEvent[] {
  const c = new CursorConv({ id: ROOT });
  const out: RawEvent[] = [c.composer({ status: 'none' }), c.user('u1', 'go', 0)];
  let sec = 1;
  for (let i = 1; i <= 4; i++) {
    out.push(c.tool(`b${i}`, TOOL, 'loading', (sec += 2), { params: PARAMS }));
    out.push(c.update(`b${i}`, { toolFormerData: { status: 'error', result: '{"error":"x"}' } }));
  }
  out.push(c.update('b4', { toolFormerData: { params: null } }));
  for (let i = 0; i < 6; i++) out.push(c.tool(`r${i}`, 'read_file_v2', 'error', (sec += 2), { params: { targetFile: `f${i}.ts` } }));
  return out;
}

let tmp: string;
const open: { store: Store; pipeline: Pipeline }[] = [];
let n = 0;

async function newPipeline(): Promise<{ store: Store; pipeline: Pipeline; sink: PollSink; config: Config }> {
  const name = `p${n++}`;
  const projectsDir = path.join(tmp, 'projects');
  await fs.mkdir(projectsDir, { recursive: true });
  const config = loadConfig({}, { projectsDir, dataDir: path.join(tmp, name), codexSessionsDir: null, cursorDbPath: null });
  const store = openStore(path.join(tmp, `${name}.db`));
  const fake = new FakePollSource();
  const pipeline = new Pipeline(store, config, { sources: [new ClaudeFileSource(projectsDir)], pollSources: [fake] });
  open.push({ store, pipeline });
  await pipeline.scanAll();
  return { store, pipeline, sink: fake.sink!, config };
}

async function send(sink: PollSink, events: RawEvent[]): Promise<void> {
  if (events.length === 0) return;
  const all = events as Extract<RawEvent, { source: 'transcript' }>[];
  const first = all[0]!;
  await sink.ingestRecords({
    key: first.file,
    projectId: 'p1',
    sessionId: first.sessionId,
    agentId: first.agentId,
    records: all.map((e) => ({ recordType: e.recordType, line: e.line })),
  });
}

/** Nodes by id (inputKey included) and the session's anomalies. */
function content(store: Store): { nodes: unknown; anomalies: unknown } {
  const g = store.getGraph(ROOT)!;
  // An empty `files` list means "no files", as an absent one does (a node that lost its files live carries [], a rebuilt
  // one nothing: see filesPatch) — compared as equal.
  const plain = (x: (typeof g.nodes)[number]) => {
    if (x.files === undefined || x.files.length > 0) return x;
    const { files: _files, filesTruncated: _t, ...rest } = x;
    return rest;
  };
  const nodes = Object.fromEntries([...g.nodes].sort((a, b) => (a.id < b.id ? -1 : 1)).map((x) => [x.id, plain(x)]));
  return { nodes, anomalies: detectAnomalies(g.nodes) };
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-cursor-ik-'));
});
afterEach(async () => {
  for (const { store, pipeline } of open.splice(0)) {
    await pipeline.close();
    await pipeline.idle();
    store.close();
  }
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

test('Cursor params that vanish: inputKey and anomalies identical for every batching, after rebuild and hydration', async () => {
  const events = records();
  const key = inputKeyOf(TOOL, PARAMS);

  const one = await newPipeline();
  for (const e of events) await send(one.sink, [e]);
  const ref = content(one.store);
  const g = one.store.getGraph(ROOT)!;
  expect(g.nodes.find((x) => x.id === `bubble:${ROOT}:b4`)!.inputKey).toBe(key);
  expect((ref.anomalies as { kind: string }[]).find((a) => a.kind === 'loop')).toMatchObject({ basis: 'failed', count: 4, lastNodeId: `bubble:${ROOT}:b4` });
  one.pipeline.rebuild();
  expect(content(one.store), 'one by one, rebuilt').toEqual(ref);

  const all = await newPipeline();
  await send(all.sink, events);
  expect(content(all.store), 'all at once').toEqual(ref);
  all.pipeline.rebuild();
  expect(content(all.store), 'all at once, rebuilt').toEqual(ref);

  for (let cut = 1; cut < events.length; cut++) {
    const p = await newPipeline();
    await send(p.sink, events.slice(0, cut));
    await send(p.sink, events.slice(cut));
    expect(content(p.store), `split at ${cut}`).toEqual(ref);
  }

  // Hydration: a new pipeline on a store, the rest of the records in a second batch.
  for (const cut of [8, 9, 10, 12]) {
    const p = await newPipeline();
    await send(p.sink, events.slice(0, cut));
    const again = new Pipeline(p.store, p.config, { sources: [new ClaudeFileSource(p.config.projectsDir)], pollSources: [new FakePollSource()] });
    open.push({ store: p.store, pipeline: again });
    await again.scanAll();
    await send((again.pollSources()[0] as FakePollSource).sink!, events.slice(cut));
    expect(content(p.store), `hydrated at ${cut}`).toEqual(ref);
  }
}, 120_000);

test('Cursor params that vanish and come back to an earlier identical record (not stored again): same key everywhere', async () => {
  const c = new CursorConv({ id: ROOT });
  const first = c.tool('b1', TOOL, 'error', 1, { params: PARAMS });
  const gone = c.update('b1', { toolFormerData: { params: null } });
  const back = c.update('b1', { toolFormerData: { params: JSON.stringify(PARAMS) } });
  const events = [c.composer({ status: 'none' }), c.user('u1', 'go', 0), first, gone, back];
  const one = await newPipeline();
  for (const e of events) await send(one.sink, [e]);
  const ref = content(one.store);
  expect(one.store.getGraph(ROOT)!.nodes.find((x) => x.id === `bubble:${ROOT}:b1`)!.inputKey).toBe(inputKeyOf(TOOL, PARAMS));
  const all = await newPipeline();
  await send(all.sink, events);
  expect(content(all.store)).toEqual(ref);
  all.pipeline.rebuild();
  expect(content(all.store)).toEqual(ref);
}, 60_000);

// ---- real-data calibration: Cursor edits carry what changed in their result (content ids), not their params ----

const EDIT = 'edit_file_v2';
const editParams = { relativeWorkspacePath: '/w/a.ts', noCodeblock: true, cloudAgentEdit: false };
const ids = (before: string, after: string) => JSON.stringify({ beforeContentId: before, afterContentId: after });

/** Graph nodes by bubble id, from every batching of `events` (one by one, all at once, every split, rebuilt). */
async function everyBatching(events: RawEvent[]): Promise<Record<string, string | undefined>> {
  const one = await newPipeline();
  for (const e of events) await send(one.sink, [e]);
  const ref = content(one.store);
  one.pipeline.rebuild();
  expect(content(one.store), 'one by one, rebuilt').toEqual(ref);
  const all = await newPipeline();
  await send(all.sink, events);
  expect(content(all.store), 'all at once').toEqual(ref);
  for (let cut = 1; cut < events.length; cut++) {
    const p = await newPipeline();
    await send(p.sink, events.slice(0, cut));
    await send(p.sink, events.slice(cut));
    expect(content(p.store), `split at ${cut}`).toEqual(ref);
  }
  const g = one.store.getGraph(ROOT)!;
  return Object.fromEntries(g.nodes.map((x) => [x.id.slice(`bubble:${ROOT}:`.length), x.inputKey]));
}

test('Cursor edits: the key follows params, then the result content ids; different changes differ, equal ones match', async () => {
  const c = new CursorConv({ id: ROOT });
  const events = [
    c.composer({ status: 'none' }),
    c.user('u1', 'go', 0),
    // e1: params only (loading), then the result with ids.
    c.tool('e1', EDIT, 'loading', 1, { params: editParams }),
    c.update('e1', { toolFormerData: { status: 'completed', result: ids('c0', 'c1') } }),
    // e2: same path, another change.
    c.tool('e2', EDIT, 'completed', 3, { params: editParams, result: JSON.parse(ids('c1', 'c2')) }),
    // e3: the same change as e1 (same before / after).
    c.tool('e3', EDIT, 'completed', 5, { params: editParams, result: JSON.parse(ids('c0', 'c1')) }),
    // e4: params only, never a result.
    c.tool('e4', EDIT, 'loading', 7, { params: editParams }),
    // e5: ids, then a record whose result is gone: the ids are kept (as params are).
    c.tool('e5', EDIT, 'completed', 9, { params: editParams, result: JSON.parse(ids('c2', 'c3')) }),
  ];
  events.push(c.update('e5', { toolFormerData: { result: null } }));
  // e6: ids, then a record without params: the key stays.
  events.push(c.tool('e6', EDIT, 'completed', 11, { params: editParams, result: JSON.parse(ids('c3', 'c4')) }));
  events.push(c.update('e6', { toolFormerData: { params: null } }));
  const keys = await everyBatching(events);
  const k1 = inputKeyOf(EDIT, editParams);
  expect(keys.e4).toBe(k1);
  expect(keys.e1).toMatch(/^[0-9a-f]{16}$/);
  expect(keys.e1).not.toBe(k1);
  expect(keys.e2).not.toBe(keys.e1);
  expect(keys.e3).toBe(keys.e1);
  expect(keys.e5).not.toBe(k1);
  expect(new Set([keys.e1, keys.e2, keys.e5, keys.e6]).size).toBe(4);
}, 180_000);

test('Cursor edits: params-only key while loading, then the ids key; a live update patches it', async () => {
  const c = new CursorConv({ id: ROOT });
  const p = await newPipeline();
  await send(p.sink, [c.composer({ status: 'none' }), c.user('u1', 'go', 0), c.tool('e1', EDIT, 'loading', 1, { params: editParams })]);
  const k1 = p.store.getGraph(ROOT)!.nodes.find((x) => x.id.endsWith(':e1'))!.inputKey;
  expect(k1).toBe(inputKeyOf(EDIT, editParams));
  await send(p.sink, [c.update('e1', { toolFormerData: { status: 'completed', result: ids('a', 'b') } })]);
  const k2 = p.store.getGraph(ROOT)!.nodes.find((x) => x.id.endsWith(':e1'))!.inputKey;
  expect(k2).toMatch(/^[0-9a-f]{16}$/);
  expect(k2).not.toBe(k1);
}, 60_000);

test('Cursor: five edits of one file with different changes are no loop; five identical changes are', async () => {
  const c = new CursorConv({ id: ROOT });
  const base = [c.composer({ status: 'none' }), c.user('u1', 'go', 0)];
  const differ = [...base, ...[0, 1, 2, 3, 4].map((i) => c.tool(`d${i}`, EDIT, 'completed', 1 + 2 * i, { params: editParams, result: JSON.parse(ids(`x${i}`, `x${i + 1}`)) }))];
  const p = await newPipeline();
  await send(p.sink, differ);
  expect(detectAnomalies(p.store.getGraph(ROOT)!.nodes).filter((a) => a.kind === 'loop')).toEqual([]);
  const c2 = new CursorConv({ id: 'c2' });
  const same = [c2.composer({ status: 'none' }), c2.user('u1', 'go', 0), ...[0, 1, 2, 3, 4].map((i) => c2.tool(`s${i}`, EDIT, 'completed', 1 + 2 * i, { params: editParams, result: JSON.parse(ids('y0', 'y1')) }))];
  await send(p.sink, same);
  expect(detectAnomalies(p.store.getGraph('c2')!.nodes).filter((a) => a.kind === 'loop')).toMatchObject([{ basis: 'repeat', count: 5 }]);
}, 60_000);
