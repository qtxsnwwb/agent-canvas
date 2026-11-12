# agent-canvas 里程碑 2（实时画布）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 会话页从节点列表换成画布：节点和边自上而下自动布局，状态用颜色和动效区分，随执行实时更新并自动跟随最新节点，长会话的旧轮次折叠成摘要节点，点击节点在右侧抽屉看完整内容。

**Architecture:** 前端在已有的实时图（`LiveSession`）之上加三层，全部在 `packages/web/src/canvas/`：纯函数 `buildView` 把图变成"画布视图"（只留主线节点、按轮次分组、折叠旧轮次、改写边）；布局层按轮次分别用 elkjs 在 Web Worker 里计算位置并缓存，再把各轮次自上而下堆叠；React Flow 组件只负责画。服务端只改一处数据模型（派发节点的归属）。

**Tech Stack:** 已有栈之外新增 `@xyflow/react`（React Flow 12）和 `elkjs`，只加在 `@agent-canvas/web`。

**Spec:** `docs/superpowers/specs/2026-11-10-agent-canvas-design.md`（7.1、7.2、7.3 的"实时"一行、12 节第 2 项）

**范围说明：** 只做里程碑 2。子代理在本里程碑是**单个节点**（显示类型、任务、状态、内部节点数），内部节点不上画布；展开为容器、拓扑视角属于里程碑 3。因果视角、复盘时间轴、视角切换栏、诊断页都不在本计划内。分支 `feat/m2-canvas`，从 `feat/m1-pipeline` 切出（PR #1 未合并）。

## Global Constraints

- 不得放宽 Content-Security-Policy：`script-src` 不得出现 `unsafe-eval`、`blob:`、`data:`。Worker 必须是同源的独立文件。
- 不新增服务端接口；除 Task 1 外不改 `packages/server`。
- 界面文案一律简体中文。
- 测试不得读写真实用户目录；需要起服务时用 `AGENT_CANVAS_PROJECTS_DIR` / `AGENT_CANVAS_DATA_DIR` 指向临时目录。夹具为合成数据，不含真实对话、路径、用户名。
- web 的单元测试只测纯逻辑（Vitest，node 环境，文件名 `*.test.ts`），不引入 jsdom、不写组件测试；界面在浏览器里实测（规格第 11 节）。
- 节点在画布上尺寸固定（`sizeOf`），文字超出用 CSS 截断，不得撑大节点。
- 节点不可拖动、不可连线；位置全部自动计算。
- 命令用 `npx --yes pnpm@10 <命令>`。完成每个任务时 `npx --yes pnpm@10 test`、`typecheck`、`build` 必须全过。
- 提交信息用英文 Conventional Commits，结尾带 `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`。

## Review Focus

1. **实时更新时画布乱跳。** 最后一个轮次追加节点时，之前轮次里每个节点的坐标必须不变；使用者停止跟随后，视口不得被程序移动。（测试在 Task 3；浏览器核对在 Task 7）
2. **过期的布局结果覆盖新的。** 变更密集时布局请求会叠在一起，慢的旧结果不得盖掉新结果，也不得让节点闪回旧位置。（测试在 Task 3）
3. **图不完整。** hook 先到的占位节点没有 `turnId`；边的一端还没到、或指向子代理内部节点；`parentId` 指向不存在的节点。期望：节点仍被放进某个轮次，悬空的边被跳过，不抛异常。（测试在 Task 2）
4. **超大会话。** 本机最大的真实会话有 7396 个节点（主线约 2000 个、62 个轮次，单个轮次最多 359 个主线节点）。期望：打开时只对展开的轮次做布局，折叠的轮次各只占一个节点；展开最大的轮次时页面不卡死（布局在 Worker 里）。（测试在 Task 2；实测在 Task 7）
5. **节点文字异常。** 超长无空格字符串、多行文本、中日韩文字、空摘要。期望：节点框大小不变，文字单行截断并带省略号，空摘要不留空行错位。（实现在 Task 4；浏览器核对在 Task 7）

---

## 文件结构

```
packages/shared/src/model.ts            改：GraphNode 增加 childAgentId
packages/server/src/normalize/          改：派发节点保留自己的 agentId；版本号 3
packages/web/src/canvas/
  view.ts            图 → 画布视图（纯函数）
  format.ts          耗时格式化
  sizes.ts           各类节点的固定尺寸
  layout.ts          单轮次 elk 布局、轮次堆叠（纯函数 + 一个接收 elk 实例的异步函数）
  layout.worker.ts   Worker 入口：收到请求 → layoutTurn → 回结果
  layoutClient.ts    主线程侧：缓存、去重、丢弃过期结果
  useCanvas.ts       LiveSession → 视图 → 布局 → 位置 的 React hook
  follow.ts          跟随目标计算
  Canvas.tsx         React Flow 画布
  nodes.tsx          三种自定义节点：graphNode、turnSummary、turnHeader
  Drawer.tsx         右侧详情抽屉
  canvas.css         画布样式（状态色、动效）
packages/web/src/pages/Session.tsx      改：列表换成画布 + 抽屉
packages/web/test/canvas-*.test.ts      view / format / layout / layoutClient / follow 的测试
```

---

### Task 1: 派发节点的归属（`childAgentId`）

