import { expect, test } from 'vitest';
import type { ExportBundle, GraphEdge, GraphNode, NodeDetail } from '@agent-canvas/shared';
import { buildView } from '../src/canvas/view';
import { DETAIL_UNREADABLE_NOTE } from '../src/canvas/detail';
import type { LayoutClient } from '../src/canvas/layoutClient';
import {
  EXPORT_DATA_BAD, EXPORT_DATA_DAMAGED, EXPORT_DATA_MISSING, embeddedSource, exportDocumentTitle, parseExportData, viewerNodeId,
} from '../src/viewer/data';
import { baseSession, mkNode } from './helpers';

const node = (id: string, o: Partial<GraphNode> = {}): GraphNode => ({ ...mkNode(id), ...o });
const edge = (from: string, to: string): GraphEdge => ({ id: `${from}->${to}`, sessionId: 's1', from, to, kind: 'sequence' });

function bundle(o: Partial<ExportBundle> = {}): ExportBundle {
  return {
    version: 1,
    tool: { name: 'Agent Canvas', version: '0.1.0' },
    exportedAt: '2026-11-13T08:30:00.000Z',
    options: {
      format: 'html', scope: { kind: 'session' }, thinking: true, subagents: true, output: 'head',
      mask: { credential: true, assignment: true, personal: false, custom: false },
    },
    report: { total: 0, byType: {} },
    session: { ...baseSession, title: 'Demo', status: 'idle' },
    nodes: [node('p1', { kind: 'prompt', turnId: 't1' }), node('b1', { kind: 'tool', turnId: 't1', toolName: 'Bash', status: 'succeeded' })],
    edges: [edge('p1', 'b1')],
    details: {},
    truncations: {},
    unreadable: [],
    ...o,
  };
}
const text = (b: unknown): string => JSON.stringify(b);
const noLayout = (): LayoutClient => ({ layout: () => Promise.reject(new Error('no layout in tests')), dispose: () => {} });

// ---- parseExportData ----

test('parseExportData：没有数据块、空、未填的占位符都说“没有数据”', () => {
  expect(parseExportData(null)).toEqual({ ok: false, message: EXPORT_DATA_MISSING });
  expect(parseExportData('')).toEqual({ ok: false, message: EXPORT_DATA_MISSING });
  expect(parseExportData('  \n')).toEqual({ ok: false, message: EXPORT_DATA_MISSING });
  expect(parseExportData('__AGENT_CANVAS_EXPORT__')).toEqual({ ok: false, message: EXPORT_DATA_MISSING });
});

test('parseExportData：不是 JSON 时说已损坏', () => {
  expect(parseExportData('{"version":1,')).toEqual({ ok: false, message: EXPORT_DATA_DAMAGED });
  expect(parseExportData('</script><script>window.__pwned=1</script>')).toEqual({ ok: false, message: EXPORT_DATA_DAMAGED });
});

test('parseExportData：更新的版本说清楚是哪个版本', () => {
  const r = parseExportData(text({ ...bundle(), version: 2 }));
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.message).toContain('更新版本');
    expect(r.message).toContain('2');
  }
});

test('parseExportData：结构不对时说格式不正确', () => {
  for (const bad of [
    1, 'x', null, [], {},
    { ...bundle(), version: '1' },
    { ...bundle(), session: null },
    { ...bundle(), session: { ...baseSession, id: 3 } },
    { ...bundle(), nodes: {} },
    { ...bundle(), nodes: [{ id: 1 }] },
    { ...bundle(), nodes: [null] },
    { ...bundle(), edges: null },
    { ...bundle(), edges: [{ id: 'e', from: 'a' }] },
    { ...bundle(), details: [] },
    { ...bundle(), truncations: null },
    { ...bundle(), unreadable: [1] },
    { ...bundle(), report: null },
    { ...bundle(), options: null },
    { ...bundle(), exportedAt: 5 },
  ]) {
    expect(parseExportData(text(bad)), JSON.stringify(bad).slice(0, 80)).toEqual({ ok: false, message: EXPORT_DATA_BAD });
  }
});

test('parseExportData：合法的数据原样交回；数据里的任何文字都只是 JSON 字符串', () => {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const hostile = `</script><script>window.__pwned=1</script><!-- ${LS}${PS} <img src=x onerror=alert(1)>`;
  const b = bundle({ session: { ...baseSession, title: hostile } });
  // The server writes <, >, &, U+2028/9 as \u escapes (embedJson); JSON.parse gives the text back.
  const special = new Set(['<', '>', '&', LS, PS]);
  const embedded = [...text(b)].map((c) => (special.has(c) ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c)).join('');
  expect(embedded).not.toContain('<');
  const r = parseExportData(embedded);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.bundle.session.title).toBe(hostile);
});

// ---- embeddedSource ----

test('embeddedSource：会话、图、没有订阅、不是实时的', () => {
  const s = embeddedSource(bundle(), noLayout);
  expect(s.live).toBe(false);
  expect(s.getSession().title).toBe('Demo');
  expect(Object.keys(s.getGraph().nodes)).toEqual(['p1', 'b1']);
  expect(Object.keys(s.getGraph().edges)).toEqual(['p1->b1']);
  const unsubscribe = s.subscribe(() => { throw new Error('never called'); });
  unsubscribe();
  expect(s.files).toBeNull();
  expect(s.anomalies).toBeNull();
  // The same graph object every time (the canvas memoizes on it).
  expect(s.getGraph()).toBe(s.getGraph());
});

