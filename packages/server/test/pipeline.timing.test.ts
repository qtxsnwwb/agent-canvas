import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';
import { assistantBlock } from './fixtures.js';

// Timing-sensitive: runs in the serial "timing" Vitest project (see vitest.config.ts).

const linesOf = (events: RawEvent[]): string =>
  events.map((e) => (e.source === 'transcript' ? e.line : '') + '\n').join('');

/** Largest gap between 5 ms interval ticks while `fn` runs. */
async function maxLoopGap(fn: () => Promise<void>): Promise<number> {
  let maxGap = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 5);
  try {
    await fn();
  } finally {
    clearInterval(timer);
  }
  return maxGap;
}

const bigSession = (n: number): RawEvent[] =>
  Array.from({ length: n }, (_, i) => assistantBlock(`a${i}`, i ? `a${i - 1}` : null, { type: 'text', text: 'x'.repeat(500) }));

describe('pipeline timing', () => {
  let tmp: string;
  let store: Store;
  let config: Config;
  let pipeline: Pipeline;

  const abs = (rel: string): string => path.join(config.projectsDir, ...rel.split('/'));
  async function write(rel: string, events: RawEvent[]): Promise<void> {
    await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
    await fs.writeFile(abs(rel), linesOf(events));
  }
  async function append(rel: string, events: RawEvent[]): Promise<void> {
    await fs.appendFile(abs(rel), linesOf(events));
  }

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-timing-'));
    config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), rescanMs: 200 });
    await fs.mkdir(config.projectsDir, { recursive: true });
    await fs.mkdir(config.dataDir, { recursive: true });
    store = openStore(':memory:');
    pipeline = new Pipeline(store, config);
  });
  afterEach(async () => {
    store.close();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  test('大文件导入期间事件循环不被长时间占用', async () => {
    await write('proj/s1.jsonl', bigSession(20_000));
    const gap = await maxLoopGap(() => pipeline.ingestFile(abs('proj/s1.jsonl')));
    expect(gap).toBeLessThan(100);
    expect(store.getGraph('s1')!.nodes).toHaveLength(20_000);
  }, 60_000);

  test('冷启动的 hook 水合不阻塞事件循环，且新事件排在水合之后', async () => {
    await write('proj/s1.jsonl', bigSession(20_000));
    await pipeline.ingestFile(abs('proj/s1.jsonl'));
    await append('proj/s1.jsonl', [assistantBlock('late', 'a19999', { type: 'text', text: 'late' })]);

    const p2 = new Pipeline(store, config); // cold Normalizer
    const gap = await maxLoopGap(async () => {
      p2.ingestHook(
        'PreToolUse',
        's1',
        JSON.stringify({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, tool_use_id: 'tuH' }),
      );
      const file = p2.ingestFile(abs('proj/s1.jsonl'));
      await p2.idle();
      await file;
    });
    expect(gap).toBeLessThan(100);
    const ids = store.getGraph('s1')!.nodes.map((n) => n.id);
    expect(ids).toContain('tool:tuH');
    expect(ids).toContain('late');
    const raw = store.rawForSession('s1');
    const hookAt = raw.findIndex((e) => e.source === 'hook');
    const lateAt = raw.findIndex((e) => e.source === 'transcript' && e.line.includes('"late"'));
    expect(hookAt).toBeGreaterThan(-1);
    expect(lateAt).toBeGreaterThan(hookAt);
  }, 60_000);

  test('10 万行的冷会话水合分页读取，事件循环间隔 < 100ms', async () => {
    const file = 'proj/s1.jsonl';
    for (let i = 0; i < 100_000; i++) {
      const ev = assistantBlock(`a${i}`, i ? `a${i - 1}` : null, { type: 'text', text: 'x'.repeat(450) });
      if (ev.source === 'transcript') store.insertRaw({ ...ev, file });
    }
    store.applyChanges([
      {
        type: 'session_upserted',
        session: {
          id: 's1', projectId: 'proj', cwd: null, title: null, gitBranch: null, status: 'idle',
          sourceDeleted: false, startedAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z',
        },
      },
    ]);
    const p2 = new Pipeline(store, config);
    const gap = await maxLoopGap(async () => {
      p2.ingestHook(
        'PreToolUse',
        's1',
        JSON.stringify({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, tool_use_id: 'tuH' }),
      );
      await p2.idle();
    });
    expect(gap).toBeLessThan(100);
    expect(store.getGraph('s1')!.nodes.map((n) => n.id)).toContain('tool:tuH');
  }, 180_000);

  test('文件数据库：导入期间到达的 hook 不让事件循环停顿超过 250ms', async () => {
    store.close();
    store = openStore(path.join(config.dataDir, 'data.db'));
    pipeline = new Pipeline(store, config);
    await write('proj/s1.jsonl', bigSession(20_000));
    await write('proj/s2.jsonl', bigSession(2_000));
    const gap = await maxLoopGap(async () => {
      const importing = pipeline.scanAll();
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 20));
        pipeline.ingestHook(
          'PreToolUse',
          's2',
          JSON.stringify({ session_id: 's2', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { i }, tool_use_id: `h${i}` }),
        );
      }
      await importing;
      await pipeline.idle();
    });
    expect(gap).toBeLessThan(250);
    expect(store.getGraph('s1')!.nodes).toHaveLength(20_000);
    expect(store.getGraph('s2')!.nodes.filter((n) => n.id.startsWith('tool:h'))).toHaveLength(20);
  }, 120_000);
});
