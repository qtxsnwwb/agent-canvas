import { expect, test } from 'vitest';
import type { ContentHit, Graph, GraphNode, NodeDetail, SessionAnomaliesResponse, SessionFilesResponse } from '@agent-canvas/shared';
import {
  IDENTITY_MASKER, MASK_SWITCH_KEY, PAGE_MASK_CATEGORIES, createDisplaySource, createPageMasker, maskDiagnostics,
  maskProject, maskProjectFiles, resolveMaskedId, projectOptionValue, projectFromOptionValue, maskSessionFields, maskStats, maskAnomalyList, parseMaskSwitch, sameMaskedValue,
  serializeMaskSwitch, stripPlaceholderNumbers,
} from '../src/masking';
import type { SessionSource } from '../src/sessionSource';
import { SEARCH_UNMASKED_TEXT, contentView, createSearcher, groupContentHits, sessionResultState } from '../src/search';
import { failureOf } from '../src/client';
import { baseSession, mkNode } from './helpers';

// Obviously fake values, built at run time (the repository is public).
const KEY = 'sk-' + 'proj-' + 'FAKEFAKE0123456789abcdefTEST';
const KEY2 = 'sk-' + 'ant-' + 'FAKEFAKE9876543210zyxwTEST';
const PASSWORD = 'Hunter' + '2024' + 'xyzFAKE';
const TERM = 'Falcon' + 'Project';

const masker = (numbered = true, customTerms: string[] = [TERM]) => createPageMasker({ customTerms, numbered });

test('开关：存在 agent-canvas:mask 里，默认关，只有 "1" 是开', () => {
  expect(MASK_SWITCH_KEY).toBe('agent-canvas:mask');
  expect(parseMaskSwitch(null)).toBe(false);
  expect(parseMaskSwitch('1')).toBe(true);
  expect(parseMaskSwitch('true')).toBe(false);
  expect(parseMaskSwitch('0')).toBe(false);
  expect(serializeMaskSwitch(true)).toBe('1');
  expect(serializeMaskSwitch(false)).toBe('0');
  expect(PAGE_MASK_CATEGORIES).toEqual(['credential', 'assignment', 'custom']);
});

test('关着时是恒等：同一个字符串、同一个对象', () => {
  const v = { a: KEY };
  expect(IDENTITY_MASKER.on).toBe(false);
  expect(IDENTITY_MASKER.text(KEY)).toBe(KEY);
  expect(IDENTITY_MASKER.title(KEY)).toBe(KEY);
  expect(IDENTITY_MASKER.summary(KEY)).toBe(KEY);
  expect(IDENTITY_MASKER.value(v)).toBe(v);
});

test('页面上遮凭据、赋值、自定义词，不遮个人信息', () => {
  const m = masker();
  const out = m.text(`key ${KEY} password=${PASSWORD} in ${TERM} by someone@example.com`);
  expect(out).not.toContain(KEY);
  expect(out).not.toContain(PASSWORD);
  expect(out).not.toContain(TERM);
  expect(out).toContain('someone@example.com');
  expect(out).toContain('‹已遮蔽·OpenAI key#1›');
});

test('编号：会话页的遮蔽器同一个值同一个号；跨会话列表不编号', () => {
  const n = masker(true);
  expect(n.text(KEY)).toBe('‹已遮蔽·OpenAI key#1›');
  expect(n.text(KEY2)).toBe('‹已遮蔽·Anthropic key#1›');
  expect(n.text(`again ${KEY}`)).toBe('again ‹已遮蔽·OpenAI key#1›');
  expect(masker(false).text(KEY)).toBe('‹已遮蔽·OpenAI key›');
});

test('截断的文字（摘要、标题）：结尾被截断的密钥前缀也遮', () => {
  const m = masker();
  const cut = `curl -H "x: ${KEY.slice(0, 12)}…`;
  const out = m.summary(cut);
  expect(out).not.toContain(KEY.slice(0, 12));
});

