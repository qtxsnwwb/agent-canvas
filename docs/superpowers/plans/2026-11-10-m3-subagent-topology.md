# agent-canvas 里程碑 3（子代理拓扑）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 子代理节点可以展开成容器，在容器里看到它内部的节点（可嵌套）；会话页顶部出现视角切换，新增"拓扑"视角：只留提示、工具、子代理和它们之间的派发、并行关系与状态。

**Architecture:** 在里程碑 2 的三层上扩展，不新增层。`buildView` 多接收"展开了哪些子代理"和"视角"，输出里多一组"代理分组"（每个展开的子代理一组，内含它的内部节点）。布局自底向上：先算最深的代理分组，容器节点的尺寸取"内部布局尺寸 + 内边距 + 标题区"，再算包含它的分组或轮次；内部节点的绝对坐标 = 容器坐标 + 偏移，因此 React Flow 里所有节点仍是平铺的，容器只是一个画在下层的大节点。

**Tech Stack:** 无新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-10-agent-canvas-design.md`（7.2 "子代理是可展开的容器节点"、7.3 的"拓扑"一行、12 节第 3 项）

**范围说明：** 只做里程碑 3。因果视角（里程碑 4）、复盘（里程碑 5）不在内；视角切换栏本里程碑只有"实时""拓扑"两项。

## Global Constraints

- 里程碑 2 计划的 Global Constraints 全部继续适用（CSP 不放宽、不新增服务端接口、不改 `packages/server`、文案简体中文、测试只测纯逻辑且不碰真实用户目录、节点尺寸固定且不可拖动、`npx --yes pnpm@10`、提交信息格式）。
- 子代理默认折叠（规格第 13 节）；展开状态只存在页面内存里，切换会话即清空。
- 展开或折叠一个子代理，不得改变它所在轮次**之前**各轮次的任何坐标。

## Review Focus

1. **嵌套与环。** 子代理里再派子代理（多层）；数据异常导致 `childAgentId` 指回祖先。期望：多层正常嵌套；出现环时该节点按未展开处理，不死循环。（测试在 Task 1）
2. **子代理内部节点很多。** 真实数据里单个会话有 5000 多个子代理内部节点。期望：未展开的子代理不产生任何内部视图节点，也不为它请求布局。（测试在 Task 1、Task 2）
3. **容器尺寸变化引起的重排。** 正在运行的子代理展开时内部不断长高。期望：只有它所在的分组/轮次及其后的轮次下移，之前的不动；跟随关闭时视口不动。（测试在 Task 2）
4. **拓扑视角隐藏节点后的断链。** 隐藏思考和文本后，原本经由它们相连的工具必须仍然连着，且并行分叉仍是分叉。期望：隐藏节点被"缩并"，边接到最近的可见上游。（测试在 Task 1）
5. **派发关系还没到齐。** 子代理节点已出现但 `childAgentId` 还为空，或内部节点一个都还没到。期望：展开按钮不出现（或展开后显示"暂无内部节点"），不抛异常。（测试在 Task 1）

---

### Task 1: 视图：展开的子代理与拓扑视角

**Files:**
- Modify: `packages/web/src/canvas/view.ts`
- Test: `packages/web/test/canvas-view.test.ts`（原有用例随签名调整）、新增 `packages/web/test/canvas-view-agents.test.ts`

**Interfaces:**
- Produces（替换里程碑 2 的 `buildView` 签名；其余导出不变）：

```ts
export type ViewMode = 'live' | 'topology';
export interface ViewOptions {
  overrides: ReadonlyMap<string, boolean>;      // 轮次展开/折叠覆盖，含义同前
  expandedAgents: ReadonlySet<string>;          // 展开的子代理的 agent id（即派发节点的 childAgentId）
  mode: ViewMode;
}
export function agentGroupKey(agentId: string): string;   // `agent:${agentId}`

