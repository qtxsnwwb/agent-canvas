import { expect, test } from 'vitest';
import type { Anomaly, AnomalyListItem, AnomalyListResponse, Graph, GraphNode, Project } from '@agent-canvas/shared';
import {
  ANOMALY_EMPTY_SESSION, ANOMALY_HEURISTIC_NOTE, DEFAULT_ANOMALIES_FILTER, NO_CARD_MARKS, anomaliesUntil, anomalyErrorText,
  graphTurns, pickedRowKey, pollDelay, stableCardMarks, anomaliesHash, anomaliesQueryString, anomalyButton,
  cardMarks, effectiveAnomaliesFilter, graphResolver, homeMarker, kindChips, kindCountsText, listNotes, listRows, panelRows,
  parseAnomaliesQuery, shouldPoll, surfaceState, turnLabel, type AnomalyResolver,
} from '../src/anomalies';
import { parseHash } from '../src/route';
import { mkNode } from './helpers';

function anomaly(o: Partial<Anomaly> & Pick<Anomaly, 'kind' | 'turnKey'>): Anomaly {
  const basis = o.basis ?? (o.kind === 'loop' ? 'failed' : o.kind === 'failures' ? 'streak' : o.kind === 'churn' ? 'edits' : 'time');
  return {
    id: `${o.kind}:${o.turnKey}`, sessionId: 's1', agentId: null, basis, count: 3,
    firstNodeId: 'n1', lastNodeId: 'n2', at: '2026-11-13T10:00:00.000Z', ...o,
  };
}

const project = (id: string, cwd: string | null, origins: Project['origins'] = ['claude']): Project => ({
  id, cwd, origins, sessionCount: 1, activeSessionCount: 0, lastActivityAt: '2026-11-13T00:00:00Z',
} as Project);

// ---- words ----

test('固定文案', () => {
  expect(ANOMALY_EMPTY_SESSION).toBe('这个会话没有发现异常');
  expect(ANOMALY_HEURISTIC_NOTE).toBe('这些是按固定规则找出来的，可能有误报。');
});

test('kindCountsText：按固定顺序列出各类条数，跳过 0', () => {
  expect(kindCountsText({ churn: 1, loop: 2 })).toBe('原地打转 2 条、反复改同一个文件 1 条');
  expect(kindCountsText({ failures: 0, cost: 1 })).toBe('消耗异常高 1 条');
  expect(kindCountsText({})).toBe('');
});

// ---- home ----

test('homeMarker：没有数据或 0 条时没有标记', () => {
  expect(homeMarker(undefined)).toBeNull();
  expect(homeMarker({ total: 0, byKind: {} })).toBeNull();
});

test('homeMarker：总数和各类条数', () => {
  expect(homeMarker({ total: 3, byKind: { loop: 2, failures: 1 } })).toEqual({
    total: 3, label: '发现 3 条异常：原地打转 2 条、失败扎堆 1 条',
  });
});

// ---- session toolbar ----

test('anomalyButton：加载中和 0 条不带数字', () => {
  expect(anomalyButton(null)).toEqual({ text: '异常', label: '异常' });
  expect(anomalyButton([])).toEqual({ text: '异常', label: '异常，没有发现' });
  expect(anomalyButton([anomaly({ kind: 'loop', turnKey: 't1' }), anomaly({ kind: 'churn', turnKey: 't1' })]))
    .toEqual({ text: '异常 2', label: '异常，2 条' });
});

// ---- card markers ----

const noResolve: AnomalyResolver = { dispatchOf: () => undefined, mainTurnOf: () => null };

test('cardMarks：主线程的异常标在它那一轮', () => {
  const marks = cardMarks([
    anomaly({ kind: 'loop', turnKey: 't1' }),
    anomaly({ kind: 'failures', turnKey: 't1' }),
    anomaly({ kind: 'churn', turnKey: 't2' }),
  ], noResolve);
  expect(marks.agents.size).toBe(0);
  expect(marks.turns.get('t1')).toEqual({ count: 2, kinds: ['loop', 'failures'], label: '2 条异常：原地打转 1 条、失败扎堆 1 条' });
  expect(marks.turns.get('t2')).toEqual({ count: 1, kinds: ['churn'], label: '1 条异常：反复改同一个文件 1 条' });
});