现状：子代理的派发节点（`kind: 'subagent'`）在收到代理元数据后，`agentId` 被改写成**它派出的**代理的 id，于是 `agentId === null` 不再等于"主线节点"，主线上发起的 Agent 工具的权限请求也匹配不到它。规格 4.2 的 `agentId` 是"节点所属的线程（主线为空）"。

**Files:**
- Modify: `packages/shared/src/model.ts`
- Modify: `packages/server/src/normalize/normalizer.ts`、`packages/server/src/normalize/version.ts`
- Modify: `docs/superpowers/specs/2026-11-10-agent-canvas-design.md`（4.2 节表格下一行）
- Test: `packages/server/test/normalizer-subagent.test.ts`（没有则在现有的子代理测试文件里加）

**Interfaces:**
- Produces: `GraphNode.childAgentId: string | null` —— 仅 `subagent` 节点可能有值：它派出的代理的 id（元数据到达前为 `null`）；其余节点恒为 `null`。`GraphNode.agentId` 对所有节点都是"所属线程"，派发节点也不例外。`NORMALIZER_VERSION = 3`。

- [ ] **Step 1: 写失败的测试**

```ts
test('派发节点保留自己所属的线程，派出的代理记在 childAgentId', () => {
  // 主线：assistant 发出 Agent 工具 tu1；随后代理 a1 的元数据和 a1 的第一条记录到达
  const g = run([mainAssistantWithAgentTool('tu1'), agentMeta('a1', 'tu1'), agentRecord('a1', 'r1')]);
  expect(g.nodes['tool:tu1']).toMatchObject({ kind: 'subagent', agentId: null, childAgentId: 'a1' });
  expect(g.nodes['r1']).toMatchObject({ agentId: 'a1', childAgentId: null });
  expect(Object.values(g.edges).filter((e) => e.kind === 'spawn')).toEqual([
    expect.objectContaining({ from: 'tool:tu1', to: 'r1' }),
  ]);
});

test('代理内部再派发：内层派发节点的 agentId 是外层代理', () => {
  const g = run([mainAssistantWithAgentTool('tu1'), agentMeta('a1', 'tu1'), agentAssistantWithAgentTool('a1', 'tu2'), agentMeta('a2', 'tu2')]);
  expect(g.nodes['tool:tu2']).toMatchObject({ agentId: 'a1', childAgentId: 'a2' });
});

test('元数据到达后，主线对 Agent 工具的 PermissionRequest 仍能匹配到派发节点', () => {
  const g = run([mainAssistantWithAgentTool('tu1', { input: { prompt: 'p' } }), agentMeta('a1', 'tu1'),
    hook('PermissionRequest', { tool_name: 'Agent', tool_input: { prompt: 'p' } })]);
  expect(g.nodes['tool:tu1']!.status).toBe('awaiting_permission');
});

test('除派发边外，没有边连接不同线程的节点', () => {
  const g = run([mainAssistantWithAgentTool('tu1'), agentMeta('a1', 'tu1'), agentRecord('a1', 'r1'), mainToolResult('tu1'), mainAssistantText('t2')]);
  for (const e of Object.values(g.edges)) {
    if (e.kind !== 'spawn') expect(g.nodes[e.from]!.agentId).toBe(g.nodes[e.to]!.agentId);
  }
});
```

夹具构造函数沿用该测试文件已有的辅助函数；没有的按同文件风格补。

- [ ] **Step 2: 运行，确认失败**（`npx --yes pnpm@10 vitest run packages/server/test -t 派发节点`，期望：`agentId` 为 `'a1'` 而非 `null`）
- [ ] **Step 3: 实现。** `GraphNode` 加 `childAgentId`；`applyAgentMeta` 的补丁改为 `{ childAgentId, title, summary }`，不再改 `agentId`；所有构造 `GraphNode` 的地方补 `childAgentId: null`；凡是靠"派发节点的 `agentId`"找派出代理的读取点改读 `childAgentId` 或已有的 `dispatchByAgent`。`NORMALIZER_VERSION` 改为 3。
- [ ] **Step 4: 规格 4.2 "所有节点共有"一行后加一句：** `subagent 节点另有 childAgentId：它派出的代理的 id（元数据到达前为空）；agentId 仍是它自己所属的线程。`
- [ ] **Step 5: 全量测试、类型检查、构建通过后提交**（`fix: keep the dispatch node on its own thread, record the spawned agent in childAgentId`）

---

### Task 2: 画布视图 `buildView`

**Files:**
- Create: `packages/web/src/canvas/view.ts`、`packages/web/src/canvas/format.ts`
- Test: `packages/web/test/canvas-view.test.ts`、`packages/web/test/canvas-format.test.ts`

**Interfaces:**
- Consumes: `Graph`、`GraphNode`（含 Task 1 的 `childAgentId`）、`EdgeKind`。
- Produces:

