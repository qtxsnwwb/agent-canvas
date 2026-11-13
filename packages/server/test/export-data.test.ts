import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  defaultExportOptions,
  EXPORT_OUTPUT_HEAD_BYTES,
  type ExportBundle,
  type ExportOptions,
  type NodeDetail,
} from '@agent-canvas/shared';
import { assembleExport, ExportAbortedError, type AssembleContext, type ExportSource } from '../src/export/assemble.js';
import { fence, renderMarkdown } from '../src/export/markdown.js';
import { openStore, type Store } from '../src/store/store.js';
import { FAKE_KEY, makeNode, makeSession, threeTurns } from './export-fixtures.js';

const base: ExportOptions = defaultExportOptions(false);
const opts = (o: Partial<ExportOptions> = {}): ExportOptions => ({ ...base, ...o });
const ctx = (o: Partial<AssembleContext> = {}): AssembleContext => ({
  customTerms: [],
  homeUsers: [],
  version: '9.9.9',
  now: new Date('2026-11-13T08:00:00.000Z'),
  mode: 'bundle',
  extraBytes: 0,
  ...o,
});

let store: Store;
beforeEach(() => {
  store = openStore(':memory:');
});
afterEach(() => {
  store.close();
});

async function bundleOf(o: Partial<ExportOptions> = {}, c: Partial<AssembleContext> = {}, source: ExportSource = store): Promise<ExportBundle> {
  const r = await assembleExport(source, 's1', opts(o), ctx(c));
  if (r.kind !== 'done' || r.bundle === null) throw new Error(`no bundle: ${JSON.stringify(r)}`);
  return r.bundle;
}
const ids = (b: ExportBundle): string[] => b.nodes.map((n) => n.id).sort();

describe('导出数据：范围', () => {
  beforeEach(() => {
    store.applyChanges(threeTurns());
  });

  test('整个会话：所有节点和边，详情不含原始记录', async () => {
    const b = await bundleOf();
    expect(b.version).toBe(1);
    expect(b.tool).toEqual({ name: 'Agent Canvas', version: '9.9.9' });
    expect(b.exportedAt).toBe('2026-11-13T08:00:00.000Z');
    expect(b.nodes).toHaveLength(12);
    expect(b.edges).toHaveLength(11);
    expect(b.details.b1).toEqual({ nodeId: 'b1', input: { command: 'ls' }, output: 'out one', text: null, raw: null });
    expect(JSON.stringify(b)).not.toContain('RAW-MARKER');
    expect(b.turnNumber).toBeUndefined();
    // Snapshot (store) order.
    expect(b.nodes.map((n) => n.id)).toEqual(store.getGraph('s1')!.nodes.map((n) => n.id));
  });

  test('一轮：主线节点、它派出的子代理（含嵌套）及其内部节点、相关的边', async () => {
    const b = await bundleOf({ scope: { kind: 'turn', turnKey: 'T2' } });
    expect(ids(b)).toEqual(['a1-1', 'a1-2', 'a2-1', 'd2', 'p2', 'th2']);
    expect(b.edges.map((e) => e.id).sort()).toEqual(['a1-1->a1-2', 'a1-2->a2-1', 'd2->a1-1', 'd2->th2', 'p2->d2']);
    expect(b.turnNumber).toBe(2);
  });

  test('不认识的轮次', async () => {
    expect((await assembleExport(store, 's1', opts({ scope: { kind: 'turn', turnKey: 'nope' } }), ctx())).kind).toBe('unknown-turn');
  });

  test('不存在的会话', async () => {
    expect((await assembleExport(store, 'nope', opts(), ctx())).kind).toBe('not-found');
  });

  test('不含思考：去掉思考节点和连到它们的边，不重新连接', async () => {
    const b = await bundleOf({ thinking: false });
    expect(ids(b)).not.toContain('th1');
    expect(ids(b)).not.toContain('th2');
    expect(b.edges.some((e) => e.from === 'th1' || e.to === 'th1')).toBe(false);
    expect(b.edges.some((e) => e.from === 'x1' && e.to === 'b1')).toBe(false);
  });

  test('不含子代理内部：去掉 agentId 非空的节点，保留派发节点', async () => {
    const b = await bundleOf({ subagents: false });
    expect(ids(b)).toEqual(['b1', 'b3', 'd2', 'p1', 'p2', 'p3', 'th1', 'th2', 'x1']);
  });

  test('工具输出：不含', async () => {
    const b = await bundleOf({ output: 'none' });
    expect(b.details.b1!.output).toBeNull();
    expect(b.details.b1!.input).toEqual({ command: 'ls' });
  });
});