test('结构化的值逐个字符串遮蔽，不先转成文字；同一个对象只遮一次', () => {
  const m = masker();
  const input = { command: `export TOKEN=${KEY}`, nested: [{ password: PASSWORD }], inputTokens: 1234 };
  const a = m.value(input) as typeof input;
  expect(JSON.stringify(a)).not.toContain(KEY);
  expect(JSON.stringify(a)).not.toContain(PASSWORD);
  expect(m.value(input)).toBe(a);
  expect(m.value('plain')).toBe('plain');
  expect(m.value(null)).toBe(null);
});

test('同一段文字只遮一次（按文字和遮蔽器缓存）', () => {
  let calls = 0;
  const m = createPageMasker({
    customTerms: [], numbered: true,
    create: () => ({ mask: (t: string) => { calls++; return t.toUpperCase(); }, maskValue: (v: unknown) => v, report: () => ({ total: 0, byType: {} }) }),
  });
  expect(m.text('abc')).toBe('ABC');
  expect(m.text('abc')).toBe('ABC');
  expect(calls).toBe(1);
  expect(createPageMasker({ customTerms: [], numbered: true, create: () => ({ mask: (t: string) => { calls++; return t; }, maskValue: (v: unknown) => v, report: () => ({ total: 0, byType: {} }) }) }).text('abc')).toBe('abc');
  expect(calls).toBe(2);
});

test('遮蔽器建不出来时宁可全遮', () => {
  const m = createPageMasker({ customTerms: [], numbered: true, create: () => { throw new Error('boom'); } });
  expect(m.text('hello')).toBe('‹已遮蔽·处理失败›');
  expect(m.value({ a: 'x' })).toBe('‹已遮蔽·处理失败›');
  expect(m.text('')).toBe('');
});

test('截断的文字结尾是半个自定义词时也遮（共享遮蔽器的截断模式；会话页编号，列表不编号）', () => {
  expect(masker().summary(`项目是 ${TERM.slice(0, 8)}…`)).toBe('项目是 ‹已遮蔽·自定义词#1›…');
  expect(masker(false).title(`项目是 ${TERM.slice(0, 8)}…`)).toBe('项目是 ‹已遮蔽·自定义词›…');
  expect(masker().summary(`项目是 ${TERM.slice(0, 2)}…`)).toBe(`项目是 ${TERM.slice(0, 2)}…`);
});

test('截断模式只用于真的被截断的文字：标题按 isCutTitle（60 个码位或省略号），摘要按 isCutSummary', () => {
  const m = masker();
  // The reviewer's over-masking examples stay as they are with the switch on.
  expect(m.title('Fix risk-score')).toBe('Fix risk-score');
  expect(m.summary('task-manager …')).toBe('task-manager …');
  expect(m.text('Fix risk-score')).toBe('Fix risk-score');
  // C1: a session title made of the first 60 code points of a prompt, cut inside a GitHub-style token.
  const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const prompt = `Here is the GitHub token for CI ok: ${token} please use it`;
  const title = Array.from(prompt).slice(0, 60).join('');
  expect(Array.from(title)).toHaveLength(60);
  const shown = m.title(title);
  expect(shown).not.toContain(token.slice(0, 12));
  expect(shown).toContain('‹已遮蔽·');
  // The same title on a session, a list and a summary of 200 characters.
  expect(maskSessionFields({ ...baseSession, title }, masker(false)).title).not.toContain(token.slice(4, 14));
  const summary = `run ${'x'.repeat(170)} ${token}`.slice(0, 200);
  expect(m.summary(summary)).not.toContain(token.slice(4, 14));
  // A short title is whole text: a cut token in it is not relaxed (not a cut).
  expect(m.title('ghp_short1')).toBe('ghp_short1');
});

test('两遍：一处认出来的值，在别处原样出现时也遮', () => {
  const m = masker();
  m.learn(`password=${PASSWORD}`);
  expect(m.text(`login ${PASSWORD}`)).not.toContain(PASSWORD);
  // A text masked before the value was learned is masked again afterwards (the cache is forgotten).
  const m2 = masker();
  expect(m2.text(`echo ${PASSWORD}`)).toContain(PASSWORD);
  const before = m2.learnedCount();
  m2.learnValue({ password: PASSWORD });
  expect(m2.learnedCount()).toBeGreaterThan(before);
  expect(m2.text(`echo ${PASSWORD}`)).not.toContain(PASSWORD);
});