```ts
export const EXPANDED_RECENT_TURNS = 3;
export const PRELUDE_TURN = '__prelude__';

export interface TurnSummary {
  turnKey: string;
  promptSummary: string;   // 该轮次第一个 prompt 节点的 summary，没有则 ''
  nodeCount: number;       // 该轮次的主线节点数
  toolCount: number;       // 其中 kind 为 tool 或 subagent 的个数
  failedCount: number;     // 其中 status 为 failed 或 denied 的个数
  running: boolean;        // 是否有 status 为 running 或 awaiting_permission 的节点
  startedAt: string;       // 该轮次最早节点的 timestamp
  durationMs: number;      // 最晚 − 最早
}
export type ViewNode =
  | { type: 'node'; id: string; turnKey: string; node: GraphNode; innerCount: number }
  | { type: 'turn_summary'; id: string; turnKey: string; summary: TurnSummary };   // id = `turn:${turnKey}`
export interface ViewEdge { id: string; from: string; to: string; kind: EdgeKind }
export interface TurnView { key: string; collapsed: boolean; summary: TurnSummary; nodeIds: string[] }
export interface CanvasView {
  turns: TurnView[];                 // 按 startedAt 升序，相同按 key
  nodes: Map<string, ViewNode>;
  edges: ViewEdge[];
  latestNodeId: string | null;       // timestamp 最大的主线节点对应的视图节点 id
}
/** overrides：turnKey → true 展开 / false 折叠；没有覆盖的轮次，最后 EXPANDED_RECENT_TURNS 个展开，其余折叠。 */
export function buildView(graph: Graph, overrides: ReadonlyMap<string, boolean>): CanvasView;

export function formatDuration(ms: number): string;   // format.ts
```

规则（实现唯一依据）：

1. 主线节点 = `agentId === null` 的节点。其余节点不进视图，只用于 `innerCount`（`agentId === node.childAgentId` 的节点数；`childAgentId` 为空时 0）。
2. 轮次键：节点的 `turnId`；`turnId` 为空的主线节点归入"`startedAt` ≤ 该节点 timestamp 的最晚一个轮次"，一个都没有则归入 `PRELUDE_TURN`。轮次的 `startedAt` 只由带 `turnId` 的节点决定（`PRELUDE_TURN` 用它自己最早的节点）。
3. 轮次内节点按 timestamp 升序，相同按 id。展开的轮次 `nodeIds` 是这些节点 id；折叠的轮次 `nodeIds` 是 `[ 'turn:<key>' ]`。
4. 边：只保留两端都是主线节点的边；每一端映射到视图节点 id（所在轮次折叠则为 `turn:<key>`）；映射后两端相同的丢弃；`from->to` 相同的只留一条，id 为 `` `${from}->${to}` ``，跨轮次的边 kind 一律 `sequence`。
5. 相邻两个轮次之间如果第 4 步没有产生任何边，补一条 `sequence` 边：前一轮次最后一个视图节点 → 后一轮次第一个视图节点。
6. `formatDuration`：`< 1000` → `"850ms"`；`< 60000` → 一位小数的秒 `"3.4s"`；否则 `"2分05秒"`；负数或非有限数 → `""`。

- [ ] **Step 1: 写失败的测试**（`canvas-view.test.ts`，用本文件内的 `node(id, {...})`、`edge(from, to, kind)` 小工厂造合成图）

```ts
test('只有主线节点进视图；子代理节点带内部节点数', () => {
  const v = buildView(graph([p('p1','t1',0), sub('s1','t1',1,{childAgentId:'a1'}), inner('i1','a1',2), inner('i2','a1',3)],
    [e('p1','s1'), e('s1','i1','spawn'), e('i1','i2')]), new Map());
  expect([...v.nodes.keys()]).toEqual(['p1','s1']);
  expect(v.nodes.get('s1')).toMatchObject({ type: 'node', innerCount: 2 });
  expect(v.edges).toEqual([{ id: 'p1->s1', from: 'p1', to: 's1', kind: 'sequence' }]);
});

test('默认只展开最后 3 个轮次，更早的各折叠成一个摘要节点', () => {
  const v = buildView(fiveTurnsOfThreeNodes(), new Map());
  expect(v.turns.map((t) => t.collapsed)).toEqual([true, true, false, false, false]);
  expect(v.turns[0]!.nodeIds).toEqual(['turn:t1']);
  expect(v.nodes.size).toBe(2 + 9);
  expect(v.nodes.get('turn:t1')).toMatchObject({ type: 'turn_summary', summary: { nodeCount: 3, toolCount: 1, promptSummary: 'prompt t1' } });
});

test('覆盖项优先于默认：可展开旧轮次、折叠新轮次', () => {
  const v = buildView(fiveTurnsOfThreeNodes(), new Map([['t1', true], ['t5', false]]));
  expect(v.turns.map((t) => t.collapsed)).toEqual([false, true, false, false, true]);
});

test('折叠轮次的边改接到摘要节点，轮次内部的边消失，不重复', () => {
  const v = buildView(fiveTurnsOfThreeNodes(), new Map());   // 每轮 p→x→y，y→下一轮的 p
  expect(v.edges.filter((x) => x.from === 'turn:t1' || x.to === 'turn:t1')).toEqual([{ id: 'turn:t1->turn:t2', from: 'turn:t1', to: 'turn:t2', kind: 'sequence' }]);
  expect(new Set(v.edges.map((x) => x.id)).size).toBe(v.edges.length);
});

test('相邻轮次之间没有边时补一条顺序边', () => {
  const v = buildView(graph([p('p1','t1',0), p('p2','t2',10)], []), new Map());
  expect(v.edges).toEqual([{ id: 'p1->p2', from: 'p1', to: 'p2', kind: 'sequence' }]);
});

test('没有 turnId 的主线节点归入时间上所在的轮次；最前面没有轮次时归入 prelude', () => {
  const v = buildView(graph([sys('c0', null, -5), p('p1','t1',0), tool('h1', null, 3), p('p2','t2',10), tool('h2', null, 12)], []), new Map());
  expect(v.turns.map((t) => [t.key, t.nodeIds])).toEqual([[PRELUDE_TURN, ['c0']], ['t1', ['p1','h1']], ['t2', ['p2','h2']]]);
});

test('悬空的边被跳过：一端不存在或指向子代理内部节点', () => {
  const v = buildView(graph([p('p1','t1',0), inner('i1','a1',1)], [e('p1','missing'), e('p1','i1'), e('ghost','p1')]), new Map());
  expect(v.edges).toEqual([]);
});

test('摘要统计：失败数、是否仍在运行、耗时', () => {
  const v = buildView(graph([p('p1','t1',0), tool('a','t1',1000,{status:'failed'}), tool('b','t1',4000,{status:'running'}), p('p2','t2',9000), p('p3','t3',9001), p('p4','t4',9002)], []), new Map());
  expect(v.turns[0]!.summary).toMatchObject({ failedCount: 1, running: true, durationMs: 4000, toolCount: 2 });
});

test('latestNodeId 是时间最晚的主线节点；它在折叠轮次里时是该摘要节点；空图为 null', () => {
  expect(buildView(emptyGraph(), new Map()).latestNodeId).toBeNull();
  expect(buildView(fiveTurnsOfThreeNodes(), new Map()).latestNodeId).toBe('y5');
  expect(buildView(fiveTurnsOfThreeNodes(), new Map([['t5', false]])).latestNodeId).toBe('turn:t5');
});
```

