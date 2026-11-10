import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GraphSnapshot, SeqChange } from '@claude-canvas/shared';
import { loadConfig, type Config } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { startWatcher } from '../src/sources/transcript/watcher.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';
import { assistantBlock, toolResult, userPrompt } from './fixtures.js';

const line = (obj: unknown): string => JSON.stringify(obj) + '\n';
const linesOf = (events: RawEvent[]): string =>
  events.map((e) => (e.source === 'transcript' ? e.line : '') + '\n').join('');

describe('pipeline', () => {
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
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-pipeline-'));
    config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), rescanMs: 200 });
    await fs.mkdir(config.projectsDir, { recursive: true });
    store = openStore(':memory:');
    pipeline = new Pipeline(store, config);
  });
  afterEach(async () => {
    store.close();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  test('loadConfig applies defaults, env and overrides', () => {
    const d = loadConfig({});
    expect(d).toMatchObject({ host: '127.0.0.1', port: 4317, rescanMs: 3000, webDist: null });
    expect(d.dbPath).toBe(path.join(d.dataDir, 'data.db'));
    const e = loadConfig({ CLAUDE_CANVAS_DATA_DIR: '/d', CLAUDE_CANVAS_PROJECTS_DIR: '/p' }, { projectsDir: '/o' });
    expect(e.projectsDir).toBe('/o');
    expect(e.dataDir).toBe('/d');
    expect(e.dbPath).toBe(path.join('/d', 'data.db'));
  });

  test('ingestFile 把 JSONL 变成会话和节点', async () => {
    await write('proj/s1.jsonl', [userPrompt('u1', null, '你好'), assistantBlock('a1', 'u1', { type: 'text', text: 'hi' })]);
    await pipeline.ingestFile(abs('proj/s1.jsonl'));
    expect(store.listProjects()).toEqual([expect.objectContaining({ id: 'proj', sessionCount: 1 })]);
    expect(store.getGraph('s1')!.nodes.map((n) => n.id)).toEqual(['u1', 'a1']);
  });

  test('追加后再次 ingest 只处理新行', async () => {
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x')]);
    await pipeline.ingestFile(abs('proj/s1.jsonl'));
    const seen: SeqChange[] = [];
    pipeline.onChanges((c) => seen.push(...c));
    await append('proj/s1.jsonl', [assistantBlock('a1', 'u1', { type: 'text', text: 'hi' })]);
    await pipeline.ingestFile(abs('proj/s1.jsonl'));
    expect(seen.flatMap((c) => (c.type === 'node_added' ? [c.node.id] : []))).toEqual(['a1']);
  });

  test('子代理文件和 meta 归入同一会话并连上派发边', async () => {
    await write('proj/s1.jsonl', [
      userPrompt('u1', null, 'x'),
      assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Agent', input: {} }),
    ]);
    await write('proj/s1/subagents/agent-ag1.jsonl', [userPrompt('s1u', null, 'sub', { agentId: 'ag1' })]);
    await fs.writeFile(
      abs('proj/s1/subagents/agent-ag1.meta.json'),
      JSON.stringify({ toolUseId: 'tu1', agentType: 'Explore', description: 'd' }),
    );
    await pipeline.scanAll();
    expect(store.getGraph('s1')!.edges).toContainEqual(expect.objectContaining({ from: 'tool:tu1', to: 's1u', kind: 'spawn' }));
  });

  test('相同的 meta 内容在重启后也不会重复写入', async () => {
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x')]);
    await fs.mkdir(abs('proj/s1'), { recursive: true });
    await fs.writeFile(abs('proj/s1/custom-title.json'), JSON.stringify({ customTitle: 'T' }));
    await pipeline.scanAll();
    const count = (): number => store.rawForSession('s1').filter((e) => e.source === 'meta').length;
    expect(count()).toBe(1);
    await pipeline.ingestFile(abs('proj/s1/custom-title.json'));
    await new Pipeline(store, config).ingestFile(abs('proj/s1/custom-title.json'));
    expect(count()).toBe(1);
    expect(store.getSession('s1')!.title).toBe('T');
  });

  test('会话 id 取自文件名而非记录内容', async () => {
    await write('proj/real-id.jsonl', [userPrompt('u1', null, 'x', { sessionId: 'other' })]);
    await pipeline.ingestFile(abs('proj/real-id.jsonl'));
    expect(store.getSession('real-id')).not.toBeNull();
    expect(store.getSession('other')).toBeNull();
  });

  test('未知记录类型进入诊断统计', async () => {
    await fs.mkdir(abs('proj'), { recursive: true });
    await fs.writeFile(abs('proj/s1.jsonl'), line({ type: 'atis-latch', sessionId: 's1' }) + '{broken\n');
    await pipeline.ingestFile(abs('proj/s1.jsonl'));
    expect(store.diagnostics().unknownRecords.map((u) => u.recordType).sort()).toEqual(['atis-latch', 'invalid-json']);
  });

  test('hook 与 JSONL 合并；新建 Pipeline 后状态可续', async () => {
    pipeline.ingestHook(
      'PreToolUse',
      's1',
      JSON.stringify({ session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'tu1' }),
    );
    expect(pipeline.lastHookAt()).not.toBeNull();
    const p2 = new Pipeline(store, config);
    await write('proj/s1.jsonl', [
      userPrompt('u1', null, 'x'),
      assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }),
    ]);
    await p2.ingestFile(abs('proj/s1.jsonl'));
    const nodes = store.getGraph('s1')!.nodes;
    expect(nodes.filter((n) => n.id === 'tool:tu1')).toHaveLength(1);
    expect(nodes.find((n) => n.id === 'tool:tu1')).toMatchObject({ confirmed: true });
    expect(store.getSession('s1')!.projectId).toBe('proj');
  });

  test('rebuild 的结果与增量构建一致', async () => {
    await write('proj/s1.jsonl', [
      userPrompt('u1', null, 'x'),
      assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Read', input: {} }),
      toolResult('u2', 'a1', 'tu1', 'ok'),
    ]);
    await pipeline.ingestFile(abs('proj/s1.jsonl'));
    pipeline.ingestHook('Stop', 's1', JSON.stringify({ session_id: 's1' }));
    const strip = (g: GraphSnapshot) => ({ session: g.session, nodes: g.nodes, edges: g.edges });
    const before = strip(store.getGraph('s1')!);
    pipeline.rebuild();
    expect(strip(store.getGraph('s1')!)).toEqual(before);
  });

  test('文件被截断重写后不产生重复节点', async () => {
    const u1 = userPrompt('u1', null, 'x');
    await write('proj/s1.jsonl', [u1, assistantBlock('a1', 'u1', { type: 'text', text: 'hi' })]);
    await pipeline.ingestFile(abs('proj/s1.jsonl'));
    // identical records are re-written byte for byte, as when a file is truncated and replayed
    await write('proj/s1.jsonl', [u1]);
    await pipeline.ingestFile(abs('proj/s1.jsonl'));
    expect(store.getGraph('s1')!.nodes.map((n) => n.id)).toEqual(['u1', 'a1']);
  });

  test('源文件删除后会话标记 sourceDeleted，数据仍在', async () => {
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x')]);
    await pipeline.scanAll();
    await fs.rm(abs('proj/s1.jsonl'));
    await pipeline.scanAll();
    expect(store.getSession('s1')!.sourceDeleted).toBe(true);
    expect(store.getGraph('s1')!.nodes).toHaveLength(1);
    expect(store.getOffset(abs('proj/s1.jsonl'))).toBeGreaterThan(0);
  });

  test('并发的 ingestFile 调用被串行化且不重复处理', async () => {
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x'), assistantBlock('a1', 'u1', { type: 'text', text: 'hi' })]);
    await Promise.all([1, 2, 3, 4].map(() => pipeline.ingestFile(abs('proj/s1.jsonl'))));
    expect(store.getGraph('s1')!.nodes.map((n) => n.id)).toEqual(['u1', 'a1']);
    expect(store.rawForSession('s1')).toHaveLength(2);
  });

  test('大文件导入期间事件循环不被长时间占用', async () => {
    const big = Array.from({ length: 20_000 }, (_, i) =>
      assistantBlock(`a${i}`, i ? `a${i - 1}` : null, { type: 'text', text: 'x'.repeat(500) }),
    );
    await write('proj/s1.jsonl', big);
    let maxGap = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 5);
    await pipeline.ingestFile(abs('proj/s1.jsonl'));
    clearInterval(timer);
    expect(maxGap).toBeLessThan(100);
    expect(store.getGraph('s1')!.nodes).toHaveLength(20_000);
  }, 60_000);

  test('即使没有文件系统事件，定时扫描也能发现追加', async () => {
    const w = startWatcher(pipeline, { ...config, rescanMs: 200 });
    await w.ready;
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x')]);
    await vi.waitFor(() => expect(store.getSession('s1')).not.toBeNull(), { timeout: 5000 });
    await append('proj/s1.jsonl', [assistantBlock('a1', 'u1', { type: 'text', text: 'hi' })]);
    await vi.waitFor(() => expect(store.getGraph('s1')!.nodes).toHaveLength(2), { timeout: 5000 });
    await w.close();
  });
});