test('项目选择框的 value：开关打开时是不透露 id 的序号，能换回 id', () => {
  const ids = ['C--work-plain', `C--work-${TERM}`];
  const m = masker(false);
  expect(projectOptionValue(ids[1]!, ids, m)).toBe('p1');
  expect(projectFromOptionValue('p1', ids, m)).toBe(ids[1]);
  expect(projectFromOptionValue('', ids, m)).toBe(null);
  expect(projectFromOptionValue('p9', ids, m)).toBe(null);
  expect(projectOptionValue(null, ids, m)).toBe('');
  expect(projectOptionValue(ids[1]!, ids, IDENTITY_MASKER)).toBe(ids[1]);
  expect(projectFromOptionValue(ids[1]!, ids, IDENTITY_MASKER)).toBe(ids[1]);
});

// ---- placeholders in addresses ----

test('占位符去掉编号后比较：会话页的 #1 与列表的不编号形式相同', () => {
  expect(stripPlaceholderNumbers('a/‹已遮蔽·OpenAI key#12›/b')).toBe('a/‹已遮蔽·OpenAI key›/b');
  expect(sameMaskedValue('a/‹已遮蔽·OpenAI key#1›', 'a/‹已遮蔽·OpenAI key›')).toBe(true);
  expect(sameMaskedValue('a/‹已遮蔽·OpenAI key#1›', 'a/‹已遮蔽·GitHub token›')).toBe(false);
  expect(sameMaskedValue('#1', '#2')).toBe(false);
});

test('地址里的项目 id：开关打开时链接带遮蔽后的 id，收到时找回原来的 id', () => {
  const m = masker(false);
  const ids = ['C--work-plain', `C--work-${TERM}`];
  const link = m.text(ids[1]!);
  expect(link).not.toContain(TERM);
  expect(resolveMaskedId(link, ids, m)).toBe(ids[1]);
  expect(resolveMaskedId('C--work-plain', ids, m)).toBe('C--work-plain');
  expect(resolveMaskedId(null, ids, m)).toBe(null);
  expect(resolveMaskedId('unknown', ids, m)).toBe('unknown');
  // A session page's numbered placeholder resolves too.
  expect(resolveMaskedId(masker(true).text(ids[1]!), ids, m)).toBe(ids[1]);
});

// ---- the masked session source ----

function fakeSource(graph: Graph, detail: NodeDetail): SessionSource & { setGraph(g: Graph): void } {
  let g = graph;
  const files: SessionFilesResponse = {
    sessionId: 's1', origin: 'claude', cwd: `C:/work/${TERM}`,
    files: [{
      path: `C:/work/${TERM}/${KEY}.txt`, relativePath: `${KEY}.txt`, counts: { read: 1, edit: 0, write: 0, delete: 0 }, reads: 1, changes: 0,
      changed: false, created: false, deleted: false, failed: 0, firstAt: null, lastAt: null, touchesTruncated: false,
      touches: [{ nodeId: 'n1', action: 'read', toolName: `mcp__${TERM}__read`, at: '2026-01-01T00:00:00Z', status: 'succeeded', agentId: null }],
    }],
    totalFiles: 1, truncated: false, totals: { files: 1, changedFiles: 0, reads: 1, changes: 0 }, truncatedNodes: 0,
  };
  const anomalies: SessionAnomaliesResponse = {
    computing: false,
    anomalies: [{ id: 'a1', kind: 'churn', sessionId: 's1', agentId: null, turnKey: 't', basis: 'edits', count: 5, path: `C:/work/${KEY}.ts`, toolName: `x${TERM}`, firstNodeId: 'n1', lastNodeId: 'n1', at: '2026-01-01T00:00:00Z' }],
  };
  return {
    getSession: () => ({ ...baseSession, title: `fix ${KEY}`, cwd: `C:/work/${TERM}`, gitBranch: `feat/${TERM}`, projectId: `C--work-${TERM}` }),
    getGraph: () => g,
    setGraph(next) { g = next; },
    subscribe: () => () => {},
    live: true,
    nodeDetail: async () => ({ detail, outputOriginalBytes: null }),
    files: async () => files,
    anomalies: async () => anomalies,
    createLayoutClient: () => { throw new Error('not used'); },
  };
}