`canvas-format.test.ts`：

```ts
test.each([[850, '850ms'], [3400, '3.4s'], [59999, '60.0s'], [125000, '2分05秒'], [-1, ''], [Number.NaN, '']])('formatDuration(%s)', (ms, s) => {
  expect(formatDuration(ms)).toBe(s);
});
```

- [ ] **Step 2: 运行，确认失败**（模块不存在）
- [ ] **Step 3: 实现 `buildView` 与 `formatDuration`。** 单次遍历分组；时间用字符串比较前先 `Date.parse`，解析失败按 0。
- [ ] **Step 4: 运行，确认通过；全量测试、类型检查通过后提交**（`feat(web): canvas view model with turn folding`）

---

### Task 3: 布局（elk、按轮次缓存、Worker）

**Files:**
- Modify: `packages/web/package.json`（依赖 `@xyflow/react`、`elkjs`，取安装时的最新稳定版）
- Create: `packages/web/src/canvas/sizes.ts`、`layout.ts`、`layout.worker.ts`、`layoutClient.ts`
- Test: `packages/web/test/canvas-layout.test.ts`、`packages/web/test/canvas-layout-client.test.ts`

**Interfaces:**
- Consumes: `ViewNode`、`CanvasView`、`TurnView`（Task 2）。
- Produces:

```ts
// sizes.ts —— 固定尺寸（宽×高）：prompt 280×64，text 280×56，thinking 160×28，tool 240×52，subagent 260×68，
// system 200×32，unknown 200×40，turn_summary 340×60
export function sizeOf(v: ViewNode): { width: number; height: number };

// layout.ts
export interface Box { x: number; y: number; width: number; height: number }
export interface TurnLayoutInput { key: string; nodes: { id: string; width: number; height: number }[]; edges: { id: string; from: string; to: string }[] }
export interface TurnLayout { key: string; width: number; height: number; positions: Record<string, { x: number; y: number }> }  // 坐标相对轮次左上角
export interface ElkLike { layout(graph: unknown): Promise<unknown> }
export const TURN_GAP = 56;      // 相邻轮次之间的竖直间距
export const TURN_HEADER = 28;   // 每个轮次顶部留给轮次标题的高度
/** 该轮次的布局输入：节点顺序同 TurnView.nodeIds；只含两端都在本轮次内的边。 */
export function turnInput(view: CanvasView, turn: TurnView): TurnLayoutInput;
/** 输入相同则字符串相同：节点 id+尺寸、边的 from/to，按输入顺序。 */
export function turnSignature(input: TurnLayoutInput): string;
export function layoutTurn(elk: ElkLike, input: TurnLayoutInput): Promise<TurnLayout>;
/** 按给定顺序自上而下堆叠，每个轮次以 x=0 为中心；第 i 个轮次的 box.y = 前面各轮次 (TURN_HEADER + height + TURN_GAP) 之和，节点 y 再加 TURN_HEADER。 */
export function stackTurns(layouts: TurnLayout[]): { positions: Record<string, { x: number; y: number }>; turnBoxes: Record<string, Box> };

// layoutClient.ts
export interface WorkerLike { postMessage(msg: unknown): void; terminate(): void; onmessage: ((ev: { data: unknown }) => void) | null; onerror: ((ev: unknown) => void) | null }
export interface LayoutClient { layout(input: TurnLayoutInput): Promise<TurnLayout>; dispose(): void }
/** 结果按 key+签名缓存（最多 300 项，超出删最久未用的）；同一签名的并发请求共用一次计算；Worker 出错时该次请求 reject，下次请求重建 Worker。 */
export function createLayoutClient(createWorker: () => WorkerLike): LayoutClient;
```

