import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { describe, expect, test } from 'vitest';
import { defaultExportOptions, groupTurns, type Change, type ExportOptions, type GraphNode, type NodeDetail } from '@agent-canvas/shared';
import { LearnedValuesService } from '../src/export/learned.js';
import { ExportService } from '../src/export/service.js';
import { openStore } from '../src/store/store.js';
import { FAKE_KEY, makeNode, makeSession } from './export-fixtures.js';

/*
 * Benchmark of export and preview on a synthetic session of 170,000 nodes (turns of 37 nodes: a prompt, replies,
 * thinking, tool calls with 1–3 KB outputs, every 20th one 60 KB, a subagent per turn with 8 inner nodes), about
 * 400 MB of detail text, in a temp database file. Reports per run: wall time, the longest event-loop stall and the peak
 * heap / RSS above the baseline.
 *
 * Skipped by default. Run:
 *   AGENT_CANVAS_BENCH=1 npx --yes pnpm@10 vitest run packages/server/test/export.bench.test.ts
 */

const BENCH = process.env.AGENT_CANVAS_BENCH === '1';
const NODES = 170_000;
const TURN = 37;

function sessionChanges(): Change[][] {
  const s = 'bench';
  const batches: Change[][] = [[{ type: 'session_upserted', session: makeSession(s, { title: 'bench session' }) }]];
  let batch: Change[] = [];
  let turnId = '';
  let agent: string | null = null;
  for (let i = 0; i < NODES; i++) {
    const pos = i % TURN;
    if (pos === 0) turnId = `t${i}`;
    let node: GraphNode;
    let detail: Partial<NodeDetail>;
    const id = `n${String(i).padStart(7, '0')}`;
    if (pos === 0) {
      node = makeNode(s, id, i, { kind: 'prompt', status: null, toolName: null, title: 'Prompt', summary: `prompt ${i}`, turnId });
      detail = { text: `please do task ${i} with password=Bench${i}Secret99 and mail dev${i % 50}@example.com` };
    } else if (pos === 10) {
      agent = `A${i}`;
      node = makeNode(s, id, i, { kind: 'subagent', toolName: 'Task', title: 'general-purpose', childAgentId: agent, turnId });
      detail = { input: { prompt: 'x'.repeat(500) }, output: 'agent result '.repeat(100) };
    } else if (pos > 10 && pos <= 18 && agent !== null) {
      node = makeNode(s, id, i, { agentId: agent, turnId, summary: `inner ${i}` });
      detail = { input: { command: `grep -r token=${'y'.repeat(20)}${i} .` }, output: 'inner out '.repeat(150) };
    } else if (pos % 7 === 3) {
      node = makeNode(s, id, i, { kind: 'thinking', status: null, toolName: null, title: 'Thinking', turnId });
      detail = { text: 'thinking about it '.repeat(80) };
    } else if (pos % 5 === 1) {
      node = makeNode(s, id, i, { kind: 'text', status: null, toolName: null, title: 'Text', turnId });
      detail = { text: `reply ${i} `.repeat(60) };
    } else {
      node = makeNode(s, id, i, { turnId, summary: `cmd ${i}` });
      const size = i % 20 === 0 ? 60_000 : 1000 + (i % 3) * 1000;
      const chunk = `line ${i} ${i % 400 === 0 ? FAKE_KEY : 'plain text here'}\n`;
      detail = { input: { command: `echo ${i}`, api_key: i % 300 === 0 ? `Key${i}Value${i}` : 'none' }, output: chunk.repeat(Math.ceil(size / chunk.length)) };
    }
    batch.push({ type: 'node_added', node, detail });
    if (i > 0) {
      const from = `n${String(i - 1).padStart(7, '0')}`;
      batch.push({ type: 'edge_added', edge: { id: `${from}->${id}`, sessionId: s, from, to: id, kind: 'sequence' } });
    }
    if (batch.length >= 5000) {
      batches.push(batch);
      batch = [];
    }
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

interface Measure {
  ms: number;
  stallMs: number;
  heapMB: number;
  rssMB: number;
}

async function measure<T>(fn: () => Promise<T>): Promise<{ result: T; m: Measure }> {
  (globalThis as { gc?: () => void }).gc?.();
  const base = process.memoryUsage();
  let heap = base.heapUsed;
  let rss = base.rss;
  const sampler = setInterval(() => {
    const u = process.memoryUsage();
    if (u.heapUsed > heap) heap = u.heapUsed;
    if (u.rss > rss) rss = u.rss;
  }, 5);
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  const t0 = performance.now();
  const result = await fn();
  const ms = performance.now() - t0;
  h.disable();
  clearInterval(sampler);
  const u = process.memoryUsage();
  heap = Math.max(heap, u.heapUsed);
  rss = Math.max(rss, u.rss);
  return {
    result,
    m: {
      ms: Math.round(ms),
      stallMs: Math.round(h.max / 1e6),
      heapMB: Math.round((heap - base.heapUsed) / 1024 / 1024),
      rssMB: Math.round((rss - base.rss) / 1024 / 1024),
    },
  };
}

describe.skipIf(!BENCH)('export benchmark', () => {
  test('170,000-node session', { timeout: 1_800_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-export-bench-'));
    const store = openStore(path.join(dir, 'bench.db'));
    try {
      const t0 = performance.now();
      for (const batch of sessionChanges()) store.applyChanges(batch);
      console.log(`seeded ${NODES} nodes in ${Math.round(performance.now() - t0)} ms; db ${Math.round(store.dbFileSizes().fileBytes / 1024 / 1024)} MB`);
      const service = new ExportService({ store, dataDir: path.join(dir, 'data'), version: 'bench', findTemplate: () => null });
      const nodes = store.getGraph('bench')!.nodes;
      const middle = groupTurns(nodes)[Math.floor(NODES / TURN / 2)]!.key;
      const runs: [string, () => Promise<{ status: number; json?: unknown; file?: Buffer }>][] = [];
      const o = (x: Partial<ExportOptions>): ExportOptions => ({ ...defaultExportOptions(false), format: 'md', ...x });
      runs.push(['preview session (head, md)', () => service.preview('bench', o({}))]);
      runs.push(['preview session (no output, no thinking, no subagents)', () => service.preview('bench', o({ output: 'none', thinking: false, subagents: false }))]);
      runs.push(['preview session, all categories', () => service.preview('bench', o({ mask: { credential: true, assignment: true, personal: true, custom: true } }))]);
      runs.push(['export session md (head) -> 413', () => service.export('bench', o({}))]);
      runs.push(['preview one turn', () => service.preview('bench', o({ scope: { kind: 'turn', turnKey: middle } }))]);
      runs.push(['export one turn md (full)', () => service.export('bench', o({ scope: { kind: 'turn', turnKey: middle }, output: 'full' }))]);
      // The worst case of a preview: no size limit, so every detail (all output) is read and masked.
      const unlimited = new ExportService({ store, dataDir: path.join(dir, 'data'), version: 'bench', findTemplate: () => null, maxBytes: Number.MAX_SAFE_INTEGER });
      runs.push(['preview session, full output, no size limit (full scan)', () => unlimited.preview('bench', o({ output: 'full' }))]);
      // The page's learned-values route: a first pass over the whole session (10 s budget), then a cached call.
      const learnedService = new LearnedValuesService(store);
      const learnedRun = async (): Promise<{ status: number; json: unknown }> => {
        const r = await learnedService.get('bench', ['credential', 'assignment']);
        return { status: 200, json: { values: r?.values.length, capped: r?.capped } };
      };
      runs.push(['mask/learned (first call)', learnedRun]);
      runs.push(['mask/learned (cached)', learnedRun]);
      for (const [name, run] of runs) {
        const { result, m } = await measure(run);
        const extra = 'json' in result && result.json !== undefined ? JSON.stringify(result.json).slice(0, 200) : `${result.file?.length ?? 0} bytes`;
        console.log(`${name}: ${m.ms} ms, longest stall ${m.stallMs} ms, peak heap +${m.heapMB} MB, rss +${m.rssMB} MB; ${result.status} ${extra}`);
        expect([200, 413]).toContain(result.status);
      }
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