const node = (id: string, o: Partial<GraphNode> = {}): GraphNode => ({ ...mkNode(id), ...o });

test('会话页的数据源：关着时节点、会话、详情原样（同一个对象）', async () => {
  const a = node('a', { summary: KEY });
  const detail: NodeDetail = { nodeId: 'a', input: { command: KEY }, output: null, text: null, raw: null };
  const src = fakeSource({ nodes: { a }, edges: {} }, detail);
  const ds = createDisplaySource(src, IDENTITY_MASKER);
  expect(ds.getGraph().nodes.a).toBe(a);
  expect((await ds.nodeDetail('a')).detail).toBe(detail);
});

test('会话页的数据源：换遮蔽器时就地重新遮蔽并通知，函数不变（画布不重建）', async () => {
  const a = node('a', { summary: `echo ${KEY}` });
  const src = fakeSource({ nodes: { a }, edges: {} }, { nodeId: 'a', input: { command: KEY }, output: null, text: null, raw: null });
  const ds = createDisplaySource(src, IDENTITY_MASKER);
  const { nodeDetail, files, anomalies } = ds;
  let told = 0;
  ds.subscribe(() => { told++; });
  expect(ds.getGraph().nodes.a!.summary).toContain(KEY);
  ds.setMasker(masker());
  expect(told).toBe(1);
  expect(ds.getGraph().nodes.a!.summary).not.toContain(KEY);
  expect(JSON.stringify((await ds.nodeDetail('a')).detail)).not.toContain(KEY);
  expect([ds.nodeDetail, ds.files, ds.anomalies]).toEqual([nodeDetail, files, anomalies]);
  ds.setMasker(IDENTITY_MASKER);
  expect(ds.getGraph().nodes.a!.summary).toContain(KEY);
});

test('会话页的数据源：采用服务端认出的值后重新遮蔽一次（还没打开的步骤里的密码）', () => {
  const thinking = node('t', { kind: 'thinking', summary: `and the password ${PASSWORD} carefully` });
  const src = fakeSource({ nodes: { t: thinking }, edges: {} }, { nodeId: 't', input: null, output: null, text: null, raw: null });
  const m = masker();
  const ds = createDisplaySource(src, m);
  let told = 0;
  ds.subscribe(() => { told++; });
  expect(ds.getGraph().nodes.t!.summary).toContain(PASSWORD);
  m.adopt([{ type: 'assignment', value: PASSWORD }]);
  ds.refresh();
  expect(told).toBe(1);
  expect(ds.getGraph().nodes.t!.summary).not.toContain(PASSWORD);
});

test('会话页的数据源：双向控制字符显示成可见的标记（开关关着也一样）', async () => {
  const rlo = String.fromCharCode(0x202e);
  const a = node('a', { title: `x${rlo}gnp.exe`, summary: `a${rlo}b`, files: [{ path: `C:/${rlo}evil.txt`, action: 'read' }] });
  const src = fakeSource({ nodes: { a }, edges: {} }, { nodeId: 'a', input: { [`k${rlo}`]: `v${rlo}` }, output: `o${rlo}`, text: null, raw: null });
  const ds = createDisplaySource(src, IDENTITY_MASKER);
  const all = JSON.stringify([ds.getGraph(), (await ds.nodeDetail('a')).detail]);
  expect(all).not.toContain(rlo);
  expect(ds.getGraph().nodes.a!.title).toBe('x⟦U+202E⟧gnp.exe');
});