Worker 协议：请求 `{ id: number; input: TurnLayoutInput }`，应答 `{ id; layout: TurnLayout }` 或 `{ id; error: string }`。`layout.worker.ts` 用 `elkjs/lib/elk.bundled.js` 建一个 `ELK` 实例并调 `layoutTurn`。主线程用 `new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' })`，由 Vite 产出同源的独立文件。

elk 选项：`elk.algorithm: layered`、`elk.direction: DOWN`、`elk.layered.spacing.nodeNodeBetweenLayers: 32`、`elk.spacing.nodeNode: 24`、`elk.layered.considerModelOrder.strategy: NODES_AND_EDGES`、`elk.padding: [top=0,left=0,bottom=0,right=0]`。只有一个节点的输入不调用 elk，直接返回该节点位于 (0,0)。

- [ ] **Step 1: 写失败的测试**（`canvas-layout.test.ts`，在 node 里直接用 `new ELK()`，来自 `elkjs/lib/elk.bundled.js`）

```ts
const n = (id: string, width = 240, height = 52) => ({ id, width, height });
const elk = new ELK();

test('链式节点自上而下排列，互不重叠', async () => {
  const l = await layoutTurn(elk, { key: 't', nodes: [n('a'), n('b'), n('c')], edges: [{ id: 'a->b', from: 'a', to: 'b' }, { id: 'b->c', from: 'b', to: 'c' }] });
  expect(l.positions.a!.y).toBeLessThan(l.positions.b!.y);
  expect(l.positions.b!.y - l.positions.a!.y).toBeGreaterThanOrEqual(52);
  expect(l.positions.b!.y).toBeLessThan(l.positions.c!.y);
});

test('并行分叉的节点在同一层、左右排开且按输入顺序', async () => {
  const l = await layoutTurn(elk, { key: 't', nodes: [n('a'), n('b1'), n('b2'), n('b3')], edges: ['b1', 'b2', 'b3'].map((b) => ({ id: `a->${b}`, from: 'a', to: b })) });
  expect(new Set([l.positions.b1!.y, l.positions.b2!.y, l.positions.b3!.y]).size).toBe(1);
  expect(l.positions.b1!.x + 240).toBeLessThanOrEqual(l.positions.b2!.x);
  expect(l.positions.b2!.x + 240).toBeLessThanOrEqual(l.positions.b3!.x);
  expect(l.width).toBeGreaterThanOrEqual(3 * 240);
});

test('单节点不调用 elk', async () => {
  const never: ElkLike = { layout: () => { throw new Error('called'); } };
  expect(await layoutTurn(never, { key: 't', nodes: [n('a', 340, 60)], edges: [] })).toEqual({ key: 't', width: 340, height: 60, positions: { a: { x: 0, y: 0 } } });
});

test('没有边的多个节点也不重叠（占位节点尚未接上）', async () => {
  const l = await layoutTurn(elk, { key: 't', nodes: [n('a'), n('b')], edges: [] });
  const [a, b] = [l.positions.a!, l.positions.b!];
  expect(Math.abs(a.x - b.x) >= 240 || Math.abs(a.y - b.y) >= 52).toBe(true);
});

test('stackTurns：轮次居中堆叠；给最后一个轮次加高不改变前面轮次的任何坐标', () => {
  const t1: TurnLayout = { key: 't1', width: 300, height: 100, positions: { a: { x: 0, y: 0 }, b: { x: 60, y: 48 } } };
  const t2: TurnLayout = { key: 't2', width: 500, height: 80, positions: { c: { x: 130, y: 0 } } };
  const s = stackTurns([t1, t2]);
  expect(s.turnBoxes.t1).toEqual({ x: -150, y: 0, width: 300, height: TURN_HEADER + 100 });
  expect(s.positions.a).toEqual({ x: -150, y: TURN_HEADER });
  expect(s.turnBoxes.t2!.y).toBe(TURN_HEADER + 100 + TURN_GAP);
  expect(s.positions.c).toEqual({ x: -250 + 130, y: TURN_HEADER + 100 + TURN_GAP + TURN_HEADER });
  const s2 = stackTurns([t1, { ...t2, height: 400, width: 900, positions: { c: { x: 330, y: 0 }, d: { x: 0, y: 300 } } }]);
  expect(s2.positions.a).toEqual(s.positions.a);
  expect(s2.positions.b).toEqual(s.positions.b);
  expect(s2.turnBoxes.t1).toEqual(s.turnBoxes.t1);
});

test('turnInput 只带本轮次内部的边；turnSignature 随节点或边变化', () => {
  const v = buildView(twoTurnsLinked(), new Map());
  const input = turnInput(v, v.turns[0]!);
  expect(input.edges.every((e) => input.nodes.some((x) => x.id === e.from) && input.nodes.some((x) => x.id === e.to))).toBe(true);
  expect(turnSignature(input)).toBe(turnSignature(turnInput(v, v.turns[0]!)));
  expect(turnSignature({ ...input, nodes: [...input.nodes, n('z')] })).not.toBe(turnSignature(input));
});
```

`canvas-layout-client.test.ts`（用手写的假 Worker：记录收到的请求，由测试决定何时、以什么顺序应答）：