test('cardMarks：cost 的两种依据算两条，种类只列一次', () => {
  const marks = cardMarks([
    anomaly({ kind: 'cost', turnKey: 't1', basis: 'time', id: 'cost:t1:time' }),
    anomaly({ kind: 'cost', turnKey: 't1', basis: 'tokens', id: 'cost:t1:tokens' }),
  ], noResolve);
  expect(marks.turns.get('t1')).toEqual({ count: 2, kinds: ['cost'], label: '2 条异常：消耗异常高 2 条' });
});

test('cardMarks：子代理里的异常标在子代理卡片和派出它的那一轮（嵌套的子代理一直追到主线程）', () => {
  const resolver: AnomalyResolver = {
    dispatchOf: (agentId) => ({
      a1: { id: 'd1', agentId: null, title: '查资料' },
      a2: { id: 'd2', agentId: 'a1', title: '再查一层' },
    } as Record<string, { id: string; agentId: string | null; title: string }>)[agentId],
    mainTurnOf: (nodeId) => (nodeId === 'd1' ? 't1' : null),
  };
  const marks = cardMarks([
    anomaly({ kind: 'loop', turnKey: 'a2:p1', agentId: 'a2' }),
    anomaly({ kind: 'churn', turnKey: 't1' }),
  ], resolver);
  expect(marks.agents.get('a2')).toEqual({ count: 1, kinds: ['loop'], label: '1 条异常：原地打转 1 条' });
  expect(marks.agents.has('a1')).toBe(false);
  expect(marks.turns.get('t1')).toEqual({ count: 2, kinds: ['loop', 'churn'], label: '2 条异常：原地打转 1 条、反复改同一个文件 1 条' });
});

test('cardMarks：找不到派出它的节点时只标子代理卡片；派发链有环也不死循环', () => {
  const loopResolver: AnomalyResolver = {
    dispatchOf: (agentId) => (agentId === 'x' ? { id: 'dx', agentId: 'y', title: '' } : { id: 'dy', agentId: 'x', title: '' }),
    mainTurnOf: () => 't1',
  };
  const a = cardMarks([anomaly({ kind: 'loop', turnKey: 'x:p', agentId: 'x' })], loopResolver);
  expect(a.agents.get('x')?.count).toBe(1);
  expect(a.turns.size).toBe(0);
  const b = cardMarks([anomaly({ kind: 'loop', turnKey: 'z:p', agentId: 'z' })], noResolve);
  expect(b.agents.get('z')?.count).toBe(1);
  expect(b.turns.size).toBe(0);
});

function node(id: string, o: Partial<GraphNode>): GraphNode {
  return { ...mkNode(id, o.timestamp), ...o };
}
function graphOf(nodes: GraphNode[]): Graph {
  return { nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), edges: {} };
}

test('graphResolver：派发节点（最早的那个）和主线程节点所在的轮次', () => {
  const g = graphOf([
    node('p1', { kind: 'prompt', turnId: 't1', timestamp: '2026-11-13T10:00:00Z' }),
    node('d1', { kind: 'subagent', childAgentId: 'a1', title: '查资料', timestamp: '2026-11-13T10:00:05Z' }),
    node('d1b', { kind: 'subagent', childAgentId: 'a1', title: '后来的', timestamp: '2026-11-13T10:00:09Z' }),
    node('p2', { kind: 'prompt', turnId: 't2', timestamp: '2026-11-13T10:05:00Z' }),
    node('i1', { kind: 'subagent', agentId: 'a1', childAgentId: 'a2', title: '里面的', timestamp: '2026-11-13T10:00:07Z' }),
  ]);
  const r = graphResolver(g);
  expect(r.dispatchOf('a1')).toEqual({ id: 'd1', agentId: null, title: '查资料' });
  expect(r.dispatchOf('a2')).toEqual({ id: 'i1', agentId: 'a1', title: '里面的' });
  expect(r.dispatchOf('nope')).toBeUndefined();
  expect(r.mainTurnOf('d1')).toBe('t1');
  expect(r.mainTurnOf('p2')).toBe('t2');
  expect(r.mainTurnOf('i1')).toBeNull();
});

