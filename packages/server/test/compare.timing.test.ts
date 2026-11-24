import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, test } from 'vitest';
import type { Change, CompareResponse, GraphNode, Origin, Session } from '@agent-canvas/shared';
import { buildServer } from '../src/api/server.js';
import { loadConfig } from '../src/config.js';
import { FilesService } from '../src/files/service.js';
import { Pipeline } from '../src/pipeline.js';
import { StatsService, storeStatsSource, type StatsSource } from '../src/stats/service.js';
import { openStore } from '../src/store/store.js';

// Timing-sensitive: runs in the serial "timing" Vitest project (see vitest.config.ts). Temp file store, invented nodes.
//
// Review Focus 3: two 100,000-node sessions compared through GET /api/compare, the stats and file services wired as
// buildServer wires them (one read of a session builds both summaries). The first call reads and summarizes both
// sessions; the second answers from the caches and reads no session. Measured on the development machine (Windows,
// Node 25), run on its own: first call 1299-1345 ms, second 16-22 ms (printed on every run). The bound leaves ~2x
// headroom (scaled by AGENT_CANVAS_TIMING_SCALE on CI).

const TIMING_SCALE = Math.max(1, Number(process.env.AGENT_CANVAS_TIMING_SCALE) || 1);
const bound = (ms: number): number => ms * TIMING_SCALE;
const BOUND_FIRST_MS = 3000;

const NODES = 100_000;
const H = 3_600_000;
const T0 = Date.parse('2026-11-24T10:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

function bigSession(sid: string, origin: Origin, cwd: string): Change[] {
  const start = T0 - 3 * H;
  const session: Session = {
    id: sid, projectId: 'p-big', origin, cwd, title: `big ${origin}`, gitBranch: null, status: 'idle', sourceDeleted: false,
    startedAt: iso(start), lastActivityAt: iso(T0),
  };
  const step = Math.floor((3 * H) / NODES);
  const node = (i: number): GraphNode => {
    const isPrompt = i % 60 === 0;
    const isCall = !isPrompt && i % 2 === 0;
    return {
      id: `${sid}-n${i}`, sessionId: sid, turnId: `${sid}-t${Math.floor(i / 60)}`, agentId: null, parentId: null,
      kind: isPrompt ? 'prompt' : isCall ? (i % 100 === 2 ? 'subagent' : 'tool') : 'text', status: isCall ? (i % 50 === 4 ? 'failed' : 'succeeded') : null,
      timestamp: iso(start + i * step), confirmed: true, title: 'x', summary: `prompt or step ${i} `.repeat(6),
      toolName: isCall ? `Tool${i % 40}` : null, toolUseId: null, messageId: `${sid}-m${i}`, durationMs: isCall ? 100 : null, endedAt: null,
      usage: !isPrompt && !isCall ? { inputTokens: 10, cachedInputTokens: 100, outputTokens: 2 } : null,
      systemSubtype: null, childAgentId: null,
      ...(isCall ? { files: [{ path: `${cwd}/src/f${i % 3000}.ts`, action: i % 4 === 0 ? 'read' : 'edit' }] } : {}),
    } as GraphNode;
  };
  const changes: Change[] = [{ type: 'session_upserted', session }];
  for (let i = 0; i < NODES; i++) changes.push({ type: 'node_added', node: node(i), detail: {} });
  return changes;
}

test('compare: two 100,000-node sessions — first call within the bound, the second reads no session', { timeout: 300_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-compare-big-'));
  const store = openStore(path.join(dir, 'compare.db'));
  const config = loadConfig({}, {
    deepseekDir: null, workbuddyDirs: [], codebuddyDir: null, doubaoDirs: [], qwenDir: null, geminiDir: null, grokDir: null, copilotDir: null,
    projectsDir: path.join(dir, 'projects'), dataDir: path.join(dir, 'data'), cursorDbPath: null,
  });
  fs.mkdirSync(config.projectsDir, { recursive: true });
  const pipeline = new Pipeline(store, config);
  let app: ReturnType<typeof buildServer> | null = null;
  try {
    for (const changes of [bigSession('big-claude', 'claude', '/w/app'), bigSession('big-codex', 'codex', '/tmp/clone/app')]) {
      for (let i = 0; i < changes.length; i += 10_000) store.applyChanges(changes.slice(i, i + 10_000));
    }

    const reads: string[] = [];
    const counting = (): StatsSource => {
      const base = storeStatsSource(store);
      return { ...base, readSession: (id, stopped) => { reads.push(id); return base.readSession(id, stopped); } };
    };
    const stats = new StatsService(counting(), { now: () => T0 });
    const files = new FilesService(counting(), { now: () => T0 });
    app = buildServer({ store, pipeline, config, stats, files });

    let t = performance.now();
    const first = await app.inject({ method: 'GET', url: '/api/compare?a=big-claude&b=big-codex' });
    const firstMs = performance.now() - t;
    expect(first.statusCode).toBe(200);
    const body = first.json() as CompareResponse;
    expect(body.left).toMatchObject({ sessionId: 'big-claude', steps: NODES });
    expect(body.right).toMatchObject({ sessionId: 'big-codex', steps: NODES });
    expect(body.turnsTruncated).toBe(true);
    expect(body.files.cwdsDiffer).toBe(true);
    expect(body.files.both).toHaveLength(100);
    // One read per session: the file summary is built from the stats read (shareReadsWith).
    expect(reads.sort()).toEqual(['big-claude', 'big-codex']);

    reads.length = 0;
    t = performance.now();
    const second = await app.inject({ method: 'GET', url: '/api/compare?a=big-claude&b=big-codex' });
    const secondMs = performance.now() - t;
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(body);
    expect(reads).toEqual([]);

    console.log(`compare two ${NODES}-node sessions: first call ${firstMs.toFixed(0)} ms, second call ${secondMs.toFixed(1)} ms (bound ${bound(BOUND_FIRST_MS)} ms)`);
    expect(firstMs).toBeLessThan(bound(BOUND_FIRST_MS));
  } finally {
    await app?.close();
    store.close();
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