describe('导出数据：输出截断', () => {
  test('每步前 8 KB：遮蔽后在字符边界上截断，记下原始大小；全部：不截断', async () => {
    const big = '中'.repeat(4000) + FAKE_KEY; // 12,000 bytes of text, the key after the cut
    store.applyChanges([
      { type: 'session_upserted', session: makeSession('s1') },
      { type: 'node_added', node: makeNode('s1', 'n1', 0), detail: { output: big } },
      { type: 'node_added', node: makeNode('s1', 'n2', 1), detail: { output: [{ type: 'text', text: 'y'.repeat(9000) }] } },
    ]);
    const head = await bundleOf();
    const out = head.details.n1!.output as string;
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(EXPORT_OUTPUT_HEAD_BYTES);
    expect(out).toBe('中'.repeat(Math.floor(EXPORT_OUTPUT_HEAD_BYTES / 3)));
    expect(head.truncations.n1).toEqual({ originalBytes: Buffer.byteLength('中'.repeat(4000) + '‹已遮蔽·OpenAI key#1›') });
    // A structured output over the limit becomes cut JSON text.
    expect(typeof head.details.n2!.output).toBe('string');
    expect(head.truncations.n2!.originalBytes).toBeGreaterThan(9000);
    // The key behind the cut was masked first (it is counted).
    expect(head.report.byType['openai-key']).toEqual({ occurrences: 1, distinct: 1 });

    const full = await bundleOf({ output: 'full' });
    expect(full.details.n1!.output).toBe('中'.repeat(4000) + '‹已遮蔽·OpenAI key#1›');
    expect(full.truncations).toEqual({});
  });

  test('截断点落在密钥中间时，密钥不会露出一半', async () => {
    const before = 'a'.repeat(EXPORT_OUTPUT_HEAD_BYTES - 11) + ' ';
    store.applyChanges([
      { type: 'session_upserted', session: makeSession('s1') },
      { type: 'node_added', node: makeNode('s1', 'n1', 0), detail: { output: before + FAKE_KEY + ' tail' } },
    ]);
    const out = (await bundleOf()).details.n1!.output as string;
    expect(out).toBe(before);
    expect(out).not.toContain(FAKE_KEY.slice(0, 10));
  });
});