// ---- panel rows ----

test('turnLabel：和概览一样的提示摘要，加上第几轮', () => {
  expect(turnLabel(0, '修一下登录')).toBe('第 1 轮 · 修一下登录');
  expect(turnLabel(4, '')).toBe('第 5 轮 · （无提示）');
});

test('panelRows：类型、轮次、依据、时间、churn 的相对路径、跳转地址', () => {
  const turns = [{ key: 't1', promptSummary: '第一个' }, { key: 't2', promptSummary: '' }];
  const resolver: AnomalyResolver = {
    dispatchOf: (a) => (a === 'a1' ? { id: 'd1', agentId: null, title: '查资料' } : a === 'a3' ? { id: 'd3', agentId: null, title: '' } : undefined),
    mainTurnOf: (n) => (n === 'd1' || n === 'd3' ? 't2' : null),
  };
  const rows = panelRows('s 1', [
    anomaly({ kind: 'churn', turnKey: 't1', path: 'D:\\proj\\src\\a.ts', count: 16, lastNodeId: 'e16' }),
    anomaly({ kind: 'loop', turnKey: 'a1:p', agentId: 'a1', count: 4, lastNodeId: 'x/4' }),
    anomaly({ kind: 'failures', turnKey: 'a3:p', agentId: 'a3', count: 6 }),
    anomaly({ kind: 'loop', turnKey: 'gone', count: 3 }),
    anomaly({ kind: 'churn', turnKey: 't1', id: 'churn:t1b', path: 'E:/other/b.ts', count: 15 }),
  ], { turns, resolver, cwd: 'D:\\proj' });
  expect(rows.map((r) => r.key)).toEqual(['churn:t1', 'loop:a1:p', 'failures:a3:p', 'loop:gone', 'churn:t1b']);
  expect(rows[0]).toMatchObject({
    kind: 'churn', kindLabel: '反复改同一个文件', turnText: '第 1 轮 · 第一个', agentText: null, basis: '改了 16 次',
    path: { shown: 'src/a.ts', full: 'D:\\proj\\src\\a.ts' }, nodeId: 'e16', href: '#/s/s%201/n/e16',
    at: '2026-11-13T10:00:00.000Z',
  });
  expect(rows[1]).toMatchObject({ kindLabel: '原地打转', turnText: '第 2 轮 · （无提示）', agentText: '在子代理“查资料”里', basis: '同一个调用失败了 4 次', path: null, href: '#/s/s%201/n/x%2F4' });
  expect(rows[2]).toMatchObject({ turnText: '第 2 轮 · （无提示）', agentText: '在子代理里' });
  expect(rows[3]).toMatchObject({ turnText: null, agentText: null });
  expect(rows[4]!.path).toEqual({ shown: 'E:/other/b.ts', full: 'E:/other/b.ts' });
});

// ---- the anomalies page: filter in the address ----

test('#/anomalies 是异常页，带上查询部分', () => {
  expect(parseHash('#/anomalies')).toEqual({ page: 'anomalies', query: '' });
  expect(parseHash('#/anomalies?range=7d&kind=loop')).toEqual({ page: 'anomalies', query: 'range=7d&kind=loop' });
  expect(parseHash('#/anomaliesx')).toEqual({ page: 'home', projectId: null });
});