// ViewNode 的 'node' 分支增加三个字段：
//   groupKey: string    所在布局分组：主线节点是它的轮次键；代理内部节点是 agentGroupKey(它的 agentId)
//   expanded: boolean   仅 subagent 节点可能为 true：它作为容器展开了
//   expandable: boolean 仅 subagent 节点可能为 true：childAgentId 非空且 innerCount > 0
// 'turn_summary' 分支增加 groupKey（= 轮次键）。

export interface AgentGroup {
  key: string;            // agentGroupKey(agentId)
  agentId: string;
  containerId: string;    // 派发节点的视图节点 id
  parentGroupKey: string; // 容器节点所在的分组
  depth: number;          // 主线上的子代理为 1，其内部再派发的为 2 …
  nodeIds: string[];      // 内部视图节点，按 timestamp 升序、相同按 id
}
// CanvasView 增加：
//   agentGroups: AgentGroup[]   // 按 depth 降序（最深的在前），相同按 key
//   mode: ViewMode
export function buildView(graph: Graph, opts: ViewOptions): CanvasView;
```

规则（在里程碑 2 的六条之上）：

7. 一个 `subagent` 节点"展开"当且仅当：`mode === 'live'`、它本身在视图里（所在轮次未折叠、所在的上层代理已展开）、`expandable`、`childAgentId ∈ expandedAgents`，且该 agent id 不在它自己的祖先链上（防环）。展开时，`agentId === childAgentId` 的全部节点进入视图，`groupKey = agentGroupKey(childAgentId)`，`turnKey` 取容器节点的 `turnKey`。
8. 代理分组内的边：两端都在同一分组内的边保留，规则同主线（去重、id 为 `from->to`）。派发边（`spawn`）一律不进视图：容器已表达该关系。两端在不同分组的其他边丢弃。
9. `innerCount` 的定义不变（直接内部节点数）。
10. `mode === 'topology'`：`expandedAgents` 被忽略（全部折叠）；`thinking` 和 `text` 节点不进视图；对每条被隐藏节点串起来的路径做缩并——可见节点 B 的上游是"沿边逆向走、穿过隐藏节点、遇到的第一批可见节点"，对每个这样的 A 产生一条边 `A->B`，kind 取进入 B 的那条原始边的 kind（去重同前）。轮次折叠规则不变；`TurnSummary` 的各项统计仍按该轮次全部主线节点计算，与视角无关。
11. `latestNodeId` 的定义不变（主线上时间最晚的节点）；在拓扑视角下若该节点被隐藏，取时间上不晚于它的最晚一个可见主线节点。

- [ ] **Step 1: 调整原有测试到新签名**（`buildView(g, new Map())` → `buildView(g, { overrides: new Map(), expandedAgents: new Set(), mode: 'live' })`，可在测试文件里包一个 `live(g, overrides?)` 小函数），确认原有用例仍然通过的前提是实现完成，此时先看到编译失败。
- [ ] **Step 2: 写失败的测试**（`canvas-view-agents.test.ts`）

```ts
const opts = (o: Partial<ViewOptions> = {}): ViewOptions => ({ overrides: new Map(), expandedAgents: new Set(), mode: 'live', ...o });

test('未展开的子代理不产生内部视图节点，也没有代理分组', () => {
  const v = buildView(mainWithAgent(), opts());            // 主线 p1 → s1(childAgentId a1)；a1 内部 i1 → i2 → i3
  expect([...v.nodes.keys()]).toEqual(['p1', 's1']);
  expect(v.agentGroups).toEqual([]);
  expect(v.nodes.get('s1')).toMatchObject({ expanded: false, expandable: true, innerCount: 3, groupKey: 't1' });
});

test('展开后内部节点进入视图，归入代理分组，带内部的边，不带派发边', () => {
  const v = buildView(mainWithAgent(), opts({ expandedAgents: new Set(['a1']) }));
  expect(v.agentGroups).toEqual([{ key: 'agent:a1', agentId: 'a1', containerId: 's1', parentGroupKey: 't1', depth: 1, nodeIds: ['i1', 'i2', 'i3'] }]);
  expect(v.nodes.get('i2')).toMatchObject({ groupKey: 'agent:a1', turnKey: 't1' });
  expect(v.nodes.get('s1')).toMatchObject({ expanded: true });
  expect(v.edges.map((e) => e.id).sort()).toEqual(['i1->i2', 'i2->i3', 'p1->s1']);
});

