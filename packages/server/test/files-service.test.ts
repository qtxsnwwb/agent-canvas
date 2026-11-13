import { describe, expect, test } from 'vitest';
import { FILES_LIMIT_MAX, type GraphNode, type SeqChange, type Session } from '@agent-canvas/shared';
import { FilesService, parseFilesQuery, type FilesQuery, type FilesSource } from '../src/files/service.js';
import { StatsService } from '../src/stats/service.js';

const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

function mkSession(id: string, o: Partial<Session> = {}): Session {
  return {
    id, projectId: 'p1', origin: 'claude', cwd: 'D:/w/p1', title: `t-${id}`, gitBranch: null, status: 'idle',
    sourceDeleted: false, startedAt: iso(NOW), lastActivityAt: iso(NOW), ...o,
  };
}
function mkNode(sessionId: string, id: string, path: string, o: Partial<GraphNode> = {}): GraphNode {
  return {
    id, sessionId, turnId: 'T', agentId: null, parentId: null, kind: 'tool', status: 'succeeded', timestamp: iso(NOW - 1000),
    confirmed: true, title: 'Edit', summary: '', toolName: 'Edit', toolUseId: null, messageId: null,
    durationMs: 1000, usage: null, systemSubtype: null, childAgentId: null, endedAt: null,
    files: [{ path, action: 'edit' }], ...o,
  };
}

class FakeSource implements FilesSource {
  seq = 1;
  reads: string[] = [];
  failing = new Set<string>();
  readonly data = new Map<string, { session: Session; nodes: GraphNode[] }>();
  add(id: string, files: number, o: Partial<Session> = {}): void {
    const nodes = Array.from({ length: files }, (_, i) => mkNode(id, `${id}-n${i}`, `D:/w/p1/${id}-${i}.ts`));
    this.data.set(id, { session: mkSession(id, o), nodes });
    this.seq++;
  }
  touch(id: string, path: string): SeqChange {
    const d = this.data.get(id)!;
    const node = mkNode(id, `${id}-x${d.nodes.length}`, path);
    d.nodes.push(node);
    return { type: 'node_added', node, detail: {}, seq: ++this.seq };
  }
  sessions(): Session[] {
    return [...this.data.values()].map((d) => d.session);
  }
  async readSession(sessionId: string) {
    this.reads.push(sessionId);
    await new Promise((r) => setImmediate(r));
    if (this.failing.has(sessionId)) throw new Error('broken');
    const d = this.data.get(sessionId);
    return d ? { session: d.session, nodes: d.nodes, seq: this.seq } : null;
  }
  projects() {
    return [{ id: 'p1', cwd: 'D:/w/p1' }];
  }
}

const Q: FilesQuery = { projectId: 'p1', origin: null, range: 'all', changedOnly: true, q: null, sort: 'recent', limit: 200 };

describe('FilesService', () => {
  test('first request summarizes every session; filter switches reuse the cache', async () => {
    const src = new FakeSource();
    src.add('a', 2);
    src.add('b', 3);
    const svc = new FilesService(src, { now: () => NOW });
    expect((await svc.project(Q)).totalFiles).toBe(5);
    expect(src.reads.sort()).toEqual(['a', 'b']);
    src.reads = [];
    expect((await svc.project({ ...Q, range: '7d', q: 'a-', sort: 'path' })).totalFiles).toBe(2);
    expect(src.reads).toEqual([]);
  });

  test('a changed session recomputes only its own summary', async () => {
    const src = new FakeSource();
    src.add('a', 2);
    src.add('b', 3);
    const svc = new FilesService(src, { now: () => NOW });
    await svc.project(Q);
    src.reads = [];
    svc.noteChanges([src.touch('b', 'D:/w/p1/new.ts')]);
    expect((await svc.project(Q)).totalFiles).toBe(6);
    expect(src.reads).toEqual(['b']);
  });

  test('concurrent requests share one computation', async () => {
    const src = new FakeSource();
    src.add('a', 2);
    const svc = new FilesService(src, { now: () => NOW });
    const [r1, r2] = await Promise.all([svc.project(Q), svc.project({ ...Q, sort: 'path' })]);
    expect(r1.totalFiles).toBe(2);
    expect(r2.totalFiles).toBe(2);
    expect(src.reads).toEqual(['a']);
  });

  test('a session whose summary fails is skipped and counted', async () => {
    const src = new FakeSource();
    src.add('a', 2);
    src.add('b', 3);
    src.failing.add('a');
    const svc = new FilesService(src, { now: () => NOW });
    const r = await svc.project(Q);
    expect(r).toMatchObject({ totalFiles: 3, failedSessions: 1 });
  });

  test('session(): the cached summary when valid, re-read after a change; null for an unknown session', async () => {
    const src = new FakeSource();
    src.add('a', 2);
    const svc = new FilesService(src, { now: () => NOW });
    await svc.project(Q);
    src.reads = [];
    expect((await svc.session('a'))!.files).toHaveLength(2);
    expect(src.reads).toEqual([]);
    svc.noteChanges([src.touch('a', 'D:/w/p1/z.ts')]);
    expect((await svc.session('a'))!.files).toHaveLength(3);
    expect(src.reads).toEqual(['a']);
    // and the project view reuses what session() cached
    src.reads = [];
    expect((await svc.project(Q)).totalFiles).toBe(3);
    expect(src.reads).toEqual([]);
    expect(await svc.session('nope')).toBeNull();
  });

  test('memory bound: summaries over maxTouches are evicted (least recently used first)', async () => {
    const src = new FakeSource();
    src.add('a', 3);
    src.add('b', 3);
    src.add('c', 3);
    const svc = new FilesService(src, { now: () => NOW, maxTouches: 6 });
    await svc.session('a');
    await svc.session('b');
    await svc.session('c');
    expect(svc.retainedTouchCount()).toBeLessThanOrEqual(6);
    expect(svc.cacheSize()).toBe(2);
  });

  test('warm() builds the cache and never rejects; close() refuses later requests', async () => {
    const src = new FakeSource();
    src.add('a', 1);
    const svc = new FilesService(src, { now: () => NOW });
    await svc.warm();
    expect(svc.cacheSize()).toBe(1);
    svc.close();
    await expect(svc.warm()).resolves.toBeUndefined();
    await expect(svc.project(Q)).rejects.toThrow(/closed/);
    await expect(svc.session('a')).rejects.toThrow(/closed/);
  });
});

