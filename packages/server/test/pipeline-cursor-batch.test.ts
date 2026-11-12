import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Origin } from '@claude-canvas/shared';
import { loadConfig, type Config } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { ClaudeFileSource } from '../src/sources/claude.js';
import type { PollSink, PollSource } from '../src/sources/poll.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';
import { CursorConv } from './cursor-records.js';

// Fix wave, performance: a poll batch is one transaction and one derivation. Its result must be what the same records
// applied one by one give: the same graph, session and node details in the store; a rebuild gives them too.
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

const ROOT = 'c-root';
const SUB = 'c-sub';

/** A root conversation of ~150 records (tools completing late, a text growing, an order swap) and a subagent of ~40. */
function records(): { root: RawEvent[]; sub: RawEvent[] } {
  const c = new CursorConv({ id: ROOT });
  const s = new CursorConv({ id: SUB, sessionId: ROOT });
  const root: RawEvent[] = [c.composer({ status: 'none' })];
  const loading: string[] = [];
  let sec = 0;
  for (let t = 0; t < 4; t++) {
    root.push(c.user(`u${t}`, `prompt ${t}`, (sec += 2)));
    for (let i = 0; i < 30; i++) {
      const id = `b${t}-${i}`;
      if (i % 9 === 4) {
        root.push(c.tool(id, 'run_terminal_command_v2', 'loading', (sec += 2)));
        loading.push(id);
      } else if (i % 5 === 0) root.push(c.text(id, `step ${i}`, (sec += 2)));
      else if (i % 7 === 0) root.push(c.thinking(id, 'hmm', (sec += 2)));
      else root.push(c.tool(id, 'read_file_v2', i % 11 === 0 ? 'error' : 'completed', (sec += 2), { params: { targetFile: `f${i}.ts` } }));
      if (t === 1 && i === 10) root.push(c.task('d1', 'call-sub', 'completed', (sec += 2), { result: { agentId: SUB } }));
    }
    for (const id of loading.splice(0)) root.push(c.update(id, { completedAtMs: Date.parse('2026-11-12T08:00:00.000Z') + (sec + 1) * 1000, toolFormerData: { status: 'completed', result: '{"exitCode":0}' } }));
    root.push(c.update(`b${t}-5`, { text: `step 5, revised in turn ${t}` }));
    root.push(c.turnEnd(`e${t}`, (sec += 2)));
  }
  root.push(c.update('b2-1', { order: 1000 }), c.composer({ status: 'completed' }));
  const sub: RawEvent[] = [s.subagentComposer('call-sub')];
  let ss = 40;
  sub.push(s.user('su', 'explore', (ss += 1)));
  for (let i = 0; i < 38; i++) sub.push(i % 3 === 0 ? s.text(`sx${i}`, `x${i}`, (ss += 1)) : s.tool(`st${i}`, 'ripgrep_raw_search', 'completed', (ss += 1)));
  sub.push(s.turnEnd('se', (ss += 1)));
  return { root, sub };
}

let tmp: string;
const open: { store: Store; pipeline: Pipeline }[] = [];