test('会话页的数据源：会话、节点、详情（含原始记录）、文件、异常全部遮蔽', async () => {
  const n1 = node('n1', { kind: 'tool', title: 'Bash', toolName: 'Bash', summary: `{"command":"echo ${KEY}"}`, files: [{ path: `C:/w/${KEY}.txt`, action: 'read' }] });
  const detail: NodeDetail = { nodeId: 'n1', input: { command: `echo ${KEY} ${PASSWORD}` }, output: `out password=${PASSWORD}`, text: `in ${TERM}`, raw: { message: { content: KEY } } };
  const src = fakeSource({ nodes: { n1 }, edges: {} }, detail);
  const m = masker();
  const ms = createDisplaySource(src, m);
  const all = JSON.stringify([
    ms.getSession(), ms.getGraph(), await ms.nodeDetail('n1'), await ms.files!(), await ms.anomalies!(),
  ]);
  expect(all).not.toContain(KEY);
  expect(all).not.toContain(TERM);
  expect(all).not.toContain(PASSWORD.slice(0, 10));
  // Same value, same number across the graph and the detail.
  expect(JSON.stringify(ms.getGraph())).toContain('‹已遮蔽·OpenAI key#1›');
  expect(JSON.stringify(await ms.nodeDetail('n1'))).toContain('‹已遮蔽·OpenAI key#1›');
  // Ids are kept (they address nodes).
  expect(ms.getGraph().nodes.n1!.id).toBe('n1');
});

test('会话页的数据源：图不变时返回同一个对象，没变的节点保持同一个对象', () => {
  const a = node('a', { summary: KEY });
  const b = node('b', { summary: 'plain' });
  const src = fakeSource({ nodes: { a, b }, edges: {} }, { nodeId: 'a', input: null, output: null, text: null, raw: null });
  const ms = createDisplaySource(src, masker());
  const g1 = ms.getGraph();
  expect(ms.getGraph()).toBe(g1);
  const b2 = { ...b, summary: 'changed' };
  src.setGraph({ nodes: { a, b: b2 }, edges: {} });
  const g2 = ms.getGraph();
  expect(g2).not.toBe(g1);
  expect(g2.nodes.a).toBe(g1.nodes.a);
  expect(g2.nodes.b!.summary).toBe('changed');
});

test('会话页的数据源：节点 id 是 __proto__ 时仍是普通的一项', () => {
  const p = node('__proto__', { summary: KEY });
  const src = fakeSource({ nodes: Object.fromEntries([['__proto__', p]]), edges: {} }, { nodeId: 'x', input: null, output: null, text: null, raw: null });
  const g = createDisplaySource(src, masker()).getGraph();
  expect(Object.keys(g.nodes)).toEqual(['__proto__']);
  expect(JSON.stringify(g.nodes)).not.toContain(KEY);
});

test('会话页的数据源：文件和异常的加载函数是固定的（面板按函数变化重新加载）', () => {
  const src = fakeSource({ nodes: {}, edges: {} }, { nodeId: 'x', input: null, output: null, text: null, raw: null });
  const ms = createDisplaySource(src, masker());
  expect(ms.files).toBe(ms.files);
  expect(typeof ms.files).toBe('function');
});

test('会话页的数据源：打开的详情认出新值时，已显示的卡片重新遮蔽一次并通知', async () => {
  const card = node('a', { summary: `psql -W ${PASSWORD}` });
  const tool = node('b', { kind: 'tool', summary: 'connect' });
  const src = fakeSource({ nodes: { a: card, b: tool }, edges: {} }, { nodeId: 'b', input: { password: PASSWORD }, output: null, text: null, raw: null });
  const ms = createDisplaySource(src, masker());
  let told = 0;
  ms.subscribe(() => { told++; });
  expect(ms.getGraph().nodes.a!.summary).toContain(PASSWORD);
  await ms.nodeDetail('b');
  expect(told).toBe(1);
  expect(ms.getGraph().nodes.a!.summary).not.toContain(PASSWORD);
  // Nothing new learned: no second notification.
  await ms.nodeDetail('b');
  expect(told).toBe(1);
});

// ---- cross-session lists ----

