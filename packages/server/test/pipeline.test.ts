import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GraphSnapshot, SeqChange } from '@claude-canvas/shared';
import { loadConfig, type Config } from '../src/config.js';
import { NORMALIZER_VERSION } from '../src/normalize/version.js';
import { Pipeline } from '../src/pipeline.js';
import { startWatcher } from '../src/sources/transcript/watcher.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';
import { assistantBlock, toolResult, userPrompt } from './fixtures.js';

const reads = vi.hoisted(() => ({ active: 0, max: 0, calls: 0, failFor: null as string | null }));
vi.mock('../src/sources/transcript/reader.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/sources/transcript/reader.js')>();
  return {
    ...orig,
    readNewLines: async (...args: Parameters<typeof orig.readNewLines>) => {
      if (args[0] === reads.failFor) throw Object.assign(new Error('EPERM: simulated'), { code: 'EPERM' });
      reads.calls += 1;
      reads.active += 1;
      reads.max = Math.max(reads.max, reads.active);
      try {
        return await orig.readNewLines(...args);
      } finally {
        reads.active -= 1;
      }
    },
  };
});

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
    reads.failFor = null;
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
    expect(store.getOffset('proj/s1.jsonl')).toBeGreaterThan(0);
  });

  test('并发的 ingestFile 调用被串行化且不重复处理', async () => {
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x'), assistantBlock('a1', 'u1', { type: 'text', text: 'hi' })]);
    reads.max = 0;
    await Promise.all([1, 2, 3, 4].map(() => pipeline.ingestFile(abs('proj/s1.jsonl'))));
    expect(reads.max).toBe(1); // never two reads of the same file in flight
    expect(store.getGraph('s1')!.nodes.map((n) => n.id)).toEqual(['u1', 'a1']);
    expect(store.rawForSession('s1')).toHaveLength(2);
  });

  test('即使没有文件系统事件，定时扫描也能发现追加', async () => {
    const w = startWatcher(pipeline, { ...config, rescanMs: 200 });
    try {
      await w.ready;
      await write('proj/s1.jsonl', [userPrompt('u1', null, 'x')]);
      await vi.waitFor(() => expect(store.getSession('s1')).not.toBeNull(), { timeout: 5000 });
      await append('proj/s1.jsonl', [assistantBlock('a1', 'u1', { type: 'text', text: 'hi' })]);
      await vi.waitFor(() => expect(store.getGraph('s1')!.nodes).toHaveLength(2), { timeout: 5000 });
    } finally {
      await w.close();
    }
  });

  test('只有空行的读取也会保存偏移，rescan 不再重复导入', async () => {
    const file = abs('proj/s1.jsonl');
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x')]);
    await fs.appendFile(file, '\r\n\n\r\n');
    await pipeline.ingestFile(file);
    const size = (await fs.stat(file)).size;
    expect(store.getOffset('proj/s1.jsonl')).toBe(size);
    expect(store.diagnostics().files).toContainEqual({ path: 'proj/s1.jsonl', offset: size, size });
    await fs.appendFile(file, '\n\n'); // blank-only growth
    await pipeline.ingestFile(file);
    const size2 = (await fs.stat(file)).size;
    expect(store.diagnostics().files).toContainEqual({ path: 'proj/s1.jsonl', offset: size2, size: size2 });
  });

  test('sourceDeleted 是粘性的：之后的 hook 不会清除它', async () => {
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x')]);
    await pipeline.scanAll();
    await fs.rm(abs('proj/s1.jsonl'));
    await pipeline.scanAll();
    pipeline.ingestHook('Stop', 's1', JSON.stringify({ session_id: 's1', hook_event_name: 'Stop' }));
    await pipeline.idle();
    expect(store.getSession('s1')!.sourceDeleted).toBe(true);
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x')]);
    await pipeline.ingestFile(abs('proj/s1.jsonl'));
    expect(store.getSession('s1')!.sourceDeleted).toBe(false);
  });

  test('一个读不了的文件不会中断 scanAll / rescan', async () => {
    await write('proj/aaa.jsonl', [userPrompt('b1', null, 'x')]);
    reads.failFor = abs('proj/aaa.jsonl'); // simulates EPERM / EBUSY on one file
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x')]);
    await pipeline.scanAll();
    expect(store.getSession('s1')).not.toBeNull();
    expect(pipeline.ingestFailures().map((f) => f.file)).toEqual(['proj/aaa.jsonl']); // group 10: relative path
    await append('proj/s1.jsonl', [assistantBlock('a1', 'u1', { type: 'text', text: 'hi' })]);
    // Ruling 9: s1 is cold (evicted after the scan), so its append is found by the full scan, not the hot rescan.
    await pipeline.scanAll();
    expect(store.getGraph('s1')!.nodes).toHaveLength(2);
    // A file with a recorded failure is retried by every rescan.
    reads.failFor = null;
    await pipeline.rescan();
    expect(store.getSession('aaa')).not.toBeNull();
    expect(pipeline.ingestFailures()).toEqual([]);
  });

  test('rescan 与 lastHookAt 不会反复调用 diagnostics', async () => {
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x')]);
    const p2 = new Pipeline(store, config);
    const spy = vi.spyOn(store, 'diagnostics');
    await p2.scanAll();
    await p2.rescan();
    await p2.rescan();
    p2.lastHookAt();
    p2.ingestHook('Stop', 's1', JSON.stringify({ session_id: 's1', hook_event_name: 'Stop' }));
    expect(p2.lastHookAt()).not.toBeNull();
    // Ruling 6d: the pipeline never calls diagnostics() (it scanned raw_event for the last hook time).
    expect(spy).not.toHaveBeenCalled();
  });

  test('重启后 scanAll 不会为未变化的 meta 文件读取会话历史', async () => {
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x')]);
    await fs.mkdir(abs('proj/s1'), { recursive: true });
    await fs.writeFile(abs('proj/s1/custom-title.json'), JSON.stringify({ customTitle: 'T' }));
    await pipeline.scanAll();
    const spy = vi.spyOn(store, 'rawForSession');
    await new Pipeline(store, config).scanAll();
    expect(spy).not.toHaveBeenCalled();
  });

  test('scanAll 后久未活动的会话不留在内存里，之后追加仍然正确', async () => {
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x'), assistantBlock('a1', 'u1', { type: 'text', text: 'hi' })]);
    await write('proj/s2.jsonl', [userPrompt('v1', null, 'y')]);
    await pipeline.scanAll();
    expect(pipeline.loadedSessionCount()).toBe(0);
    await append('proj/s1.jsonl', [assistantBlock('a2', 'a1', { type: 'text', text: 'more' })]);
    await pipeline.ingestFile(abs('proj/s1.jsonl'));
    expect(store.getGraph('s1')!.nodes.map((n) => n.id)).toEqual(['u1', 'a1', 'a2']);
    expect(store.getGraph('s2')!.nodes.map((n) => n.id)).toEqual(['v1']);
  });

  test('rescan 淘汰超过 evictAfterMs 未被触碰的会话', async () => {
    const p = new Pipeline(store, { ...config, evictAfterMs: 50 });
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x')]);
    await p.ingestFile(abs('proj/s1.jsonl'));
    expect(p.loadedSessionCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 120));
    await p.rescan();
    expect(p.loadedSessionCount()).toBe(0);
  });
  test('rebuild 在有待处理工作时抛错；rebuild 后不留下未被追踪的会话', async () => {
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x')]);
    const pending = pipeline.ingestFile(abs('proj/s1.jsonl'));
    expect(() => pipeline.rebuild()).toThrow(/pending/);
    await pending;
    expect(pipeline.loadedSessionCount()).toBe(1);
    pipeline.rebuild();
    expect(pipeline.loadedSessionCount()).toBe(0);
    await append('proj/s1.jsonl', [assistantBlock('a1', 'u1', { type: 'text', text: 'hi' })]);
    await pipeline.ingestFile(abs('proj/s1.jsonl'));
    expect(store.getGraph('s1')!.nodes.map((n) => n.id)).toEqual(['u1', 'a1']);
  });

  test('文件重建（大小不变）或重启后，粘性的 sourceDeleted 会被清除', async () => {
    const events = [userPrompt('u1', null, 'x')];
    await write('proj/s1.jsonl', events);
    await pipeline.scanAll();
    await fs.rm(abs('proj/s1.jsonl'));
    await pipeline.scanAll();
    expect(store.getSession('s1')!.sourceDeleted).toBe(true);
    await write('proj/s1.jsonl', events); // same bytes, same size
    await pipeline.scanAll(); // ruling 9: deletion state comes from the full scan's directory listing
    expect(store.getSession('s1')!.sourceDeleted).toBe(false);

    await fs.rm(abs('proj/s1.jsonl'));
    await pipeline.scanAll();
    expect(store.getSession('s1')!.sourceDeleted).toBe(true);
    await write('proj/s1.jsonl', events);
    await new Pipeline(store, config).scanAll(); // restart: no in-memory flag
    expect(store.getSession('s1')!.sourceDeleted).toBe(false);
  });

  test('排队的 hook 在水合失败时记录错误且原始事件不丢', async () => {
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x')]);
    await pipeline.ingestFile(abs('proj/s1.jsonl'));
    const p2 = new Pipeline(store, config);
    vi.spyOn(store, 'rawForSessionAfter').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    p2.ingestHook('Stop', 's1', JSON.stringify({ session_id: 's1', hook_event_name: 'Stop' }));
    await p2.idle();
    expect(p2.ingestFailures()).toContainEqual(expect.objectContaining({ file: 'hook:s1', error: 'boom' }));
    expect(store.rawForSession('s1').filter((e) => e.source === 'hook')).toHaveLength(1);
    // the next event hydrates normally
    await append('proj/s1.jsonl', [assistantBlock('a1', 'u1', { type: 'text', text: 'hi' })]);
    await p2.ingestFile(abs('proj/s1.jsonl'));
    expect(store.getGraph('s1')!.nodes.map((n) => n.id)).toEqual(['u1', 'a1']);
  });

  test('meta 变化时不加载整个会话历史', async () => {
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x')]);
    await fs.mkdir(abs('proj/s1'), { recursive: true });
    await fs.writeFile(abs('proj/s1/custom-title.json'), JSON.stringify({ customTitle: 'T' }));
    await pipeline.scanAll();
    await fs.writeFile(abs('proj/s1/custom-title.json'), JSON.stringify({ customTitle: 'T2' }));
    const spy = vi.spyOn(store, 'rawForSession');
    await new Pipeline(store, config).ingestFile(abs('proj/s1/custom-title.json'));
    expect(spy).not.toHaveBeenCalled();
    expect(store.getSession('s1')!.title).toBe('T2');
  });

  // ---- final fix wave, group 5: location-independent raw events, hook project ----

  test('原始记录和偏移用相对 projectsDir 的 / 路径保存', async () => {
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x'), assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Agent', input: {} })]);
    await write('proj/s1/subagents/agent-ag1.jsonl', [userPrompt('s1u', null, 'sub', { agentId: 'ag1' })]);
    await fs.writeFile(abs('proj/s1/subagents/agent-ag1.meta.json'), JSON.stringify({ toolUseId: 'tu1', agentType: 'Explore', description: 'd' }));
    await pipeline.scanAll();
    const files = new Set(store.rawForSession('s1').map((e) => (e.source === 'hook' ? null : e.file)));
    expect(files).toEqual(new Set(['proj/s1.jsonl', 'proj/s1/subagents/agent-ag1.jsonl', 'proj/s1/subagents/agent-ag1.meta.json']));
    expect(store.diagnostics().files.map((f) => f.path).sort()).toEqual([
      'proj/s1.jsonl',
      'proj/s1/subagents/agent-ag1.jsonl',
      'proj/s1/subagents/agent-ag1.meta.json',
    ]);
    expect(store.getOffset('proj/s1.jsonl')).toBeGreaterThan(0);
  });

  test('移动 projectsDir 后不重复导入，历史与重建都不丢', async () => {
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x')]);
    await pipeline.scanAll();
    const rawBefore = store.rawForSession('s1').length;
    const moved = path.join(tmp, 'moved');
    await fs.rename(config.projectsDir, moved);
    const cfg2 = { ...config, projectsDir: moved };
    const p2 = new Pipeline(store, cfg2);
    const added: string[] = [];
    p2.onChanges((cs) => cs.forEach((c) => c.type === 'node_added' && added.push(c.node.id)));
    await p2.scanAll();
    expect(store.rawForSession('s1')).toHaveLength(rawBefore);
    expect(added).toEqual([]);
    expect(store.getSession('s1')!.sourceDeleted).toBe(false);
    await fs.appendFile(path.join(moved, 'proj', 's1.jsonl'), linesOf([assistantBlock('a1', 'u1', { type: 'text', text: 'hi' })]));
    await p2.ingestFile(path.join(moved, 'proj', 's1.jsonl'));
    expect(added).toEqual(['a1']);
    p2.rebuild();
    expect(store.getSession('s1')!.projectId).toBe('proj');
    expect(store.getGraph('s1')!.nodes.map((n) => n.id)).toEqual(['u1', 'a1']);
  });

  test.runIf(process.platform === 'win32')('projectsDir 大小写变化不会重复导入', async () => {
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x')]);
    await pipeline.scanAll();
    const rawBefore = store.rawForSession('s1').length;
    const p2 = new Pipeline(store, { ...config, projectsDir: config.projectsDir.toUpperCase() });
    await p2.scanAll();
    expect(store.rawForSession('s1')).toHaveLength(rawBefore);
    expect(store.diagnostics().files.map((f) => f.path)).toEqual(['proj/s1.jsonl']);
  });

  test('未知会话的 hook 从 transcript_path 得出 projectId，并保存供重放', async () => {
    const payload = (sid: string, tp: string) => JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', transcript_path: tp });
    pipeline.ingestHook('UserPromptSubmit', 'h1', payload('h1', abs('proj/h1.jsonl')), abs('proj/h1.jsonl'));
    pipeline.ingestHook('UserPromptSubmit', 'h2', payload('h2', '/elsewhere/x.jsonl'), '/elsewhere/x.jsonl');
    pipeline.ingestHook('UserPromptSubmit', 'h3', payload('h3', abs('proj/h1/subagents/agent-z.jsonl')), abs('proj/h1/subagents/agent-z.jsonl'));
    await pipeline.idle();
    expect(store.getSession('h1')!.projectId).toBe('proj');
    expect(store.getSession('h2')!.projectId).toBe('unknown');
    expect(store.getSession('h3')!.projectId).toBe('proj');
    expect(store.rawForSession('h1')[0]).toMatchObject({ source: 'hook', projectId: 'proj' });
    expect(store.rawForSession('h2')[0]).toMatchObject({ source: 'hook', projectId: null });
    pipeline.rebuild();
    expect(store.getSession('h1')!.projectId).toBe('proj');
    expect(store.getSession('h2')!.projectId).toBe('unknown');
  });

  // ---- final fix wave, group 6: atomic slices, no raw_event scans on hot paths ----

  /** The real store, except that `method` throws on its first call (or on every call while `fail.on`). */
  function failingOnce<K extends keyof Store>(method: K): Store & { fail: { on: boolean } } {
    const fail = { on: true };
    const real = store[method] as unknown as (...args: unknown[]) => unknown;
    const wrapped = {
      ...store,
      fail,
      [method]: (...args: unknown[]) => {
        if (fail.on) {
          fail.on = false;
          throw new Error('simulated crash');
        }
        return real(...args);
      },
    };
    return wrapped as unknown as Store & { fail: { on: boolean } };
  }

  test('读取片段是原子的：中途失败时不留下任何东西，重试后完整导入', async () => {
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x'), assistantBlock('a1', 'u1', { type: 'text', text: 'hi' })]);
    const s2 = failingOnce('setOffset');
    const p = new Pipeline(s2, config);
    const seen: SeqChange[] = [];
    p.onChanges((c) => seen.push(...c));
    await expect(p.ingestFile(abs('proj/s1.jsonl'))).rejects.toThrow('simulated crash');
    expect(store.rawForSession('s1')).toEqual([]);
    expect(store.getSession('s1')).toBeNull();
    expect(store.changesSince(0)).toEqual([]);
    expect(store.getOffset('proj/s1.jsonl')).toBe(0);
    expect(seen).toEqual([]);
    expect(p.loadedSessionCount()).toBe(0);
    await p.ingestFile(abs('proj/s1.jsonl'));
    expect(store.getGraph('s1')!.nodes.map((n) => n.id)).toEqual(['u1', 'a1']);
    expect(store.rawForSession('s1')).toHaveLength(2);
  });

  test('已有会话的片段失败后，重试结果与一次成功相同', async () => {
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x')]);
    await pipeline.ingestFile(abs('proj/s1.jsonl'));
    await append('proj/s1.jsonl', [assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Read', input: {} })]);
    const s2 = failingOnce('applyChanges');
    const p = new Pipeline(s2, config);
    await p.ingestFile(abs('proj/s1.jsonl')).catch(() => undefined);
    await append('proj/s1.jsonl', [toolResult('u2', 'a1', 'tu1', 'ok')]);
    await p.ingestFile(abs('proj/s1.jsonl'));
    expect(store.getGraph('s1')!.nodes.map((n) => [n.id, n.status])).toEqual([['u1', null], ['tool:tu1', 'succeeded']]);
  });

  test('meta 导入是原子的', async () => {
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x')]);
    await pipeline.ingestFile(abs('proj/s1.jsonl'));
    await fs.mkdir(abs('proj/s1'), { recursive: true });
    await fs.writeFile(abs('proj/s1/custom-title.json'), JSON.stringify({ customTitle: 'T' }));
    const p = new Pipeline(failingOnce('setOffset'), config);
    await expect(p.ingestFile(abs('proj/s1/custom-title.json'))).rejects.toThrow('simulated crash');
    expect(store.rawForSession('s1').filter((e) => e.source === 'meta')).toEqual([]);
    expect(store.getSession('s1')!.title).toBeNull();
    await p.ingestFile(abs('proj/s1/custom-title.json'));
    expect(store.getSession('s1')!.title).toBe('T');
  });

  test('hook 导入是原子的：失败时派生数据不落库，原始事件只保留一份供重建', async () => {
    const p = new Pipeline(failingOnce('applyChanges'), config);
    expect(() => p.ingestHook('UserPromptSubmit', 'n1', JSON.stringify({ session_id: 'n1', hook_event_name: 'UserPromptSubmit' }))).not.toThrow();
    await p.idle();
    expect(store.getSession('n1')).toBeNull();
    expect(store.rawForSession('n1')).toHaveLength(1);
    expect(p.ingestFailures().map((f) => f.file)).toContain('hook:n1');
    p.rebuild();
    expect(store.getSession('n1')!.status).toBe('running');
  });

  test('管线的热路径不发出扫描 raw_event 的查询', async () => {
    const sql: string[] = [];
    const s = openStore(':memory:', { verbose: (q) => sql.push(String(q)) });
    try {
      await write('proj/s1.jsonl', [userPrompt('u1', null, 'x')]);
      const p = new Pipeline(s, config);
      await p.scanAll();
      await p.rescan();
      p.ingestHook('Stop', 's1', JSON.stringify({ session_id: 's1', hook_event_name: 'Stop' }));
      p.lastHookAt();
      await p.idle();
      const scans = sql.filter((q) => /FROM raw_event/i.test(q) && !/WHERE[^]*(session_id|file|line_hash)\s*=/i.test(q));
      expect(sql.length).toBeGreaterThan(0);
      expect(scans).toEqual([]);
      expect(sql.some((q) => /MAX\(received_at\)/i.test(q))).toBe(false);
    } finally {
      s.close();
    }
  });

  // ---- final fix wave, group 8: per-session paged rebuild ----

  test('rebuild 逐个会话进行，内存里最多只有一个会话的状态', async () => {
    for (let k = 0; k < 6; k++) {
      await write(`proj/s${k}.jsonl`, [userPrompt(`u${k}`, null, 'x'), assistantBlock(`a${k}`, `u${k}`, { type: 'text', text: 'hi' })]);
    }
    await pipeline.scanAll();
    const before = Array.from({ length: 6 }, (_, k) => store.getGraph(`s${k}`)!.nodes);
    let maxLoaded = 0;
    let commits = 0;
    const real = store.applyChanges.bind(store);
    const spy = vi.spyOn(store, 'applyChanges').mockImplementation((cs) => {
      commits += 1;
      maxLoaded = Math.max(maxLoaded, pipeline.loadedSessionCount());
      return real(cs);
    });
    try {
      pipeline.rebuild();
    } finally {
      spy.mockRestore();
    }
    expect(commits).toBeGreaterThanOrEqual(6);
    expect(maxLoaded).toBe(1);
    expect(pipeline.loadedSessionCount()).toBe(0);
    expect(Array.from({ length: 6 }, (_, k) => store.getGraph(`s${k}`)!.nodes)).toEqual(before);
  });

  test('rebuild 清空并重新统计 unknown_stat', async () => {
    await fs.mkdir(abs('proj'), { recursive: true });
    await fs.writeFile(abs('proj/s1.jsonl'), line({ type: 'atis-latch', sessionId: 's1' }) + line({ type: 'atis-latch', n: 2 }) + '{broken\n');
    await pipeline.ingestFile(abs('proj/s1.jsonl'));
    const before = store.diagnostics().unknownRecords;
    store.bumpUnknown('stale-type', 'x');
    pipeline.rebuild();
    expect(store.diagnostics().unknownRecords).toEqual(before);
  });

  test('rebuild 可重启：中途失败时留下标记，再次运行后完整', async () => {
    for (let k = 0; k < 3; k++) await write(`proj/s${k}.jsonl`, [userPrompt(`u${k}`, null, 'x')]);
    await pipeline.scanAll();
    let calls = 0;
    const real = store.applyChanges.bind(store);
    const spy = vi.spyOn(store, 'applyChanges').mockImplementation((cs) => {
      calls += 1;
      if (calls === 2) throw new Error('killed');
      return real(cs);
    });
    expect(() => pipeline.rebuild()).toThrow('killed');
    spy.mockRestore();
    expect(store.getMeta('rebuild_in_progress')).toBe('1');
    pipeline.rebuild();
    expect(store.getMeta('rebuild_in_progress')).toBeNull();
    expect(store.getMeta('normalizer_version')).toBe(String(NORMALIZER_VERSION));
    for (let k = 0; k < 3; k++) expect(store.getGraph(`s${k}`)!.nodes.map((n) => n.id)).toEqual([`u${k}`]);
  });

  // ---- final fix wave, group 9: scan cadences and eviction ----

  test('删除检测使用目录列表，不逐个 existsSync', async () => {
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x')]);
    await write('proj/s2.jsonl', [userPrompt('v1', null, 'x')]);
    await pipeline.scanAll();
    await fs.rm(abs('proj/s2.jsonl'));
    const spy = vi.spyOn(fsSync, 'existsSync');
    try {
      await pipeline.scanAll();
      await pipeline.rescan();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(store.getSession('s2')!.sourceDeleted).toBe(true);
    expect(store.getSession('s1')!.sourceDeleted).toBe(false);
  });

  test('rescan 只检查热会话的文件和失败过的文件', async () => {
    for (const k of ['s1', 's2', 's3']) await write(`proj/${k}.jsonl`, [userPrompt(`u-${k}`, null, 'x')]);
    await pipeline.scanAll(); // all cold afterwards (old timestamps)
    expect(pipeline.loadedSessionCount()).toBe(0);
    await append('proj/s1.jsonl', [assistantBlock('a1', 'u-s1', { type: 'text', text: 'hi' })]);
    await pipeline.ingestFile(abs('proj/s1.jsonl')); // s1 is hot now
    await append('proj/s1.jsonl', [assistantBlock('a2', 'a1', { type: 'text', text: 'more' })]);
    await append('proj/s2.jsonl', [assistantBlock('b1', 'u-s2', { type: 'text', text: 'cold' })]);
    const spy = vi.spyOn(fs, 'stat');
    let statted: string[];
    try {
      await pipeline.rescan();
      statted = spy.mock.calls.map((c) => path.relative(config.projectsDir, String(c[0])).split(path.sep).join('/'));
    } finally {
      spy.mockRestore();
    }
    expect([...new Set(statted)]).toEqual(['proj/s1.jsonl']);
    expect(store.getGraph('s1')!.nodes.map((n) => n.id)).toEqual(['u-s1', 'a1', 'a2']);
    expect(store.getGraph('s2')!.nodes.map((n) => n.id)).toEqual(['u-s2']); // waits for the full scan
    await pipeline.scanAll();
    expect(store.getGraph('s2')!.nodes.map((n) => n.id)).toEqual(['u-s2', 'b1']);
  });

  test('fullScanMs 默认 60 秒；watcher 按两种节奏扫描', async () => {
    expect(loadConfig({}).fullScanMs).toBe(60_000);
    const scans = vi.spyOn(pipeline, 'scanAll');
    const rescans = vi.spyOn(pipeline, 'rescan');
    const w = startWatcher(pipeline, { ...config, rescanMs: 50, fullScanMs: 300 });
    try {
      await w.ready;
      await new Promise((r) => setTimeout(r, 750));
    } finally {
      await w.close();
    }
    expect(scans.mock.calls.length).toBeGreaterThanOrEqual(2); // initial + periodic
    expect(scans.mock.calls.length).toBeLessThanOrEqual(4);
    expect(rescans.mock.calls.length).toBeGreaterThan(scans.mock.calls.length);
  });

  test('只有半行时记录文件大小，rescan 不再反复打开文件；补全后照常读到', async () => {
    const file = abs('proj/s1.jsonl');
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x')]);
    const partial = JSON.stringify(JSON.parse(linesOf([assistantBlock('a1', 'u1', { type: 'text', text: 'hi' })])));
    await fs.appendFile(file, partial.slice(0, 20));
    await pipeline.ingestFile(file);
    const size = (await fs.stat(file)).size;
    expect(store.diagnostics().files).toContainEqual({ path: 'proj/s1.jsonl', offset: size - 20, size });
    reads.calls = 0;
    await pipeline.rescan();
    await pipeline.rescan();
    await new Pipeline(store, config).scanAll(); // a full scan (another instance, so s1 stays hot here) skips it too
    expect(reads.calls).toBe(0);
    await fs.appendFile(file, partial.slice(20) + '\n');
    await pipeline.rescan();
    expect(store.getGraph('s1')!.nodes.map((n) => n.id)).toEqual(['u1', 'a1']);
  });

  test('运行中且最近有活动的会话不会被淘汰', async () => {
    const now = new Date().toISOString();
    const p = new Pipeline(store, { ...config, evictAfterMs: 50 });
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x', { timestamp: now })]); // running, fresh
    await write('proj/s2.jsonl', [
      userPrompt('v1', null, 'x', { timestamp: now }),
      assistantBlock('v2', 'v1', { type: 'text', text: 'done' }, { stopReason: 'end_turn', timestamp: now }),
    ]); // idle, fresh
    await p.ingestFile(abs('proj/s1.jsonl'));
    await p.ingestFile(abs('proj/s2.jsonl'));
    expect(store.getSession('s1')!.status).toBe('running');
    expect(store.getSession('s2')!.status).toBe('idle');
    await new Promise((r) => setTimeout(r, 120));
    await p.rescan();
    expect(p.loadedSessionCount()).toBe(1);
    await p.scanAll();
    expect(p.loadedSessionCount()).toBe(1);
  });

  test('水合按行数和字节数分页（每页至少一行）', async () => {
    const file = 'proj/s1.jsonl';
    for (let i = 0; i < 6; i++) {
      const ev = assistantBlock(`a${i}`, i ? `a${i - 1}` : null, { type: 'text', text: 'x'.repeat(100_000) });
      if (ev.source === 'transcript') store.insertRaw({ ...ev, file });
    }
    expect(store.rawForSessionAfter('s1', 0, 200, 256 * 1024)).toHaveLength(3);
    expect(store.rawForSessionAfter('s1', 0, 200, 10)).toHaveLength(1);
    expect(store.rawForSessionAfter('s1', 0, 2, 10 ** 9)).toHaveLength(2);
    store.applyChanges([
      {
        type: 'session_upserted',
        session: {
          id: 's1', projectId: 'proj', cwd: null, title: null, gitBranch: null, status: 'idle',
          sourceDeleted: false, startedAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z',
        },
      },
    ]);
    const spy = vi.spyOn(store, 'rawForSessionAfter');
    const p = new Pipeline(store, config);
    p.ingestHook('Stop', 's1', JSON.stringify({ session_id: 's1', hook_event_name: 'Stop' }));
    await p.idle();
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of spy.mock.calls) expect(call.slice(2)).toEqual([200, 256 * 1024]);
  });

  // ---- final fix wave, group 10: visibility of failures ----

  test('ingestFailures 带时间，失败写到日志且每个文件每分钟最多一行', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));
      const lines: string[] = [];
      const p = new Pipeline(store, config, { log: (l) => lines.push(l) });
      await write('proj/aaa.jsonl', [userPrompt('b1', null, 'secret prompt text')]);
      reads.failFor = abs('proj/aaa.jsonl');
      await p.scanAll();
      expect(p.ingestFailures()).toEqual([{ file: 'proj/aaa.jsonl', error: 'EPERM: simulated', at: '2026-03-01T00:00:00.000Z' }]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('proj/aaa.jsonl');
      expect(lines[0]).toContain('EPERM: simulated');
      expect(lines[0]).not.toContain('secret');
      await p.rescan();
      await p.scanAll();
      expect(lines).toHaveLength(1);
      vi.setSystemTime(new Date('2026-03-01T00:01:01.000Z'));
      await p.rescan();
      expect(lines).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('被吞掉的 hook 失败也写日志', async () => {
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x')]);
    await pipeline.ingestFile(abs('proj/s1.jsonl'));
    const lines: string[] = [];
    const p2 = new Pipeline(store, config, { log: (l) => lines.push(l) });
    vi.spyOn(store, 'rawForSessionAfter').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    p2.ingestHook('Stop', 's1', JSON.stringify({ session_id: 's1', hook_event_name: 'Stop', last_assistant_message: 'private' }));
    await p2.idle();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('hook:s1');
    expect(lines[0]).toContain('boom');
    expect(lines[0]).not.toContain('private');
  });

  test('importing 在首次全量扫描和重建期间为 true', async () => {
    await write('proj/s1.jsonl', [userPrompt('u1', null, 'x')]);
    expect(pipeline.importing()).toBe(false);
    const scanning = pipeline.scanAll();
    expect(pipeline.importing()).toBe(true);
    await scanning;
    expect(pipeline.importing()).toBe(false);
    const seen: boolean[] = [];
    const real = store.applyChanges.bind(store);
    const spy = vi.spyOn(store, 'applyChanges').mockImplementation((cs) => {
      seen.push(pipeline.importing());
      return real(cs);
    });
    try {
      pipeline.rebuild();
    } finally {
      spy.mockRestore();
    }
    expect(seen).toContain(true);
    expect(pipeline.importing()).toBe(false);
    await write('proj/s2.jsonl', [userPrompt('v1', null, 'x')]);
    const later = pipeline.scanAll(); // periodic full scans are not "importing"
    expect(pipeline.importing()).toBe(false);
    await later;
  });
});