test('embeddedSource：指向不存在节点的边被丢掉', () => {
  const s = embeddedSource(bundle({ edges: [edge('p1', 'b1'), edge('p1', 'gone'), edge('gone', 'b1')] }), noLayout);
  expect(Object.keys(s.getGraph().edges)).toEqual(['p1->b1']);
});

test('embeddedSource：详情来自 bundle；没有条目时说没有保存详情', async () => {
  const d: NodeDetail = { nodeId: 'b1', input: { command: 'ls' }, output: 'out', text: null, raw: null };
  const s = embeddedSource(bundle({ details: { b1: d } }), noLayout);
  expect(await s.nodeDetail('b1')).toEqual({ detail: d, outputOriginalBytes: null });
  expect(await s.nodeDetail('p1')).toEqual({ detail: null, outputOriginalBytes: null });
  // A name inherited from Object.prototype is not an entry.
  expect(await s.nodeDetail('constructor')).toEqual({ detail: null, outputOriginalBytes: null });
  expect(await s.nodeDetail('__proto__')).toEqual({ detail: null, outputOriginalBytes: null });
});

test('embeddedSource：截断的输出带原始大小', async () => {
  const d: NodeDetail = { nodeId: 'b1', input: null, output: 'head…', text: null, raw: null };
  const s = embeddedSource(bundle({ details: { b1: d }, truncations: { b1: { originalBytes: 20_000 } } }), noLayout);
  expect(await s.nodeDetail('b1')).toEqual({ detail: d, outputOriginalBytes: 20_000 });
  // A bad side entry is ignored.
  const t = embeddedSource(bundle({ details: { b1: d }, truncations: { b1: { originalBytes: 'x' } } as never }), noLayout);
  expect((await t.nodeDetail('b1')).outputOriginalBytes).toBeNull();
});

test('embeddedSource：损坏的详情显示“详情已损坏”，即使只在 unreadable 里列出', async () => {
  const bad: NodeDetail = { nodeId: 'b1', input: null, output: null, text: null, raw: null, unreadable: true };
  const s = embeddedSource(bundle({ details: { b1: bad }, unreadable: ['b1'] }), noLayout);
  expect((await s.nodeDetail('b1')).detail?.unreadable).toBe(true);
  const only = embeddedSource(bundle({ unreadable: ['b1'] }), noLayout);
  const r = await only.nodeDetail('b1');
  expect(r.detail).toEqual({ nodeId: 'b1', input: null, output: null, text: null, raw: null, unreadable: true });
  expect(DETAIL_UNREADABLE_NOTE).toContain('已损坏');
});

test('embeddedSource：详情里的 raw 一律不显示', async () => {
  const d = { nodeId: 'b1', input: null, output: null, text: 'x', raw: { secret: 1 } } as NodeDetail;
  const s = embeddedSource(bundle({ details: { b1: d } }), noLayout);
  expect((await s.nodeDetail('b1')).detail?.raw).toBeNull();
});

test('embeddedSource：有缺口的图（子代理内部步骤和思考被去掉）也能建视图', () => {
  const nodes = [
    node('p1', { kind: 'prompt', turnId: 't1', timestamp: '2026-01-01T00:00:01Z' }),
    // A dispatch whose agent's nodes were left out of the export.
    node('d1', { kind: 'subagent', turnId: 't1', childAgentId: 'A1', status: 'succeeded', timestamp: '2026-01-01T00:00:02Z' }),
    // A reply whose parent (a thinking node) was left out.
    node('x1', { kind: 'text', turnId: 't1', parentId: 'th-gone', timestamp: '2026-01-01T00:00:03Z' }),
  ];
  const s = embeddedSource(bundle({ nodes, edges: [edge('p1', 'd1'), edge('th-gone', 'x1')] }), noLayout);
  for (const mode of ['outline', 'live', 'topology', 'causal', 'replay'] as const) {
    const v = buildView(s.getGraph(), new Map(), undefined, { mode, expandedAgents: new Set(['A1']) });
    expect(v.turns.length).toBe(1);
  }
});

test('exportDocumentTitle：遮蔽后的会话标题 · Agent Canvas 导出', () => {
  expect(exportDocumentTitle(bundle())).toBe('Demo · Agent Canvas 导出');
  expect(exportDocumentTitle(bundle({ session: { ...baseSession, id: 'abcdef1234', title: null } }))).toBe('abcdef12 · Agent Canvas 导出');
});

// ---- viewerNodeId ----

test('viewerNodeId：#n/<id> 和会话地址里的节点部分', () => {
  expect(viewerNodeId('')).toBeNull();
  expect(viewerNodeId('#')).toBeNull();
  expect(viewerNodeId('#n/tool%3Atu1')).toBe('tool:tu1');
  expect(viewerNodeId('#/n/tool%3Atu1')).toBe('tool:tu1');
  expect(viewerNodeId('#/s/s1/n/tool%3Atu1')).toBe('tool:tu1');
  expect(viewerNodeId('#/s/s1')).toBeNull();
  expect(viewerNodeId('#/stats')).toBeNull();
  expect(viewerNodeId('#n/%E0%A4%A')).toBeNull(); // undecodable
  expect(viewerNodeId('#n/')).toBeNull();
});