test('嵌套：内层只有在外层展开时才展开；分组按深度降序', () => {
  const g = nestedAgents();                                 // s1(a1) 内部有 s2(a2)，a2 内部有 j1
  expect(buildView(g, opts({ expandedAgents: new Set(['a2']) })).agentGroups).toEqual([]);
  const v = buildView(g, opts({ expandedAgents: new Set(['a1', 'a2']) }));
  expect(v.agentGroups.map((x) => [x.key, x.depth, x.parentGroupKey])).toEqual([['agent:a2', 2, 'agent:a1'], ['agent:a1', 1, 't1']]);
});

test('环：childAgentId 指回祖先时按未展开处理', () => {
  const v = buildView(cyclicAgents(), opts({ expandedAgents: new Set(['a1']) }));   // a1 内部的 s2 的 childAgentId 也是 a1
  expect(v.nodes.get('s2')).toMatchObject({ expanded: false });
  expect(v.agentGroups).toHaveLength(1);
});

test('容器所在轮次折叠时，展开状态不产生任何内部节点', () => {
  const v = buildView(mainWithAgent(), opts({ expandedAgents: new Set(['a1']), overrides: new Map([['t1', false]]) }));
  expect([...v.nodes.keys()]).toEqual(['turn:t1']);
  expect(v.agentGroups).toEqual([]);
});

test('childAgentId 为空或没有内部节点的子代理不可展开', () => {
  const v = buildView(agentWithoutInner(), opts({ expandedAgents: new Set(['a1']) }));
  expect(v.nodes.get('s1')).toMatchObject({ expandable: false, expanded: false });
});

test('拓扑视角：隐藏思考和文本，缩并后链路不断，分叉保留', () => {
  // 主线：p1 → th1 → tx1 → {b1, b2}（fork）→ th2 → c1；s1 在 c1 之后
  const v = buildView(topologyFixture(), opts({ mode: 'topology', expandedAgents: new Set(['a1']) }));
  expect([...v.nodes.keys()]).toEqual(['p1', 'b1', 'b2', 'c1', 's1']);
  expect(v.edges.map((e) => [e.id, e.kind]).sort()).toEqual([
    ['b1->c1', 'sequence'], ['b2->c1', 'sequence'], ['c1->s1', 'sequence'], ['p1->b1', 'fork'], ['p1->b2', 'fork'],
  ]);
  expect(v.agentGroups).toEqual([]);
  expect(v.mode).toBe('topology');
});

test('拓扑视角：最新节点被隐藏时，latestNodeId 取它之前最晚的可见节点', () => {
  const v = buildView(endsWithText(), opts({ mode: 'topology' }));   // … → c1 → tx9（最晚）
  expect(v.latestNodeId).toBe('c1');
});
```

- [ ] **Step 3: 运行，确认失败**
- [ ] **Step 4: 实现**
- [ ] **Step 5: 全量测试、类型检查、构建通过后提交**（`feat(web): expandable subagent groups and a topology mode in the view model`）。本任务结束时 `useCanvas.ts` 等调用点用 `{ overrides, expandedAgents: new Set(), mode: 'live' }` 调用，界面行为与里程碑 2 相同。

---

### Task 2: 布局：嵌套分组

**Files:**
- Modify: `packages/web/src/canvas/sizes.ts`、`layout.ts`、`useCanvas.ts`
- Test: `packages/web/test/canvas-layout.test.ts`、`packages/web/test/canvas-use-canvas.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `AgentGroup`、`groupKey`、`expanded`。
- Produces:

```ts
// sizes.ts
export const CONTAINER_PADDING = 16;      // 容器四周内边距
export const CONTAINER_HEADER = 68;       // 容器顶部标题区高度（= 折叠时 subagent 节点的高度）
export const CONTAINER_MIN_WIDTH = 260;
/** 展开的容器尺寸：宽 = max(CONTAINER_MIN_WIDTH, inner.width + 2*PADDING)，高 = HEADER + inner.height + 2*PADDING。 */
export function containerSize(inner: { width: number; height: number }): { width: number; height: number };

// layout.ts
/** 任一分组（轮次或代理分组）的布局输入。sizes：已展开容器的尺寸（按视图节点 id）；未给出的节点用 sizeOf。 */
export function groupInput(view: CanvasView, groupKey: string, nodeIds: string[], sizes: ReadonlyMap<string, { width: number; height: number }>): TurnLayoutInput;
/**
 * 在 stackTurns 的结果上放入代理分组：内部节点绝对坐标 = 容器绝对坐标 + (PADDING, HEADER + PADDING) + 内部相对坐标。
 * groups 必须按 depth 升序传入（先外层后内层）。返回新的 positions（含内部节点）和各容器的 Box。
 */
export function placeAgentGroups(
  base: { positions: Record<string, { x: number; y: number }> },
  groups: { group: AgentGroup; layout: TurnLayout }[],
): { positions: Record<string, { x: number; y: number }>; containerBoxes: Record<string, Box> };

// useCanvas.ts —— CanvasSnapshot 增加 containerBoxes: Record<string, Box>；CanvasModel 增加：
//   toggleAgent(agentId: string): void
//   setMode(mode: ViewMode): void
//   getMode(): ViewMode
```

里程碑 2 的 `turnInput(view, turn)` 保留为 `groupInput(view, turn.key, turn.nodeIds, sizes)` 的薄包装（或删除并更新调用点，二选一，测试同步）。

`createCanvasModel` 的布局顺序：按 `view.agentGroups`（最深在前）依次请求布局，每完成一个，用 `containerSize` 算出其容器尺寸并记入 `sizes`；全部代理分组完成后再请求各轮次。代号与"旧结果不覆盖新结果"的规则不变。`setMode`、`toggleAgent` 立即触发重建。

- [ ] **Step 1: 写失败的测试**

```ts
test('containerSize：加内边距和标题区，宽度有下限', () => {
  expect(containerSize({ width: 500, height: 300 })).toEqual({ width: 532, height: 400 });
  expect(containerSize({ width: 100, height: 40 })).toEqual({ width: 260, height: 140 });
});

test('groupInput 对展开的容器使用给定尺寸，其余用 sizeOf；只带分组内部的边', () => {
  const v = buildView(mainWithAgent(), opts({ expandedAgents: new Set(['a1']) }));
  const input = groupInput(v, 't1', v.turns[0]!.nodeIds, new Map([['s1', { width: 532, height: 400 }]]));
  expect(input.nodes).toEqual([{ id: 'p1', width: 280, height: 64 }, { id: 's1', width: 532, height: 400 }]);
  expect(input.edges).toEqual([{ id: 'p1->s1', from: 'p1', to: 's1' }]);
});

test('placeAgentGroups：内部节点坐标 = 容器坐标 + 偏移；嵌套逐层累加', () => {
  const base = { positions: { s1: { x: 100, y: 200 } } };
  const outer = { group: g('agent:a1', 's1', 1, ['i1', 's2']), layout: { key: 'agent:a1', width: 300, height: 200, positions: { i1: { x: 0, y: 0 }, s2: { x: 10, y: 80 } } } };
  const inner = { group: g('agent:a2', 's2', 2, ['j1']), layout: { key: 'agent:a2', width: 240, height: 52, positions: { j1: { x: 0, y: 0 } } } };
  const r = placeAgentGroups(base, [outer, inner]);
  expect(r.positions.i1).toEqual({ x: 116, y: 284 });
  expect(r.positions.s2).toEqual({ x: 126, y: 364 });
  expect(r.positions.j1).toEqual({ x: 142, y: 448 });
  expect(r.containerBoxes.s1).toEqual({ x: 100, y: 200, width: 332, height: 300 });
});
```

`canvas-use-canvas.test.ts` 新增：