test('parseAnomaliesQuery：默认 30 天，不认识的值回到默认', () => {
  expect(DEFAULT_ANOMALIES_FILTER).toEqual({ range: '30d', origin: 'all', projectId: null, kind: null });
  expect(parseAnomaliesQuery('')).toEqual(DEFAULT_ANOMALIES_FILTER);
  expect(parseAnomaliesQuery('range=7d&origin=codex&projectId=p%2F1&kind=churn'))
    .toEqual({ range: '7d', origin: 'codex', projectId: 'p/1', kind: 'churn' });
  expect(parseAnomaliesQuery('range=1y&origin=x&projectId=&kind=nope')).toEqual(DEFAULT_ANOMALIES_FILTER);
  expect(parseAnomaliesQuery('%E0%A4%A')).toEqual(DEFAULT_ANOMALIES_FILTER);
});

test('anomaliesHash：只写和默认不同的部分，能原样读回', () => {
  expect(anomaliesHash(DEFAULT_ANOMALIES_FILTER)).toBe('#/anomalies');
  const f = { range: 'all', origin: 'cursor', projectId: 'D:/项目 #1', kind: 'failures' } as const;
  const hash = anomaliesHash(f);
  const route = parseHash(hash);
  expect(route.page).toBe('anomalies');
  expect(parseAnomaliesQuery((route as { query: string }).query)).toEqual(f);
});

test('anomaliesQueryString：范围总带上，其余有筛选才带', () => {
  expect(anomaliesQueryString(DEFAULT_ANOMALIES_FILTER)).toBe('range=30d');
  expect(anomaliesQueryString({ range: '7d', origin: 'codex', projectId: 'a&b', kind: 'cost' }))
    .toBe('range=7d&origin=codex&projectId=a%26b&kind=cost');
});

test('effectiveAnomaliesFilter：项目不在了回到全部项目，来源只剩一种时不筛；类型保留', () => {
  const f = { range: '7d', origin: 'codex', projectId: 'gone', kind: 'loop' } as const;
  expect(effectiveAnomaliesFilter(f, null)).toEqual(f);
  expect(effectiveAnomaliesFilter(f, [project('p1', '/a')])).toEqual({ range: '7d', origin: 'all', projectId: null, kind: 'loop' });
  expect(effectiveAnomaliesFilter({ ...f, projectId: 'p2' }, [project('p1', '/a'), project('p2', '/b', ['codex'])]))
    .toEqual({ range: '7d', origin: 'codex', projectId: 'p2', kind: 'loop' });
});

test('kindChips：全部 + 四类，带上各类条数；没有数据时不带数', () => {
  const chips = kindChips({ loop: 2, failures: 0, churn: 5, cost: 1 }, 'churn');
  expect(chips.map((c) => [c.kind, c.label, c.count, c.pressed])).toEqual([
    [null, '全部', 8, false],
    ['loop', '原地打转', 2, false],
    ['failures', '失败扎堆', 0, false],
    ['churn', '反复改同一个文件', 5, true],
    ['cost', '消耗异常高', 1, false],
  ]);
  expect(kindChips(null, null).map((c) => [c.count, c.pressed])).toEqual([[null, true], [null, false], [null, false], [null, false], [null, false]]);
});

function item(o: Partial<AnomalyListItem> & Pick<AnomalyListItem, 'kind' | 'turnKey'>): AnomalyListItem {
  return { ...anomaly(o), projectId: 'p1', origin: 'claude', sessionTitle: '修 bug', ...o };
}

test('listRows：标题回退到 id 前 8 位，churn 的路径相对项目目录，键是 sessionId + id', () => {
  const rows = listRows([
    item({ kind: 'churn', turnKey: 't1', sessionId: 'abcdefghij', sessionTitle: null, path: '/repo/src/x.ts', count: 15, lastNodeId: 'n9' }),
    item({ kind: 'churn', turnKey: 't1', sessionId: 'other', projectId: 'p9', path: '/elsewhere/y.ts' }),
    item({ kind: 'loop', turnKey: 't1', sessionId: 'other', origin: 'codex', basis: 'repeat', count: 5 }),
  ], [project('p1', '/repo')]);
  expect(rows[0]).toMatchObject({
    key: 'abcdefghij\u0000churn:t1', title: 'abcdefgh', kindLabel: '反复改同一个文件', basis: '改了 15 次', origin: 'claude',
    path: { shown: 'src/x.ts', full: '/repo/src/x.ts' }, href: '#/s/abcdefghij/n/n9',
  });
  expect(rows[1]!.path).toEqual({ shown: '/elsewhere/y.ts', full: '/elsewhere/y.ts' });
  expect(rows[2]).toMatchObject({ key: 'other\u0000loop:t1', title: '修 bug', origin: 'codex', basis: '同一个调用连续执行了 5 次', path: null });
  expect(new Set(rows.map((r) => r.key)).size).toBe(3);
});