```ts
test('相同签名的请求只计算一次，之后走缓存', async () => { /* 两次 layout(input) → 假 Worker 只收到 1 条消息；应答后两者得到同一结果；第三次不再发消息 */ });
test('应答乱序到达时，各请求拿到各自的结果', async () => { /* 先发 A 再发 B，先答 B 再答 A */ });
test('Worker 报错：进行中的请求 reject，下一次请求新建 Worker 并成功', async () => { /* 触发 onerror */ });
test('应答带 error 字段时该请求 reject，且不写入缓存', async () => {});
test('dispose 后终止 Worker，未完成的请求 reject', async () => {});
```

- [ ] **Step 2: 安装依赖并运行，确认失败**（`npx --yes pnpm@10 --filter @agent-canvas/web add @xyflow/react elkjs`）
- [ ] **Step 3: 实现 `sizes.ts`、`layout.ts`、`layout.worker.ts`、`layoutClient.ts`**
- [ ] **Step 4: 运行，确认通过。**
- [ ] **Step 5: 核对 CSP。** `npx --yes pnpm@10 build` 后在 `packages/web/dist/assets` 里确认 Worker 是独立的 `.js` 文件；在产物里搜索 `new Function(` 和 `eval(`，把命中情况写进报告。若 elkjs 的产物在不带 `unsafe-eval` 的页面里无法运行（Task 7 的浏览器检查会最终确认），**不得**改 CSP：改用 `@dagrejs/dagre` 实现同一个 `layoutTurn` 签名（同步计算包成 Promise，仍在 Worker 里），测试不变。
- [ ] **Step 6: 全量测试、类型检查、构建通过后提交**（`feat(web): per-turn elk layout in a worker with caching`）

---

### Task 4: 画布组件与会话页

**Files:**
- Create: `packages/web/src/canvas/useCanvas.ts`、`Canvas.tsx`、`nodes.tsx`、`canvas.css`
- Modify: `packages/web/src/pages/Session.tsx`、`packages/web/src/styles.css`
- Modify: `packages/web/src/client.ts`、`packages/web/test/client.test.ts`（删除不再使用的 `orderNodes` 及其测试）
- Test: `packages/web/test/canvas-use-canvas.test.ts`（只测下面的 `createCanvasModel`，不测 hook 和组件）

**Interfaces:**
- Consumes: `LiveSession`（`client.ts`）、`buildView`、`turnInput`、`stackTurns`、`LayoutClient`、`sizeOf`、`formatDuration`、`NODE_STATUS_LABEL`。
- Produces:

```ts
// useCanvas.ts
export interface CanvasSnapshot {
  view: CanvasView;
  positions: Record<string, { x: number; y: number }>;   // 只含已算出位置的视图节点
  turnBoxes: Record<string, Box>;
  layoutError: string | null;
}
export interface CanvasModel {
  getSnapshot(): CanvasSnapshot;
  subscribe(fn: () => void): () => void;
  toggleTurn(turnKey: string): void;      // 把该轮次当前的展开/折叠取反并记为覆盖项
  dispose(): void;
}
/** 不依赖 React。live 每次通知后重建视图（createThrottle，间隔 50 ms），对每个轮次请求布局，全部返回后一次性换上新位置。 */
export function createCanvasModel(live: Pick<LiveSession, 'getGraph' | 'subscribe'>, layout: LayoutClient): CanvasModel;
export function useCanvas(live: LiveSession): CanvasSnapshot & { toggleTurn(turnKey: string): void };

// Canvas.tsx
export function Canvas(props: { snapshot: CanvasSnapshot; selectedId: string | null; onSelect(id: string | null): void; onToggleTurn(turnKey: string): void }): JSX.Element;
```

`createCanvasModel` 的行为：
- 每次重建给一个递增的代号；某次布局全部完成时，如果已有更新的代号**完成**，丢弃本次结果（新的不被旧的覆盖）。
- 新视图里已有位置的节点在新位置算出前保持旧位置；还没有位置的新节点不出现在 `positions` 里（组件不画它）。视图里已不存在的节点从 `positions` 删除。
- 任一轮次布局失败：保留上一次的位置，`layoutError` 记错误信息，下次重建重试。
- `toggleTurn` 立即触发重建（不等 50 ms）。

组件要求：
- `ReactFlow`：`nodesDraggable={false}`、`nodesConnectable={false}`、`elementsSelectable`、`onlyRenderVisibleElements`、`minZoom={0.05}`、`maxZoom={2}`、`proOptions={{ hideAttribution: false }}`；带 `Background`、`Controls`、`MiniMap`。
- 三种节点类型：
  - `graphNode`：第一行是类型标签（提示/思考/回复/工具/子代理/系统/未知）、`title`（工具名或代理类型）、状态文字（`NODE_STATUS_LABEL`）、耗时（`formatDuration`，无则不显示）；第二行是 `summary`，单行省略。`thinking` 只有一行："思考 · 3.4s"（无耗时则只有"思考"）。`subagent` 第三行："内部 N 个节点"。`confirmed === false` 时虚线边框并带"未确认"标签。
  - `turnSummary`：`promptSummary`（空则"（无提示）"）、"N 个节点 · M 次工具调用 · 耗时"，有失败时加"K 个失败"，`running` 时带运行中动效；点击 = 展开该轮次。
  - `turnHeader`：每个展开轮次的 box 顶部一行，显示开始时间和"折叠"按钮；位置取 `turnBoxes[key]` 的左上角。
