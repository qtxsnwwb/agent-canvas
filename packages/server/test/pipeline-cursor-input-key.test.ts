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
  const nodes = Object.fromEntries([...g.nodes].sort((a, b) => (a.id < b.id ? -1 : 1)).map((x) => [x.id, x]));
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