const listResponse = (o: Partial<AnomalyListResponse> = {}): AnomalyListResponse => ({
  items: [], totals: { loop: 0, failures: 0, churn: 0, cost: 0 }, truncated: false, computing: false, failedSessions: 0, ...o,
});

test('listNotes：只显示最新 200 条、有会话算不出来', () => {
  expect(listNotes(listResponse())).toEqual([]);
  expect(listNotes(listResponse({ truncated: true, failedSessions: 2 }))).toEqual([
    '只显示最新的 200 条，用上面的筛选缩小范围。',
    '有 2 个会话算不出来，已跳过。',
  ]);
});

// ---- states ----

test('surfaceState：加载中、出错、空、有内容；有旧数据时出错仍显示旧数据', () => {
  expect(surfaceState(null, null, () => true)).toBe('loading');
  expect(surfaceState(null, 'HTTP 500', () => true)).toBe('error');
  expect(surfaceState([], null, (d) => d.length === 0)).toBe('empty');
  expect(surfaceState([1], 'HTTP 500', (d) => d.length === 0)).toBe('ready');
});

test('shouldPoll：仍在计算时继续取', () => {
  expect(shouldPoll(null)).toBe(false);
  expect(shouldPoll({ computing: false })).toBe(false);
  expect(shouldPoll({ computing: true })).toBe(true);
});

// ---- final review fixes ----

test('anomalyErrorText：会话算不出来、筛选不对、其他 HTTP 错误、连不上', () => {
  const http = (status: number) => Object.assign(new Error(`/x: HTTP ${status}`), { status });
  expect(anomalyErrorText(http(500), 'session')).toBe('这个会话的异常没能算出来');
  expect(anomalyErrorText(http(404), 'session')).toBe('这个会话已经不在了');
  expect(anomalyErrorText(http(400), 'list')).toBe('筛选条件不对，换一个试试');
  expect(anomalyErrorText(http(500), 'list')).toBe('服务出错了（HTTP 500）');
  expect(anomalyErrorText(http(503), 'counts')).toBe('服务出错了（HTTP 503）');
  expect(anomalyErrorText(new TypeError('Failed to fetch'), 'list')).toBe('连不上 Agent Canvas 服务，请确认它还在运行');
  expect(anomalyErrorText('boom', 'session')).toBe('连不上 Agent Canvas 服务，请确认它还在运行');
});

test('stableCardMarks：内容没变时沿用上一次的对象，变了的才换', () => {
  const list = [anomaly({ kind: 'loop', turnKey: 't1' }), anomaly({ kind: 'churn', turnKey: 't2' })];
  const a = cardMarks(list, noResolve);
  const b = cardMarks(list.map((x) => ({ ...x })), noResolve);
  expect(stableCardMarks(a, b)).toBe(a);
  const grown = cardMarks([anomaly({ kind: 'loop', turnKey: 't1', count: 4 }), anomaly({ kind: 'churn', turnKey: 't2' }), anomaly({ kind: 'failures', turnKey: 't2' })], noResolve);
  const c = stableCardMarks(a, grown);
  expect(c).not.toBe(a);
  expect(c.turns.get('t1')).toBe(a.turns.get('t1')); // same count, kinds and label
  expect(c.turns.get('t2')).not.toBe(a.turns.get('t2'));
  expect(c.turns.get('t2')!.count).toBe(2);
  expect(stableCardMarks(a, NO_CARD_MARKS)).toBe(NO_CARD_MARKS);
});