- 状态色（边框和左侧色条）：running `#2563eb`、awaiting_permission `#d97706`、succeeded `#16a34a`、failed `#dc2626`、denied `#9f1239`；无状态的节点按类型：prompt `#7c3aed`、text `#475569`、thinking `#94a3b8`、system `#64748b`、unknown `#a16207`。
- 动效：running 和 awaiting_permission 的节点边框脉冲（1.2 秒周期）；`@media (prefers-reduced-motion: reduce)` 下关闭。指向执行中节点的边 `animated`。
- 边：`sequence` 灰色 `#94a3b8`；`fork` 靛色 `#6366f1`；类型 `smoothstep`。
- 选中的节点加粗描边。点击空白处取消选中。
- 会话页：顶部一条信息栏（返回项目、标题、状态、分支、"源文件已删除"），其下画布占满剩余视口高度；`layoutError` 非空时在画布上方显示一行"布局失败：…"。图为空时显示"暂无节点"。

- [ ] **Step 1: 写失败的测试**（`canvas-use-canvas.test.ts`：假的 `live`（可改图并通知）、假的 `LayoutClient`（由测试控制每次请求何时 resolve/reject），用 `vi.useFakeTimers()` 推进 50 ms）

```ts
test('首次布局完成后才有位置；所有视图节点都有位置', async () => {});
test('追加节点：新位置到达前旧节点位置不变，新节点暂不在 positions 里；到达后出现', async () => {});
test('旧的布局结果晚于新的到达时被丢弃', async () => { /* 第 1 次重建的请求挂起，第 2 次先完成，再放行第 1 次 → 快照仍是第 2 次的 */ });
test('布局失败：保留旧位置并记录 layoutError；下一次重建成功后 layoutError 清空', async () => {});
test('toggleTurn 立即重建并翻转该轮次的折叠状态；再调一次翻回来', async () => {});
test('图被整体替换（resync）后，已不存在的节点从 positions 中删除', async () => {});
test('dispose 后不再通知订阅者，也不再请求布局', async () => {});
```

- [ ] **Step 2: 运行，确认失败**
- [ ] **Step 3: 实现 `createCanvasModel`、`useCanvas`（`useSyncExternalStore`；`LayoutClient` 每个会话页一个，卸载时 `dispose`）**
- [ ] **Step 4: 实现 `nodes.tsx`、`Canvas.tsx`、`canvas.css`，改 `Session.tsx`；删除 `orderNodes`。** 本任务里选中节点只做高亮（`selectedId` 存在 `SessionPage` 的 state），抽屉在 Task 6。
- [ ] **Step 5: 全量测试、类型检查、构建通过后提交**（`feat(web): render the session as a canvas`）

---

### Task 5: 自动跟随

**Files:**
- Create: `packages/web/src/canvas/follow.ts`
- Modify: `packages/web/src/canvas/Canvas.tsx`、`canvas.css`
- Test: `packages/web/test/canvas-follow.test.ts`

**Interfaces:**
- Produces:

```ts
/** 最新节点的中心点；该节点还没有位置时返回 null。 */
export function followTarget(snapshot: Pick<CanvasSnapshot, 'view' | 'positions'>): { x: number; y: number } | null;
```

行为：
- 跟随默认开启。开启时，每当 `followTarget` 的结果变化，用 `setCenter(x, y, { zoom: 当前缩放, duration: 200 })` 把最新节点移到视口中央偏下（目标点 y 减去视口高度的 15% 换算成画布坐标）。首次定位不带动画，缩放 1。
- 使用者平移或缩放（`onMoveStart` 的事件参数非空，即由用户触发）即停止跟随；程序触发的移动不算。
- 停止跟随后右下角出现"回到最新"按钮；点击后恢复跟随并立即定位。跟随中不显示该按钮。
- 切换会话时恢复为跟随。

- [ ] **Step 1: 写失败的测试**

```ts
test('返回最新节点的中心', () => {
  // 最新节点 y5 是 tool（240×52），位置 (100, 400)
  expect(followTarget({ view, positions: { y5: { x: 100, y: 400 } } })).toEqual({ x: 220, y: 426 });
});
test('最新节点在折叠轮次里时取摘要节点的中心（340×60）', () => {
  expect(followTarget({ view: collapsedLast, positions: { 'turn:t5': { x: 0, y: 0 } } })).toEqual({ x: 170, y: 30 });
});
test('最新节点尚无位置或图为空时返回 null', () => {
  expect(followTarget({ view, positions: {} })).toBeNull();
  expect(followTarget({ view: buildView(emptyGraph(), new Map()), positions: {} })).toBeNull();
});
```

- [ ] **Step 2: 运行，确认失败**
- [ ] **Step 3: 实现 `followTarget`，在 `Canvas.tsx` 里接上跟随状态与"回到最新"按钮**
- [ ] **Step 4: 全量测试、类型检查、构建通过后提交**（`feat(web): follow the latest node until the user moves the canvas`）

---

### Task 6: 节点详情抽屉

**Files:**
- Create: `packages/web/src/canvas/Drawer.tsx`
- Modify: `packages/web/src/pages/Session.tsx`、`canvas.css`
- Test: `packages/web/test/canvas-drawer.test.ts`（只测 `detailSections`）

