import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { GraphNode, Session } from '@agent-canvas/shared';
import { start, type Running } from '../src/cli-commands.js';
import { StatsService, type StatsSource } from '../src/stats/service.js';
import { startStatsWarmup } from '../src/stats/warmup.js';
import { assistantBlock, userPrompt } from './fixtures.js';

/*
 * The stats warm-up: once the service's start-up work is done (initial scan, rebuild, first poll rounds), the session
 * summaries are built in the background so the first page open finds them ready. Temp dirs only.
 */

const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

function mkSession(id: string): Session {
  return {
    id, projectId: 'p1', origin: 'claude', cwd: null, title: null, gitBranch: null, status: 'idle',
    sourceDeleted: false, startedAt: iso(NOW), lastActivityAt: iso(NOW),
  };
}
function mkNode(sessionId: string, id: string, kind: GraphNode['kind']): GraphNode {
  return {
    id, sessionId, turnId: 'T', agentId: null, parentId: null, kind, status: kind === 'tool' ? 'succeeded' : null,
    timestamp: iso(NOW - 3600_000), confirmed: true, title: kind, summary: '', toolName: kind === 'tool' ? 'Bash' : null,
    toolUseId: null, messageId: null, durationMs: kind === 'tool' ? 1000 : null, usage: null, systemSubtype: null,
    childAgentId: null, endedAt: null,
  };
}

/** Sessions whose reads wait for `release()` one turn each, counting reads. */
class SlowSource implements StatsSource {
  reads: string[] = [];
  constructor(private readonly ids: string[]) {}
  sessions(): Session[] {
    return this.ids.map(mkSession);
  }
  async readSession(id: string) {
    this.reads.push(id);
    await tick(2);
    return { session: mkSession(id), nodes: [mkNode(id, `${id}-p`, 'prompt'), mkNode(id, `${id}-t`, 'tool')], seq: 1 };
  }
  projects() {
    return [];
  }
}

const Q = { range: 'all' as const, origin: null, projectId: null };

describe('StatsService.warm / close', () => {
  test('warm() builds every summary; a request arriving during the warm-up shares it (no second read)', async () => {
    const src = new SlowSource(['a', 'b', 'c', 'd']);
    const svc = new StatsService(src, { now: () => NOW });
    const warming = svc.warm();
    await tick(3); // the warm-up is under way
    const response = await svc.get(Q);
    await warming;
    expect(response.totals.toolCalls).toBe(4);
    expect(src.reads.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(svc.cacheSize()).toBe(4);
    src.reads = [];
    await svc.get(Q);
    expect(src.reads).toEqual([]);
  });

  test('close() stops a warm-up between sessions; warm() resolves; later work is refused', async () => {
    const src = new SlowSource(Array.from({ length: 50 }, (_, i) => `s${i}`));
    const svc = new StatsService(src, { now: () => NOW, yieldAfterMs: 0 });
    const warming = svc.warm();
    await tick(5);
    svc.close();
    await expect(warming).resolves.toBeUndefined();
    const readsAtClose = src.reads.length;
    expect(readsAtClose).toBeLessThan(50);
    await expect(svc.get(Q)).rejects.toThrow(/closed/);
    await tick(20);
    expect(src.reads.length).toBe(readsAtClose);
  });

  test('warm() never rejects (a failing source is reported per session, as for a request)', async () => {
    const svc = new StatsService({ sessions: () => { throw new Error('db gone'); }, readSession: async () => null, projects: () => [] });
    await expect(svc.warm()).resolves.toBeUndefined();
  });
});

describe('startStatsWarmup', () => {
  test('waits until start-up is settled, then warms once', async () => {
    let settled = false;
    let warms = 0;
    const w = startStatsWarmup({ warm: async () => { warms++; }, settled: () => settled, pollMs: 2 });
    await tick(15);
    expect(warms).toBe(0);
    settled = true;
    await w.done;
    expect(warms).toBe(1);
    await tick(10);
    expect(warms).toBe(1);
    await w.stop();
  });

  test('stop() before start-up settles: never warms; done resolves', async () => {
    let warms = 0;
    const w = startStatsWarmup({ warm: async () => { warms++; }, settled: () => false, pollMs: 2 });
    await tick(5);
    await w.stop();
    await w.done;
    await tick(10);
    expect(warms).toBe(0);
  });

  test('warms anyway once maxWaitMs has passed (a start-up signal that never settles does not block it forever)', async () => {
    let warms = 0;
    const w = startStatsWarmup({ warm: async () => { warms++; }, settled: () => false, pollMs: 2, maxWaitMs: 10 });
    await w.done;
    expect(warms).toBe(1);
  });

  test('a throwing settled() or warm() does not escape', async () => {
    const w1 = startStatsWarmup({ warm: async () => undefined, settled: () => { throw new Error('x'); }, pollMs: 2, maxWaitMs: 10 });
    await expect(w1.done).resolves.toBeUndefined();
    const w2 = startStatsWarmup({ warm: async () => { throw new Error('y'); }, settled: () => true, pollMs: 2 });
    await expect(w2.done).resolves.toBeUndefined();
  });
});

describe('start() and the warm-up', () => {
  let tmp: string | null = null;
  let app: Running | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
    if (tmp !== null) await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
    tmp = null;
  });

  async function setup(): Promise<{ projectsDir: string; dataDir: string }> {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-stats-warmup-'));
    const projectsDir = path.join(tmp, 'projects');
    await fs.mkdir(path.join(projectsDir, 'p1'), { recursive: true });
    const lines = [userPrompt('u1', null, 'hi'), assistantBlock('a1', 'u1', { type: 'text', text: 'ok' })].map((e) => (e.source === 'transcript' ? e.line : ''));
    await fs.writeFile(path.join(projectsDir, 'p1', 's1.jsonl'), `${lines.join('\n')}\n`);
    return { projectsDir, dataDir: path.join(tmp, 'data') };
  }

  test('off unless asked for (tests run with AGENT_CANVAS_STATS_WARMUP=0)', async () => {
    expect(process.env.AGENT_CANVAS_STATS_WARMUP).toBe('0');
    const dirs = await setup();
    app = await start({ ...dirs, codexSessionsDir: null, cursorDbPath: null, port: 0 });
    expect(app.statsWarmup).toBeNull();
  });

  test('asked for: runs after the initial scan and finishes; the stats answer from the warm cache', async () => {
    const dirs = await setup();
    app = await start({ ...dirs, codexSessionsDir: null, cursorDbPath: null, port: 0 }, { statsWarmup: true });
    expect(app.statsWarmup).not.toBeNull();
    await app.statsWarmup;
    const body = (await (await fetch(`${app.url}/api/stats?range=all`)).json()) as { totals: { sessions: number; turns: number } };
    expect(body.totals).toMatchObject({ sessions: 1, turns: 1 });
  });

  test('close() during the warm-up stops it and closes cleanly', async () => {
    const dirs = await setup();
    app = await start({ ...dirs, codexSessionsDir: null, cursorDbPath: null, port: 0 }, { statsWarmup: true });
    const warming = app.statsWarmup!;
    await app.close();
    app = null;
    await expect(warming).resolves.toBeUndefined();
  });
});