test('跨会话的列表：会话字段、项目目录、文件、统计、异常、诊断都遮蔽，id 不动', () => {
  const m = masker(false);
  const s = maskSessionFields({ ...baseSession, title: KEY, cwd: `C:/${TERM}`, gitBranch: TERM, projectId: `C--${TERM}` }, m);
  expect(JSON.stringify(s)).not.toContain(KEY);
  expect(s.projectId).toBe(`C--${TERM}`); // an id (filters, live updates); links mask it separately
  expect(s.cwd).toBe('C:/‹已遮蔽·自定义词›');
  const p = maskProject({ id: `C--${TERM}`, cwd: null, sessionCount: 1, activeSessionCount: 0, origins: ['claude'] }, m);
  expect(p.id).toBe(`C--${TERM}`);
  expect(p.displayPath).not.toContain(TERM);
  expect(p.title).not.toContain(TERM);
  const files = maskProjectFiles({
    projectId: 'p', projectName: TERM, projectDir: `C:/${TERM}`, totalFiles: 1, truncated: false, failedSessions: 0, importing: false, truncatedNodes: 0,
    files: [{ path: `C:/${TERM}/${KEY}`, relativePath: KEY, sessionCount: 1, reads: 1, changes: 0, created: false, deleted: false, lastAt: null, lastOrigin: null, sessionsTruncated: false,
      sessions: [{ sessionId: 's', origin: 'claude', title: `t ${KEY}`, reads: 1, changes: 0, lastAt: null }] }],
  }, m);
  const shown = JSON.stringify({ ...files, files: files.files.map(({ rawPath: _, ...f }) => f) });
  expect(shown).not.toContain(KEY);
  expect(shown).not.toContain(TERM);
  expect(files.files[0]!.rawPath).toBe(`C:/${TERM}/${KEY}`);
  const anomalies = maskAnomalyList({
    items: [{ id: 'a', kind: 'churn', sessionId: 's', agentId: null, turnKey: 't', basis: 'edits', path: `C:/${KEY}`, toolName: TERM, firstNodeId: 'n', lastNodeId: 'n', at: 'x', projectId: 'p', origin: 'claude', sessionTitle: KEY }],
    totals: { loop: 0, failures: 0, churn: 1, cost: 0 }, truncated: false, computing: false, failedSessions: 0,
  }, m);
  expect(JSON.stringify(anomalies)).not.toContain(KEY);
  expect(JSON.stringify(anomalies)).not.toContain(TERM);
});

test('统计页：工具名、项目名、最慢的调用都遮蔽', () => {
  const m = masker(false);
  const measures = { turns: 0, activeMs: 0, tokens: null };
  const stats = maskStats({
    byProject: [{ ...measures, projectId: 'p', name: TERM, projectCount: 1 }],
    byTool: [{ origin: 'claude', toolName: `mcp__${TERM}__x`, calls: 1, finished: 1, failed: 0, failureRate: 0, timedCalls: 1, totalMs: 1, medianMs: 1, p95Ms: 1 }],
    slowest: [{ sessionId: 's', nodeId: 'n', projectId: 'p', origin: 'claude', toolName: TERM, durationMs: 1, startedAt: '' }],
    mostFailing: [{ origin: 'claude', toolName: TERM, calls: 1, finished: 1, failed: 1, failureRate: 1 }],
  } as never, m) as unknown;
  expect(JSON.stringify(stats)).not.toContain(TERM);
});

test('诊断页：未知记录的样本、文件路径、错误都遮蔽', () => {
  const m = masker(false);
  const d = maskDiagnostics({
    unknownRecords: [{ recordType: 'x', count: 1, sample: `{"text":"${KEY}"}` }], lastHookAt: null, hookEvents: [],
    files: [{ path: `${TERM}/a.jsonl`, offset: 0, size: 0 }], ingestFailures: [{ file: `${TERM}.jsonl`, error: `bad ${KEY}`, at: '' }],
    importing: false, normalizerVersion: 1, dbEpoch: 'e', codex: { sessionsDir: `C:/${TERM}`, sessionsDirExists: true },
    cursor: { dbPath: null, dbExists: false, lastPollAt: null, lastError: KEY },
    notifications: { enabled: true, available: true, lastSentAt: null, lastSentKind: null, lastError: KEY, lastErrorAt: null, settingsError: null },
  }, m);
  expect(JSON.stringify(d)).not.toContain(KEY);
  expect(JSON.stringify(d)).not.toContain(TERM);
});