**Interfaces:**
- Consumes: `api.nodeDetail`、`NodeDetail`、`GraphNode`。
- Produces:

```ts
export const DETAIL_MAX_CHARS = 200_000;
export interface DetailSection { label: '文本' | '入参' | '输出' | '原始记录'; body: string; truncated: boolean }
/** 只返回有内容的段，顺序：文本、入参、输出、原始记录。字符串原样显示，其余 JSON.stringify(v, null, 2)；每段最多 DETAIL_MAX_CHARS 字符。 */
export function detailSections(detail: NodeDetail): DetailSection[];
export function Drawer(props: { sessionId: string; node: GraphNode; onClose(): void }): JSX.Element;
```

行为：
- 点击 `graphNode` 打开抽屉（宽 440 px，右侧，覆盖在画布之上，不改变画布尺寸）；点击摘要节点、轮次标题不打开。
- 头部：类型标签、标题、状态、时间、耗时、token 用量（"输入 N · 输出 M"，无则不显示）、"未确认"标签；右上角关闭按钮。`Esc` 关闭。
- 正文：`detailSections` 的各段，`<pre>` 显示，可滚动、自动换行；`truncated` 时在段末显示"（已截断，仅显示前 200000 个字符）"。"原始记录"段默认收起（`<details>`）。
- 加载中显示"加载中…"；失败显示"详情加载失败：…"；节点收到更新时重新取详情，刷新期间保留旧内容，刷新失败在顶部显示"详情刷新失败：…"。
- 选中的节点从图里消失（resync 后不存在）时关闭抽屉。

- [ ] **Step 1: 写失败的测试**

```ts
test('只返回有内容的段，顺序固定', () => {
  expect(detailSections({ nodeId: 'n', input: { a: 1 }, output: 'ok', text: null, raw: null }).map((s) => s.label)).toEqual(['入参', '输出']);
});
test('字符串原样，对象缩进两格', () => {
  const [i, o] = detailSections({ nodeId: 'n', input: { a: 1 }, output: 'line1\nline2', text: null, raw: null });
  expect(i!.body).toBe('{\n  "a": 1\n}');
  expect(o!.body).toBe('line1\nline2');
});
test('超长内容截断并标记', () => {
  const [t] = detailSections({ nodeId: 'n', input: null, output: null, text: 'x'.repeat(DETAIL_MAX_CHARS + 5), raw: null });
  expect(t).toMatchObject({ truncated: true });
  expect(t!.body.length).toBe(DETAIL_MAX_CHARS);
});
test('空字符串、null、undefined 都算没有内容', () => {
  expect(detailSections({ nodeId: 'n', input: undefined, output: '', text: null, raw: null })).toEqual([]);
});
```

- [ ] **Step 2: 运行，确认失败**
- [ ] **Step 3: 实现 `detailSections`、`Drawer`，接入 `Session.tsx`**
- [ ] **Step 4: 全量测试、类型检查、构建通过后提交**（`feat(web): node detail drawer`）

---

### Task 7: 文档与浏览器验收

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新 README。** 第 4 行改为：当前提供实时画布（里程碑 2）；新增一节"画布"，写明：自上而下自动布局；默认展开最近 3 个轮次，更早的折叠成摘要节点，点击展开，轮次标题上可折叠；自动跟随最新节点，手动平移或缩放后停止，点"回到最新"恢复；点击节点在右侧看完整内容；子代理目前显示为单个节点，展开在后续里程碑。"已知限制"里删去与列表相关的说法。
- [ ] **Step 2: 用合成数据在浏览器里核对。** 临时目录起服务（两个环境变量 + `--port 4399`），写入一个合成会话：5 个轮次；其中一轮含一条助手消息里的 3 个并行工具；一个子代理（含内部节点）；一个失败的工具；节点摘要含超长无空格字符串和中文。逐项核对并在报告里逐条写结果：
  1. 页面无 CSP 报错、无控制台错误，布局 Worker 正常返回（Task 3 Step 5 的 CSP 结论在此最终确认）。
  2. 前 2 个轮次是摘要节点，后 3 个展开；点击摘要节点展开，点"折叠"收回。
  3. 3 个并行工具同层排开，分叉边为靛色。
  4. 子代理是一个节点并显示内部节点数；内部节点不在画布上。
  5. 超长文字不撑大节点，单行省略。
  6. 向 transcript 追加一条"执行中"的工具：节点出现、带脉冲动效、视口跟随；之前轮次的节点位置不变。再追加结果：节点变绿。
  7. 手动拖动画布后再追加节点：视口不动，出现"回到最新"；点击后回到最新节点。
  8. 用 hook 发送 `PermissionRequest`：对应节点变为"等待权限确认"（琥珀色脉冲）。
  9. 点击工具节点：抽屉显示入参和输出；`Esc` 关闭。
- [ ] **Step 3: 在真实数据上测量。** 由控制者在使用者已同意的真实数据服务上进行，只看结构和耗时、不看内容：打开节点最多的会话，记录从进入页面到画布出现的时间（目标 ≤ 2 秒）；展开节点最多的轮次，记录布局耗时并确认期间页面可交互；平移缩放无明显卡顿。结果写进报告和 README 的"画布"一节（一句话）。
- [ ] **Step 4: 全量测试、类型检查、构建通过后提交**（`docs: describe the canvas`）