describe('导出数据：损坏的详情、遮蔽、大小上限、取消', () => {
  beforeEach(() => {
    store.applyChanges(threeTurns());
  });

  test('详情无法解码：这一步标为损坏，继续导出其余部分', async () => {
    const source: ExportSource = {
      ...store,
      getNodeDetail: (sid, nid): NodeDetail | null =>
        nid === 'b1' ? { nodeId: nid, input: null, output: null, text: null, raw: null, unreadable: true } : nid === 'b3' ? (() => { throw new Error('io'); })() : store.getNodeDetail(sid, nid),
      getSession: (id) => store.getSession(id),
      nodePage: (...a) => store.nodePage(...a),
      sessionEdges: (id) => store.sessionEdges(id),
    };
    const b = await bundleOf({}, {}, source);
    expect(b.unreadable.sort()).toEqual(['b1', 'b3']);
    expect(b.details.b1).toEqual({ nodeId: 'b1', input: null, output: null, text: null, raw: null, unreadable: true });
    expect(b.details.p3!.text).toBe('third prompt');
  });

  test('编号按阅读顺序：主线、派发节点下面的子代理内部', async () => {
    const s = 's2';
    const key = (i: number): string => 'sk-' + `K${i}`.padEnd(24, 'z');
    store.applyChanges([
      { type: 'session_upserted', session: makeSession(s) },
      { type: 'node_added', node: makeNode(s, 'zz-main-late', 10, { turnId: 'T1', summary: key(3) }), detail: {} },
      { type: 'node_added', node: makeNode(s, 'd', 1, { kind: 'subagent', childAgentId: 'A', turnId: 'T1', summary: key(1) }), detail: {} },
      { type: 'node_added', node: makeNode(s, 'aa-inner', 2, { agentId: 'A', turnId: 'T1', summary: key(2) }), detail: {} },
    ]);
    const r = await assembleExport(store, s, opts(), ctx());
    if (r.kind !== 'done' || r.bundle === null) throw new Error('no bundle');
    const summary = Object.fromEntries(r.bundle.nodes.map((n) => [n.id, n.summary]));
    expect(summary).toEqual({ d: '‹已遮蔽·OpenAI key#1›', 'aa-inner': '‹已遮蔽·OpenAI key#2›', 'zz-main-late': '‹已遮蔽·OpenAI key#3›' });
  });

  test('超过大小上限：尽早停下，不读其余的详情', async () => {
    let reads = 0;
    const source: ExportSource = {
      getSession: (id) => store.getSession(id),
      nodePage: (...a) => store.nodePage(...a),
      sessionEdges: (id) => store.sessionEdges(id),
      getNodeDetail: (sid, nid) => {
        reads++;
        return store.getNodeDetail(sid, nid);
      },
    };
    const r = await assembleExport(source, 's1', opts(), ctx({ maxBytes: 6000, mode: 'preview' }));
    expect(r.kind).toBe('done');
    if (r.kind !== 'done') return;
    expect(r.preview.tooLarge).toBe(true);
    expect(r.preview.estimatedBytes).toBeGreaterThan(6000);
    expect(r.preview.nodeCount).toBe(12);
    expect(r.bundle).toBeNull();
    // The first pass reads every detail (12); the second stops early.
    expect(reads - 12).toBeLessThan(12);
    // Far over the limit: the first pass itself stops.
    reads = 0;
    const far = await assembleExport(source, 's1', opts(), ctx({ maxBytes: 2100, mode: 'preview' }));
    expect(far.kind === 'done' && far.preview.tooLarge).toBe(true);
    expect(reads).toBeLessThan(12);
  });

  test('预览：报告、估计大小、节点数；不保留数据', async () => {
    const r = await assembleExport(store, 's1', opts(), ctx({ mode: 'preview', extraBytes: 1000 }));
    if (r.kind !== 'done') throw new Error('not done');
    expect(r.bundle).toBeNull();
    expect(r.preview.tooLarge).toBe(false);
    expect(r.preview.nodeCount).toBe(12);
    expect(r.preview.estimatedBytes).toBeGreaterThan(1000);
    const b = await bundleOf();
    // The estimate is not below the bundle's real size.
    expect(r.preview.estimatedBytes - 1000).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(b)));
  });

  test('客户端离开：在下一个检查点停下', async () => {
    let checks = 0;
    await expect(
      assembleExport(store, 's1', opts(), ctx({ yieldAfterMs: 0, stopped: () => ++checks > 3 })),
    ).rejects.toBeInstanceOf(ExportAbortedError);
  });
});