async function newPipeline(name: string): Promise<{ store: Store; pipeline: Pipeline; sink: PollSink; config: Config }> {
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

/** Sends the conversation's records as the source does: one key at a time, `size` records per batch. */
async function ingest(sink: PollSink, events: RawEvent[], size: number): Promise<void> {
  const all = events as Extract<RawEvent, { source: 'transcript' }>[];
  for (let i = 0; i < all.length; ) {
    let j = i + 1;
    while (j < all.length && j - i < size && all[j]!.file === all[i]!.file) j += 1;
    const chunk = all.slice(i, j);
    i = j;
    const first = chunk[0]!;
    await sink.ingestRecords({
      key: first.file,
      projectId: 'p1',
      sessionId: first.sessionId,
      agentId: first.agentId,
      records: chunk.map((e) => ({ recordType: e.recordType, line: e.line })),
    });
  }
}

/** What the store holds for the session: graph (nodes and edges by id), session row, every node's detail. */
function content(store: Store, sessionId = ROOT): unknown {
  const g = store.getGraph(sessionId)!;
  const byId = <T extends { id: string }>(xs: T[]): Record<string, T> => Object.fromEntries([...xs].sort((a, b) => (a.id < b.id ? -1 : 1)).map((x) => [x.id, x]));
  return {
    session: g.session,
    nodes: byId(g.nodes),
    edges: byId(g.edges),
    details: Object.fromEntries(g.nodes.map((n) => [n.id, store.getNodeDetail(sessionId, n.id)])),
  };
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-cursor-batch-'));
});
afterEach(async () => {
  for (const { store, pipeline } of open.splice(0)) {
    await pipeline.close();
    await pipeline.idle();
    store.close();
  }
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

describe('poll batches: one transaction and one derivation, same result as record by record', () => {
  test('in-order import: batches of 256 / 37 and record by record give the same store content; rebuild gives it too', async () => {
    const { root, sub } = records();
    const one = await newPipeline('one');
    await ingest(one.sink, root, 1);
    await ingest(one.sink, sub, 1);
    const ref = content(one.store);
    expect(Object.keys((ref as { nodes: object }).nodes).length).toBeGreaterThan(150);

    for (const size of [256, 37]) {
      const b = await newPipeline(`b${size}`);
      await ingest(b.sink, root, size);
      await ingest(b.sink, sub, size);
      expect(content(b.store), `batches of ${size}`).toEqual(ref);
      // Fewer changes: intermediate versions are not emitted.
      expect(b.store.changesSince(0).length).toBeLessThanOrEqual(one.store.changesSince(0).length);
      b.pipeline.rebuild();
      expect(content(b.store), `batches of ${size}, rebuilt`).toEqual(ref);
    }
  });

  test('subagent first, then the root, in batches: the same graph and session as record by record', async () => {
    const { root, sub } = records();
    const one = await newPipeline('one');
    await ingest(one.sink, sub, 1);
    await ingest(one.sink, root, 1);
    const b = await newPipeline('b');
    await ingest(b.sink, sub, 64);
    await ingest(b.sink, root, 64);
    const strip = (c: unknown): unknown => ({ ...(c as object), details: undefined });
    expect(strip(content(b.store))).toEqual(strip(content(one.store)));
    // and both equal the in-order result
    const inOrder = await newPipeline('in-order');
    await ingest(inOrder.sink, root, 256);
    await ingest(inOrder.sink, sub, 256);
    expect(strip(content(b.store))).toEqual(strip(content(inOrder.store)));
  });

  test('a batch for a session evicted from memory hydrates it (in batches) and gives the same result', async () => {
    const { root, sub } = records();
    const one = await newPipeline('one');
    await ingest(one.sink, [...root, ...sub.slice(0, 20)], 1);
    const b = await newPipeline('b');
    await ingest(b.sink, [...root, ...sub.slice(0, 20)], 50);
    // A new pipeline on b's store: the next batch hydrates the session from its raw events first.
    const again = new Pipeline(b.store, b.config, { sources: [new ClaudeFileSource(b.config.projectsDir)], pollSources: [new FakePollSource()] });
    await again.scanAll();
    const sink = (again.pollSources()[0] as FakePollSource).sink!;
    await ingest(sink, sub.slice(20), 50);
    await ingest(one.sink, sub.slice(20), 1);
    expect(content(b.store)).toEqual(content(one.store));
    await again.close();
    await again.idle();
  });

  test('a batch whose records are all stored already does nothing (no hydration, no change)', async () => {
    const { root } = records();
    const b = await newPipeline('b');
    await ingest(b.sink, root, 256);
    const seq = b.store.changesSince(0).length;
    const again = new Pipeline(b.store, b.config, { sources: [new ClaudeFileSource(b.config.projectsDir)], pollSources: [new FakePollSource()] });
    await again.scanAll();
    const sink = (again.pollSources()[0] as FakePollSource).sink!;
    await ingest(sink, root, 256);
    expect(again.loadedSessionCount()).toBe(0);
    expect(b.store.changesSince(0).length).toBe(seq);
    await again.close();
  });
});
