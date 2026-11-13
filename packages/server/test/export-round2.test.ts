import { afterEach, beforeEach, expect, test } from 'vitest';
import { defaultExportOptions, type ExportBundle, type ExportOptions } from '@agent-canvas/shared';
import { assembleExport, cutOptions, type AssembleContext } from '../src/export/assemble.js';
import { maskWarnings, renderMarkdown } from '../src/export/markdown.js';
import { openStore, type Store } from '../src/store/store.js';
import { FAKE_KEY, makeNode, makeSession } from './export-fixtures.js';

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

async function bundle(o: Partial<ExportOptions> = {}, c: Partial<AssembleContext> = {}): Promise<ExportBundle> {
  const r = await assembleExport(store, 's1', opts(o), ctx(c));
  if (r.kind !== 'done' || r.bundle === null) throw new Error('no bundle');
  return r.bundle;
}

test('只有被截断的文字才按截断处理：普通标题里的 risk-score、task-list 不动', async () => {
  store.applyChanges([
    { type: 'session_upserted', session: makeSession('s1', { title: 'run npm task-list' }) },
    { type: 'node_added', node: makeNode('s1', 'a', 0, { turnId: 'T', title: 'Fix risk-score', toolName: 'task-manager', summary: 'VISIT ASIAN' }), detail: {} },
    { type: 'node_added', node: makeNode('s1', 'b', 1, { turnId: 'T', summary: 'npm run task-manag…' }), detail: {} },
  ]);
  const b = await bundle();
  expect(b.session.title).toBe('run npm task-list');
  const a = b.nodes.find((n) => n.id === 'a')!;
  expect([a.title, a.toolName, a.summary]).toEqual(['Fix risk-score', 'task-manager', 'VISIT ASIAN']);
  expect(b.nodes.find((n) => n.id === 'b')!.summary).toBe('npm run task-manag…');
  expect(b.report.total).toBe(0);
  expect(cutOptions('x'.repeat(200))).toEqual({ truncated: true });
  expect(cutOptions('short…')).toEqual({ truncated: true });
  expect(cutOptions('short')).toBeUndefined();
});

test('被截断的标题和摘要：末尾的密钥前缀、自定义词开头都遮', async () => {
  store.applyChanges([
    { type: 'session_upserted', session: makeSession('s1', { title: 'deploy for BluefinC…' }) },
    { type: 'node_added', node: makeNode('s1', 'a', 0, { turnId: 'T', summary: `curl -H "x: ${FAKE_KEY.slice(0, 12)}…` }), detail: {} },
  ]);
  const b = await bundle({ mask: { credential: true, assignment: true, personal: false, custom: true } }, { customTerms: ['BluefinCorp'] });
  expect(b.session.title).toBe('deploy for ‹已遮蔽·自定义词#1›…');
  expect(b.nodes[0]!.summary).toBe('curl -H "x: ‹已遮蔽·OpenAI key#1›…');
});

test('id 的别名不与真实 id 相撞；检查 id 不计入报告、不占编号', async () => {
  const bad = `tool:${FAKE_KEY}`;
  store.applyChanges([
    { type: 'session_upserted', session: makeSession('s1') },
    { type: 'node_added', node: makeNode('s1', 'masked-id-1', 0, { turnId: 'T' }), detail: {} },
    { type: 'node_added', node: makeNode('s1', bad, 1, { turnId: 'T', summary: `use ${FAKE_KEY}` }), detail: {} },
  ]);
  const b = await bundle();
  const ids = b.nodes.map((n) => n.id).sort();
  expect(new Set(ids).size).toBe(2);
  expect(ids).toContain('masked-id-1');
  expect(ids).not.toContain(bad);
  // Only the summary is a masked place; the id check counts nothing and the summary's key is #1.
  expect(b.report.byType['openai-key']).toEqual({ occurrences: 1, distinct: 1 });
  expect(b.nodes.find((n) => n.id !== 'masked-id-1')!.summary).toBe('use ‹已遮蔽·OpenAI key#1›');
});

test('学到的值超出上限或查找被中止时，Markdown 开头有提示', async () => {
  store.applyChanges([
    { type: 'session_upserted', session: makeSession('s1') },
    { type: 'node_added', node: makeNode('s1', 'a', 0, { turnId: 'T' }), detail: {} },
  ]);
  const b = await bundle();
  expect(maskWarnings(b.report)).toEqual([]);
  b.report = { ...b.report, learnedCapped: true, learnedSkipped: 2 };
  const md = renderMarkdown(b);
  expect(md).toContain('- 注意：需要逐处查找的密钥值太多');
  expect(md).toContain('- 注意：有 2 段文字');
});