describe('Markdown', () => {
  test('围栏比内容里最长的反引号串多一个，至少三个', () => {
    expect(fence('abc')).toBe('```\nabc\n```');
    expect(fence('a ```` b ``')).toBe('`````\na ```` b ``\n`````');
  });

  test('结构：开头、轮次、提示引用块、思考折叠、工具步骤、子代理嵌套、截断标记', async () => {
    store.applyChanges(threeTurns());
    store.applyChanges([
      { type: 'node_updated', sessionId: 's1', id: 'b3', patch: {}, detail: { output: 'x'.repeat(EXPORT_OUTPUT_HEAD_BYTES + 3000) } },
    ]);
    const md = renderMarkdown(await bundleOf());
    expect(md.startsWith('# `Shop work`\n')).toBe(true);
    expect(md).toContain('导出内容可能仍含敏感信息，分享前请自己再看一遍。');
    expect(md).toContain('- 来源：Claude Code');
    expect(md).toContain('## 第 1 轮');
    expect(md).toContain('## 第 3 轮');
    expect(md).toContain('> ```text\n> first prompt, full text\n> ```');
    expect(md).toContain('<details><summary>思考</summary>\n\n```text\nthinking one\n```\n\n</details>');
    expect(md).toContain('### `Bash` · 成功 · 1.2 秒');
    expect(md).toContain('输入：\n\n```json\n{\n  "command": "ls"\n}\n```');
    expect(md).toContain('（已截断，原始 11 KB）');
    // Subagent internals nested under the dispatch step, nested agents deeper.
    const d2 = md.indexOf('### 子代理：`general-purpose`');
    const inner = md.indexOf('<details><summary>子代理内部的步骤（2 步）</summary>');
    const nested = md.indexOf('<details><summary>子代理内部的步骤（1 步）</summary>');
    expect(d2).toBeGreaterThan(0);
    expect(inner).toBeGreaterThan(d2);
    expect(nested).toBeGreaterThan(inner);
    expect(md.indexOf('##### `Grep`')).toBeGreaterThan(nested);
  });

  test('一轮的导出用原来的轮次编号', async () => {
    store.applyChanges(threeTurns());
    const md = renderMarkdown(await bundleOf({ scope: { kind: 'turn', turnKey: 'T2' } }));
    expect(md).toContain('## 第 2 轮');
    expect(md).not.toContain('## 第 1 轮');
    expect(md).toContain('范围：第 2 轮及其子代理');
  });

  test('被选项去掉的节点不留痕迹', async () => {
    store.applyChanges(threeTurns());
    const md = renderMarkdown(await bundleOf({ thinking: false, subagents: false, output: 'none' }));
    expect(md).not.toContain('thinking one');
    expect(md).not.toContain('思考</summary>');
    expect(md).not.toContain('子代理内部的步骤（');
    expect(md).not.toContain('out one');
    expect(md).toContain('内容：不含思考；不含子代理内部的步骤；工具输出：不含');
  });

  test('损坏的详情标为“详情已损坏”', async () => {
    store.applyChanges(threeTurns());
    const b = await bundleOf();
    b.unreadable = ['b1'];
    b.details.b1 = { nodeId: 'b1', input: null, output: null, text: null, raw: null, unreadable: true };
    expect(renderMarkdown(b)).toContain('（详情已损坏）');
  });

  test('有害内容：不能造出标题、链接、图片、HTML，不能提前结束代码块或折叠块', async () => {
    const hostile = [
      '# not a heading',
      '[link](javascript:alert(1)) ![img](http://x/y.png) <img src=x onerror=alert(1)>',
      '</details> <script>alert(1)</script> &amp; https://evil.example www.evil.example',
      '```',
      '- list',
      '1. ordered',
      '‮evil',
    ].join('\n');
    store.applyChanges([
      { type: 'session_upserted', session: makeSession('s1', { title: '# Title <b>x</b> [a](b)' }) },
      { type: 'node_added', node: makeNode('s1', 'p', 0, { kind: 'prompt', status: null, toolName: null, turnId: 'T' }), detail: { text: hostile } },
      { type: 'node_added', node: makeNode('s1', 'x', 1, { kind: 'text', status: null, toolName: null, turnId: 'T' }), detail: { text: hostile } },
      { type: 'node_added', node: makeNode('s1', 't', 2, { kind: 'thinking', status: null, toolName: null, turnId: 'T' }), detail: { text: hostile } },
      {
        type: 'node_added',
        node: makeNode('s1', 'b', 3, { toolName: '<b>Bash</b> # [x](y)', turnId: 'T' }),
        detail: { input: { command: hostile }, output: hostile },
      },
    ]);
    const md = renderMarkdown(await bundleOf());
    // Outside fenced blocks and code spans only the renderer's own text remains: no session text at all.
    const lines = md.split('\n');
    const outside: string[] = [];
    let inFence: string | null = null;
    for (const raw of lines) {
      const l = raw.replace(/^> ?/, '');
      const m = /^(`{3,})/.exec(l);
      if (inFence === null && m) {
        inFence = m[1]!;
        continue;
      }
      if (inFence !== null) {
        if (l === inFence) inFence = null;
        continue;
      }
      outside.push(raw.replace(/(`+)[^`][\s\S]*?\1(?!`)/g, 'CODE'));
    }
    expect(inFence).toBeNull();
    const rest = outside.join('\n');
    for (const piece of ['not a heading', 'link', 'img', 'script', 'evil', 'Title', 'Bash', 'list', 'ordered', 'amp']) expect(rest).not.toContain(piece);
    expect(lines[0]).toBe('# `# Title <b>x</b> [a](b)`');
    expect(md).toContain('### `<b>Bash</b> # [x](y)` · ');
    expect(md).not.toContain('‮');
    // Each <details> is closed by the renderer only.
    expect(md.match(/<details>/g)!.length).toBe(md.split('\n').filter((l) => l === '</details>').length);
  });
});
