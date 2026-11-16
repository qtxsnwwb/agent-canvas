import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { defaultExportOptions, type ExportBundle, type ExportOptions, type GraphEdge, type GraphNode, type NodeDetail, type Session } from '@agent-canvas/shared';
import {
  assembleExport,
  DETAIL_FIELD_POLICY,
  EDGE_FIELD_POLICY,
  NODE_FIELD_POLICY,
  SESSION_FIELD_POLICY,
  type AssembleContext,
} from '../src/export/assemble.js';
import { summarize } from '../src/normalize/summary.js';
import { openStore, type Store } from '../src/store/store.js';
import { FAKE_KEY, makeNode, makeSession } from './export-fixtures.js';

const ALL_ON: ExportOptions['mask'] = { credential: true, assignment: true, personal: true, custom: true };
const opts = (o: Partial<ExportOptions> = {}): ExportOptions => ({ ...defaultExportOptions(false), output: 'full', ...o });
const ctx = (o: Partial<AssembleContext> = {}): AssembleContext => ({
  customTerms: [],
  homeUsers: [],
  version: '1',
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

async function bundle(sessionId: string, o: Partial<ExportOptions> = {}, c: Partial<AssembleContext> = {}): Promise<ExportBundle> {
  const r = await assembleExport(store, sessionId, opts(o), ctx(c));
  if (r.kind !== 'done' || r.bundle === null) throw new Error('no bundle');
  return r.bundle;
}
const exported = (policy: Record<string, string>): string[] => Object.keys(policy).filter((k) => policy[k] !== 'drop').sort();

describe('字段白名单（C1）', () => {
  /** Every field of every exported type set, so a field the export does not decide on shows up here. */
  const fullNode: Required<GraphNode> = {
    ...makeNode('s1', 'n1', 0),
    turnId: 'T1',
    agentId: null,
    childAgentId: null,
    parentId: 'p0',
    toolUseId: 'toolu_1',
    messageId: 'msg_1',
    usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 3 },
    systemSubtype: 'compact',
    files: [{ path: 'D:/w/a.ts', action: 'edit' }],
    filesTruncated: true,
    inputKey: '0123456789abcdef',
    endedAt: '2026-11-01T10:00:01.000Z',
  };
  const fullSession: Required<Session> = makeSession('s1');

  test('导出的节点、会话、边、详情只有白名单里的字段；inputKey 不导出', async () => {
    store.applyChanges([
      { type: 'session_upserted', session: fullSession },
      { type: 'node_added', node: makeNode('s1', 'p0', 0, { turnId: 'T1' }), detail: {} },
      { type: 'node_added', node: fullNode, detail: { input: { a: 1 }, output: 'o', text: 't', raw: { x: 1 } } },
      { type: 'edge_added', edge: { id: 'p0->n1', sessionId: 's1', from: 'p0', to: 'n1', kind: 'sequence' } },
    ]);
    // Every key of the stored node is decided on (the policy maps are exhaustive at compile time too).
    for (const k of Object.keys(store.getGraph('s1')!.nodes.find((n) => n.id === 'n1')!)) expect(NODE_FIELD_POLICY).toHaveProperty(k);
    for (const k of Object.keys(store.getSession('s1')!)) expect(SESSION_FIELD_POLICY).toHaveProperty(k);
    const b = await bundle('s1');
    const n1 = b.nodes.find((n) => n.id === 'n1')!;
    expect(Object.keys(n1).sort()).toEqual(exported(NODE_FIELD_POLICY));
    expect(n1.inputKey).toBeUndefined();
    expect(JSON.stringify(b)).not.toContain('0123456789abcdef');
    expect(Object.keys(b.session).sort()).toEqual(exported(SESSION_FIELD_POLICY));
    expect(Object.keys(b.edges[0]!).sort()).toEqual(exported(EDGE_FIELD_POLICY));
    expect(Object.keys(b.details.n1!).sort()).toEqual(Object.keys(DETAIL_FIELD_POLICY).filter((k) => k !== 'unreadable').sort());
    expect(b.details.n1!.raw).toBeNull();
  });

  test('含有可疑内容的 id 换成一致的别名；边、详情、轮次都跟着换', async () => {
    const badId = `tool:${FAKE_KEY}`;
    const badTurn = `turn-${FAKE_KEY}`;
    store.applyChanges([
      { type: 'session_upserted', session: makeSession('s1') },
      { type: 'node_added', node: makeNode('s1', 'p', 0, { kind: 'prompt', status: null, toolName: null, turnId: badTurn }), detail: { text: 'hi' } },
      { type: 'node_added', node: makeNode('s1', badId, 1, { turnId: badTurn, toolUseId: FAKE_KEY, parentId: 'p' }), detail: { output: 'x' } },
      { type: 'edge_added', edge: { id: `p->${badId}`, sessionId: 's1', from: 'p', to: badId, kind: 'sequence' } },
    ]);
    const b = await bundle('s1', { scope: { kind: 'turn', turnKey: badTurn } });
    const json = JSON.stringify(b);
    expect(json).not.toContain(FAKE_KEY);
    const n = b.nodes.find((x) => x.id !== 'p')!;
    expect(n.id).toMatch(/^masked-id-\d+$/);
    expect(b.edges[0]!.to).toBe(n.id);
    expect(b.details[n.id]!.nodeId).toBe(n.id);
    expect(n.turnId).toBe(b.nodes.find((x) => x.id === 'p')!.turnId);
    expect(b.options.scope).toEqual({ kind: 'turn', turnKey: n.turnId });
  });

  test('不合格式的枚举、时间、用量换成安全的值', async () => {
    const odd = makeNode('s1', 'n', 0, {
      kind: 'evil' as never,
      status: 'evil' as never,
      timestamp: `2026 ${FAKE_KEY}`,
      usage: { inputTokens: 'x' as never, outputTokens: 1 },
    });
    store.applyChanges([
      { type: 'session_upserted', session: makeSession('s1', { origin: 'evil' as never, startedAt: 'evil text' }) },
      { type: 'node_added', node: odd, detail: {} },
    ]);
    const b = await bundle('s1');
    expect(b.nodes[0]).toMatchObject({ kind: 'unknown', status: null, timestamp: '', usage: null });
    expect(b.session).toMatchObject({ origin: 'claude', startedAt: '' });
  });
});

describe('同一个值处处遮蔽（I3）', () => {
  test('一处按赋值认出的密码，在别的步骤里原样出现也遮，编号相同；预览的报告与导出一致', async () => {
    const pw = 'Hunter2' + 'Hunter2xyz';
    store.applyChanges([
      { type: 'session_upserted', session: makeSession('s1') },
      { type: 'node_added', node: makeNode('s1', 'a', 0, { turnId: 'T' }), detail: { output: `login ${pw} ok` } },
      { type: 'node_added', node: makeNode('s1', 'b', 1, { turnId: 'T' }), detail: { input: { command: `export DB_PASSWORD=${pw}` } } },
      { type: 'node_added', node: makeNode('s1', 'c', 2, { turnId: 'T', summary: `psql -W ${pw}` }), detail: {} },
    ]);
    const b = await bundle('s1');
    const json = JSON.stringify(b);
    expect(json).not.toContain(pw);
    expect(b.details.a!.output).toBe('login ‹已遮蔽·密钥/密码#1› ok');
    expect((b.details.b!.input as { command: string }).command).toBe('export DB_PASSWORD=‹已遮蔽·密钥/密码#1›');
    const preview = await assembleExport(store, 's1', opts(), ctx({ mode: 'preview' }));
    if (preview.kind !== 'done') throw new Error('x');
    expect(preview.preview.report).toEqual(b.report);
  });
});

describe('摘要（I4）', () => {
  test('从输入得出的摘要按遮蔽后的输入重新得出；其他摘要按截断文字遮蔽', async () => {
    const input = { command: `${'y'.repeat(180)} ${FAKE_KEY}` };
    const derived = summarize(input);
    expect(derived).toContain('sk-pro…'); // the stored summary shows a cut key prefix
    const other = `${'z'.repeat(190)} ${FAKE_KEY.slice(0, 7)}…`;
    store.applyChanges([
      { type: 'session_upserted', session: makeSession('s1', { title: `fix ${FAKE_KEY.slice(0, 6)}…` }) },
      { type: 'node_added', node: makeNode('s1', 'a', 0, { turnId: 'T', summary: derived }), detail: { input } },
      { type: 'node_added', node: makeNode('s1', 'b', 1, { turnId: 'T', summary: other }), detail: {} },
    ]);
    const b = await bundle('s1');
    const a = b.nodes.find((n) => n.id === 'a')!;
    expect(a.summary).toBe(summarize(b.details.a!.input));
    expect(a.summary).not.toContain('sk-pro');
    expect(b.nodes.find((n) => n.id === 'b')!.summary).toBe(`${'z'.repeat(190)} ‹已遮蔽·OpenAI key#3›…`);
    expect(b.session.title).toBe('fix ‹已遮蔽·OpenAI key#1›…');
  });
});

describe('结构化数据里键名命中的非字符串值（I1）', () => {
  test('数字、数组、对象都遮', async () => {
    store.applyChanges([
      { type: 'session_upserted', session: makeSession('s1') },
      {
        type: 'node_added',
        node: makeNode('s1', 'a', 0, { turnId: 'T' }),
        detail: { input: { password: 98765432, api_key: ['Abc123456789'], token: { value: 'Abc123456789' } } },
      },
    ]);
    const json = JSON.stringify(await bundle('s1', { mask: { ...ALL_ON } }));
    expect(json).not.toContain('98765432');
    expect(json).not.toContain('Abc123456789');
  });
});

// The edge type is used only to make sure the whitelist test covers it.
void (null as unknown as GraphEdge | NodeDetail);