describe('FilesService: single sessions and shared reads', () => {
  test('concurrent session() calls for one session share one read', async () => {
    const src = new FakeSource();
    src.add('a', 2);
    const svc = new FilesService(src, { now: () => NOW });
    const [r1, r2] = await Promise.all([svc.session('a'), svc.session('a')]);
    expect(r1!.files).toHaveLength(2);
    expect(r2).toEqual(r1);
    expect(src.reads).toEqual(['a']);
  });

  test('a change noted while a session() read is in flight: a later call reads again', async () => {
    const src = new FakeSource();
    src.add('a', 2);
    const svc = new FilesService(src, { now: () => NOW });
    const first = svc.session('a');
    svc.noteChanges([src.touch('a', 'D:/w/p1/late.ts')]);
    const second = svc.session('a');
    expect((await first)!.files.length).toBeGreaterThanOrEqual(2);
    expect((await second)!.files).toHaveLength(3);
    expect(src.reads).toEqual(['a', 'a']);
  });

  test('session() results keep being cached once the cache is full (least recently used evicted)', async () => {
    const src = new FakeSource();
    for (const id of ['a', 'b', 'c', 'd']) src.add(id, 1);
    const svc = new FilesService(src, { now: () => NOW, capacity: 2 });
    await svc.project(Q); // a refresh fills the cache (its overflow is not cached)
    for (const id of ['c', 'd', 'a']) await svc.session(id);
    expect(svc.cacheSize()).toBe(2);
    src.reads = [];
    await svc.session('a');
    expect(src.reads).toEqual([]);
  });

  test('linked with the stats service: one read per session builds both summaries; results unchanged', async () => {
    const make = () => {
      const src = new FakeSource();
      src.add('a', 2);
      src.add('b', 3);
      return src;
    };
    const plainSrc = make();
    const plainStats = new StatsService(plainSrc, { now: () => NOW });
    const plainFiles = new FilesService(plainSrc, { now: () => NOW });
    const statsQ = { range: 'all' as const, origin: null, projectId: null };
    const expectedStats = await plainStats.get(statsQ);
    const expectedFiles = await plainFiles.project(Q);

    const src = make();
    const stats = new StatsService(src, { now: () => NOW });
    const files = new FilesService(src, { now: () => NOW });
    files.shareReadsWith(stats);
    expect(await stats.get(statsQ)).toEqual(expectedStats);
    expect(src.reads.sort()).toEqual(['a', 'b']);
    src.reads = [];
    expect(await files.project(Q)).toEqual(expectedFiles);
    expect(src.reads).toEqual([]);
    // a change: whichever reads first serves both
    const change = src.touch('b', 'D:/w/p1/new.ts');
    stats.noteChanges([change]);
    files.noteChanges([change]);
    expect((await files.project(Q)).totalFiles).toBe(6);
    expect(src.reads).toEqual(['b']);
    expect((await stats.get(statsQ)).totals.toolCalls).toBe(expectedStats.totals.toolCalls + 1);
    expect(src.reads).toEqual(['b']);
  });
});

describe('parseFilesQuery', () => {
  test('defaults', () => {
    expect(parseFilesQuery({ projectId: 'p1' })).toEqual({
      projectId: 'p1', origin: null, range: 'all', changedOnly: true, q: null, sort: 'recent', limit: 200,
    });
  });
  test('every parameter', () => {
    expect(parseFilesQuery({ projectId: 'p1', origin: 'codex', range: '7d', changedOnly: '0', q: 'src', sort: 'path', limit: '5' }))
      .toEqual({ projectId: 'p1', origin: 'codex', range: '7d', changedOnly: false, q: 'src', sort: 'path', limit: 5 });
    expect(parseFilesQuery({ projectId: 'p1', origin: '', q: '' })).toMatchObject({ origin: null, q: null });
  });
  test('limit above the maximum is clamped', () => {
    expect(parseFilesQuery({ projectId: 'p1', limit: '100000' })).toMatchObject({ limit: FILES_LIMIT_MAX });
  });
  test.each([
    [{}],
    [{ projectId: '' }],
    [{ projectId: ['a', 'b'] }],
    [{ projectId: 'p1', origin: 'gpt' }],
    [{ projectId: 'p1', range: '1y' }],
    [{ projectId: 'p1', changedOnly: 'yes' }],
    [{ projectId: 'p1', q: 'x'.repeat(201) }],
    [{ projectId: 'p1', sort: 'size' }],
    [{ projectId: 'p1', limit: '0' }],
    [{ projectId: 'p1', limit: 'ten' }],
    [{ projectId: 'p1', limit: '-3' }],
    [{ projectId: 'p1', range: ['7d', '30d'] }],
  ])('400: %j', (q) => {
    expect(parseFilesQuery(q as Record<string, unknown>)).toHaveProperty('error');
  });
});