test('anomaliesUntil：复盘时只留回放时间之前（含）的；时间读不出的算 0；null 原样返回', () => {
  const list = [
    anomaly({ kind: 'loop', turnKey: 't1', at: '2026-11-13T10:00:00.000Z' }),
    anomaly({ kind: 'churn', turnKey: 't2', at: '2026-11-13T11:00:00.000Z' }),
    anomaly({ kind: 'failures', turnKey: 't3', at: 'bad' }),
  ];
  expect(anomaliesUntil(list, null)).toBe(list);
  expect(anomaliesUntil(list, Date.parse('2026-11-13T10:00:00.000Z')).map((a) => a.id)).toEqual(['loop:t1', 'failures:t3']);
  expect(anomaliesUntil(list, Date.parse('2026-11-13T09:00:00.000Z')).map((a) => a.id)).toEqual(['failures:t3']);
});

test('pickedRowKey：两条异常落在同一个节点上时只标点过的那一条；从别处跳来时标第一条', () => {
  const rows = [{ key: 'loop:t1', nodeId: 'n6' }, { key: 'failures:t1', nodeId: 'n6' }, { key: 'churn:t2', nodeId: 'n9' }];
  expect(pickedRowKey(rows, 'failures:t1', 'n6')).toBe('failures:t1');
  expect(pickedRowKey(rows, null, 'n6')).toBe('loop:t1');
  expect(pickedRowKey(rows, 'failures:t1', 'n9')).toBe('churn:t2'); // the address moved on
  expect(pickedRowKey(rows, 'gone', 'n6')).toBe('loop:t1');
  expect(pickedRowKey(rows, 'loop:t1', null)).toBeNull();
  expect(pickedRowKey(rows, null, 'nx')).toBeNull();
});

test('卡片不存在的异常：标记被丢掉，面板照样列出（轮次写不出）', () => {
  const list = [anomaly({ kind: 'loop', turnKey: '__prelude__' }), anomaly({ kind: 'churn', turnKey: 't1' }), anomaly({ kind: 'failures', turnKey: 'x:p', agentId: 'x' })];
  const marks = cardMarks(list, noResolve, { turns: new Set(['t1']), agents: new Set() });
  expect([...marks.turns.keys()]).toEqual(['t1']);
  expect(marks.agents.size).toBe(0);
  const rows = panelRows('s1', list, { turns: [{ key: 't1', promptSummary: 'p' }], resolver: noResolve, cwd: null });
  expect(rows.map((r) => [r.key, r.turnText])).toEqual([['loop:__prelude__', null], ['churn:t1', '第 1 轮 · p'], ['failures:x:p', null]]);
});

test('pollDelay：仍在计算时继续取，失败时按次数退避（有上限）；算完了就停', () => {
  expect(pollDelay(false, 0)).toBeNull();
  expect(pollDelay(false, 3)).toBeNull();
  expect(pollDelay(true, 0)).toBe(3_000);
  expect(pollDelay(true, 1)).toBe(6_000);
  expect(pollDelay(true, 2)).toBe(12_000);
  expect(pollDelay(true, 10)).toBe(30_000);
});

test('graphTurns：主线程的轮次（和概览同样的分法），带上第一个提示的摘要；不受复盘时间影响', () => {
  const g = graphOf([
    node('p1', { kind: 'prompt', turnId: 't1', summary: '第一个', timestamp: '2026-11-13T10:00:00Z' }),
    node('x1', { kind: 'tool', timestamp: '2026-11-13T10:00:01Z' }),
    node('i1', { kind: 'prompt', agentId: 'a1', summary: '子代理的', timestamp: '2026-11-13T10:00:02Z' }),
    node('p2', { kind: 'text', turnId: 't2', timestamp: '2026-11-13T10:05:00Z' }),
  ]);
  expect(graphTurns(g)).toEqual([{ key: 't1', promptSummary: '第一个' }, { key: 't2', promptSummary: '' }]);
});