```ts
test('先布局最深的代理分组，再布局包含它的分组，最后布局轮次；容器尺寸传给上层', async () => { /* 检查假 LayoutClient 收到请求的顺序，以及上层输入里容器节点的 width/height */ });
test('未展开的子代理不产生布局请求', async () => {});
test('toggleAgent 展开后内部节点获得位置；再次调用折叠后内部节点从 positions 中消失', async () => {});
test('展开一个子代理不改变它之前各轮次的坐标', async () => {});
test('setMode("topology") 立即重建；getMode 反映当前视角', async () => {});
```

- [ ] **Step 2: 运行，确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 全量测试、类型检查、构建通过后提交**（`feat(web): bottom-up layout for nested subagent groups`）

---

### Task 3: 容器节点、展开按钮、视角切换

**Files:**
- Modify: `packages/web/src/canvas/nodes.tsx`、`Canvas.tsx`、`canvas.css`、`packages/web/src/pages/Session.tsx`

**Interfaces:**
- Consumes: `CanvasSnapshot.containerBoxes`、`toggleAgent`、`setMode`、`getMode`、`ViewMode`。
- Produces: `Canvas` 的 props 增加 `onToggleAgent(agentId: string): void`；`SessionPage` 持有视角状态并传给 model。

行为：
- `subagent` 节点：`expandable` 时右上角有"展开"按钮；展开后节点变成容器——尺寸取 `containerBoxes[id]`，顶部 68 px 标题区内容与折叠时相同，按钮变为"收起"，下方区域为浅色底、同状态色的细边框；容器的 `zIndex` 低于内部节点（按 depth 递增），内部节点可点击、可打开抽屉。点击按钮不触发节点选中。
- 不可展开的子代理（`expandable === false`）不显示按钮；`innerCount === 0` 时第三行显示"暂无内部节点"。
- 会话页信息栏右侧是视角切换（两个按钮组成的分段控件：`实时`、`拓扑`，当前项高亮，`aria-pressed`）。切到拓扑时"展开"按钮不出现；切回实时时之前展开的子代理恢复展开（`expandedAgents` 不清空）。
- 切换视角后，如果抽屉里选中的节点在新视角里不可见，关闭抽屉。
- 跟随：两个视角都跟随 `latestNodeId`；切换视角时恢复跟随。
- MiniMap 中容器节点用半透明色，避免遮住内部节点。

- [ ] **Step 1: 实现**
- [ ] **Step 2: 全量测试、类型检查、构建通过后提交**（`feat(web): subagent containers and the topology view switch`）

---

### Task 4: 文档与浏览器验收

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新 README 的"画布"一节**：子代理可展开为容器（可嵌套），默认折叠；视角切换"实时 / 拓扑"及拓扑视角显示什么。删去"子代理目前显示为单个节点"。
- [ ] **Step 2: 用合成数据在浏览器里核对**（临时目录、`--port 4399`；合成会话含：一个有 6 个内部节点的子代理、一个两层嵌套的子代理、一个正在运行的子代理、若干思考和文本节点、一组并行工具），逐条写结果：
  1. 子代理默认折叠；点"展开"变为容器，内部节点在容器内自上而下排列；点"收起"恢复。
  2. 两层嵌套：外层展开后内层才出现展开按钮；内层容器画在外层容器之内，不溢出。
  3. 展开/收起时，之前轮次的节点位置不变；跟随关闭时视口不动。
  4. 向正在运行、已展开的子代理追加内部节点：容器长高，其后的节点下移。
  5. 点击容器内的节点：抽屉显示它的内容。
  6. 切到"拓扑"：思考和文本消失，工具之间的连线不断，并行分叉仍在，子代理全部是单节点且无展开按钮；切回"实时"：之前展开的仍展开。
  7. 无控制台错误、无 CSP 报错。
- [ ] **Step 3: 在真实数据上测量**（由控制者进行，只看结构和耗时）：在节点最多的会话里展开内部节点最多的子代理，记录布局耗时并确认页面可交互；切换到拓扑视角的耗时。写进报告。
- [ ] **Step 4: 全量测试、类型检查、构建通过后提交**（`docs: describe subagent containers and the topology view`）