const hit = (o: Partial<ContentHit> = {}): ContentHit => ({
  sessionId: 's', projectId: 'p', origin: 'claude', sessionTitle: `t ${KEY}`, nodeId: 'n', kind: 'tool', toolName: `mcp__${TERM}`, at: '', agentId: null,
  snippet: { before: '"password": "', match: '‹已遮蔽·密钥/密码›', after: '", "host"', clippedStart: true, clippedEnd: true }, masked: true, ...o,
});

test('内容检索：开关打开时片段由服务端遮蔽、原样显示（命中可以是占位符）；标题和工具名在页面上遮', () => {
  const m = masker(false);
  const groups = groupContentHits([hit()], m);
  const all = JSON.stringify(groups);
  expect(all).not.toContain(KEY.slice(0, 10));
  expect(all).not.toContain(TERM);
  expect(groups[0]!.rows[0]!.parts.find((p) => p.match)?.text).toBe('‹已遮蔽·密钥/密码›');
});

test('内容检索：开关打开时没有带 masked 的回答不显示（失败即关闭），另一档开关的回答当作还在加载', () => {
  const m = masker(false);
  const response = { hits: [hit()], truncated: false, shortQuery: false, indexing: false };
  const result = { q: 'host', origin: null, response, error: null, mask: true as const };
  expect(contentView(result, 'host', 'all', m).state).toBe('hits');
  const unmasked = { ...result, response: { ...response, hits: [hit({ masked: undefined })] } };
  expect(contentView(unmasked, 'host', 'all', m)).toEqual({ state: 'error', message: SEARCH_UNMASKED_TEXT });
  const { mask: _, ...plain } = result;
  expect(contentView(plain, 'host', 'all', m).state).toBe('loading');
  expect(contentView(result, 'host', 'all', IDENTITY_MASKER).state).toBe('loading');
  expect(contentView(plain, 'host', 'all', IDENTITY_MASKER).state).toBe('hits');
});

test('会话检索：开关打开时每条命中都要带 masked，否则不显示；另一档开关的回答当作还在加载', () => {
  const match = { field: 'prompt' as const, nodeId: 'u1', snippet: '…‹已遮蔽·OpenAI key› to call the staging API…', masked: true as const };
  const hits = [{ session: baseSession, matches: [match] }];
  expect(sessionResultState({ q: 'x', hits, error: null, mask: true }, true)).toBe('ok');
  expect(sessionResultState({ q: 'x', hits: [{ session: baseSession, matches: [{ ...match, masked: undefined }] }], error: null, mask: true }, true)).toBe('unmasked');
  expect(sessionResultState({ q: 'x', hits, error: null }, true)).toBe('loading');
  expect(sessionResultState({ q: 'x', hits, error: null, mask: true }, false)).toBe('loading');
  expect(sessionResultState({ q: 'x', hits, error: null }, false)).toBe('ok');
});

test('检索器：开关变化时两组重新请求（带 mask），旧回答晚到被丢弃', async () => {
  const calls: unknown[][] = [];
  const results: { mask?: true }[] = [];
  const s = createSearcher({
    search: async (...a: unknown[]) => { calls.push(['s', ...a]); return []; },
    onResult: (r) => results.push(r),
    searchContent: async (...a: unknown[]) => { calls.push(['c', ...a]); return { hits: [], truncated: false, shortQuery: false, indexing: false }; },
    onContent: () => {},
    delayMs: 1,
  });
  s.query('host');
  await new Promise((r) => setTimeout(r, 20));
  s.setMask(true);
  await new Promise((r) => setTimeout(r, 20));
  expect(calls).toEqual([['s', 'host'], ['c', 'host', null], ['s', 'host', true], ['c', 'host', null, true]]);
  expect(results.at(-1)!.mask).toBe(true);
  s.dispose();
});

test('请求失败的分类：状态码、取消、连不上', () => {
  expect(failureOf(Object.assign(new Error('x'), { status: 413 }))).toBe(413);
  expect(failureOf(new DOMException('aborted', 'AbortError'))).toBe('abort');
  expect(failureOf(new TypeError('Failed to fetch'))).toBe('network');
});
