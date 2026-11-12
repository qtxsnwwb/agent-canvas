# agent-canvas 里程碑 4（因果视角）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增"因果"视角：思考节点展开显示内容；选中一个节点时，高亮它上游一直到本轮提示的整条链，并在抽屉里按顺序列出链上的思考和回复，回答"它为什么做这一步"。

**Architecture:** 视角枚举加一项 `causal`；节点集合与"实时"相同，只是思考节点用大尺寸。新增纯函数 `upstreamChain`：从选中节点沿视图里的边逆向走，遇到提示节点停止；走到子代理内部的起点时接到它的容器节点继续向上。组件层只做高亮和列表。

**Tech Stack:** 无新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-10-agent-canvas-design.md`（7.3 的"因果"一行、12 节第 4 项、13 节关于思考文本的风险）

**已核实的数据事实（2026-11-10，本机真实数据，只统计结构）：** 6352 个思考节点里只有 217 个（约 3%）带文本，6350 个带耗时。Claude Code 的 transcript 多数情况下不保存思考原文，这不是本项目能补回的。因此因果链以"回复文本 + 思考耗时"为主，思考原文有则显示。

## Global Constraints

- 里程碑 2、3 计划的 Global Constraints 全部继续适用。
- 不得为了"让思考有内容"而编造或推断文本：没有原文的思考节点显示固定文案 `思考内容未记录`。
- 高亮只改样式，不得触发重新布局。

## Review Focus

1. **链很长或有环。** 一个轮次可达数百个节点；数据异常可能出现环。期望：每个节点最多访问一次，不死循环；数百节点的链计算在一次交互内完成（线性复杂度）。（测试在 Task 1）
2. **链穿过折叠的部分。** 上游在折叠的轮次里，或选中节点在子代理容器内部。期望：遇到轮次摘要节点时把它算进链并停止；容器内部的链接到容器节点后继续向上。（测试在 Task 1）
3. **选中的节点随后消失。** 实时更新、切换视角、折叠轮次都可能让选中节点不在视图里。期望：高亮清空，不报错。（测试在 Task 1）
4. **绝大多数思考节点没有文本。** 期望：节点和抽屉都显示固定文案和耗时，不出现空白块。（实现在 Task 2；浏览器核对在 Task 3）
5. **并行分叉的上游。** 选中汇合点之后的节点时，分叉的每个分支都是上游。期望：所有分支都高亮。（测试在 Task 1）

---

### Task 1: 视图：因果视角与上游链

**Files:**
- Modify: `packages/web/src/canvas/view.ts`、`sizes.ts`、`layout.ts`
- Create: `packages/web/src/canvas/chain.ts`
- Test: `packages/web/test/canvas-chain.test.ts`、`packages/web/test/canvas-view-agents.test.ts`、`packages/web/test/canvas-layout.test.ts`

**Interfaces:**
- Produces:

```ts
// view.ts
export type ViewMode = 'live' | 'topology' | 'causal';
// causal：节点集合、分组、边与 live 完全相同（expandedAgents 生效）；只有 view.mode 不同。

// sizes.ts —— 第二个参数默认 'live'；mode 为 'causal' 时 thinking 为 280×56，其余不变
export function sizeOf(v: ViewNode, mode?: ViewMode): { width: number; height: number };
// layout.ts 的 groupInput 用 view.mode 调 sizeOf。

// chain.ts
export interface UpstreamChain {
  nodeIds: ReadonlySet<string>;   // 含起点
  edgeIds: ReadonlySet<string>;   // 链上走过的边
  reasoning: string[];            // 链上 kind 为 thinking 或 text 的节点 id，按 timestamp 升序、相同按 id
}
export const EMPTY_CHAIN: UpstreamChain;
/** nodeId 为 null 或不在视图里时返回 EMPTY_CHAIN。 */
export function upstreamChain(view: CanvasView, nodeId: string | null): UpstreamChain;
```

`upstreamChain` 的规则：

1. 从起点出发，沿 `view.edges` 逆向（由 `to` 找 `from`）做广度优先遍历，每个节点最多访问一次；走过的边记入 `edgeIds`。
2. 到达 `prompt` 节点：记入链，不再从它继续向上。到达 `turn_summary` 节点：记入链，不再继续。
3. 到达一个在代理分组里且没有任何入边的节点（该分组的起点）：把该分组的容器节点（`AgentGroup.containerId`）记入链，并从容器节点继续向上。这一步不产生边 id。
4. 起点本身是 `prompt` 或 `turn_summary` 时，链只有它自己。
5. `reasoning` 只收 `type === 'node'` 且 kind 为 `thinking` 或 `text` 的节点。

- [ ] **Step 1: 写失败的测试**（`canvas-chain.test.ts`，沿用已有测试文件里的图工厂和 `opts()`）

```ts
test('沿边逆向走到本轮提示为止，不越过提示', () => {
  // t1: p1 → th1 → tx1 → a1；t2: p2 → th2 → b2；a1 → p2
  const v = buildView(twoTurnChain(), opts({ mode: 'causal' }));
  const c = upstreamChain(v, 'b2');
  expect([...c.nodeIds].sort()).toEqual(['b2', 'p2', 'th2']);
  expect([...c.edgeIds].sort()).toEqual(['p2->th2', 'th2->b2']);
  expect(c.reasoning).toEqual(['th2']);
});

test('并行分叉：汇合点之后的节点，上游包含每个分支', () => {
  // p1 → tx1 → {b1, b2} → c1
  const c = upstreamChain(buildView(forkJoin(), opts({ mode: 'causal' })), 'c1');
  expect([...c.nodeIds].sort()).toEqual(['b1', 'b2', 'c1', 'p1', 'tx1']);
  expect(c.reasoning).toEqual(['tx1']);
});

test('上游是折叠的轮次：摘要节点算进链并停止', () => {
  // 没有 turnId 的节点落在某个展开的轮次里，其上游边来自一个被折叠的轮次
  const v = buildView(chainIntoCollapsedTurn(), opts({ mode: 'causal' }));
  const c = upstreamChain(v, 'x9');
  expect(c.nodeIds.has('turn:t1')).toBe(true);
  expect([...c.nodeIds].every((id) => id === 'turn:t1' || !id.startsWith('turn:'))).toBe(true);
});

test('子代理内部：走到内部起点后接到容器节点，再向上到提示', () => {
  // 主线 p1 → tx1 → s1(a1)；a1 内部 i1 → ith → i2
  const v = buildView(mainWithAgentReasoning(), opts({ mode: 'causal', expandedAgents: new Set(['a1']) }));
  const c = upstreamChain(v, 'i2');
  expect([...c.nodeIds].sort()).toEqual(['i1', 'i2', 'ith', 'p1', 's1', 'tx1']);
  expect(c.reasoning).toEqual(['tx1', 'ith']);
});

test('有环的边不会死循环，每个节点只出现一次', () => {
  const c = upstreamChain(buildView(cyclicEdges(), opts({ mode: 'causal' })), 'b');   // a → b → a，无提示
  expect([...c.nodeIds].sort()).toEqual(['a', 'b']);
});

test('起点是提示或摘要节点时链只有它自己；起点不存在或为 null 时是空链', () => {
  const v = buildView(twoTurnChain(), opts({ mode: 'causal' }));
  expect([...upstreamChain(v, 'p2').nodeIds]).toEqual(['p2']);
  expect(upstreamChain(v, 'gone')).toBe(EMPTY_CHAIN);
  expect(upstreamChain(v, null)).toBe(EMPTY_CHAIN);
});

test('500 个节点的直链在 50 毫秒内算完', () => {
  const v = buildView(longChain(500), opts({ mode: 'causal', overrides: new Map([['t1', true]]) }));
  const t = performance.now();
  expect(upstreamChain(v, 'n499').nodeIds.size).toBe(500);
  expect(performance.now() - t).toBeLessThan(50);
});
```

另外两处补充：

```ts
// canvas-view-agents.test.ts
test('因果视角的节点、分组、边与实时视角相同，只有 mode 不同', () => {
  const g = topologyFixture(); const o = { expandedAgents: new Set(['a1']) };
  const live = buildView(g, opts(o)); const causal = buildView(g, opts({ ...o, mode: 'causal' }));
  expect([...causal.nodes.keys()]).toEqual([...live.nodes.keys()]);
  expect(causal.edges).toEqual(live.edges);
  expect(causal.agentGroups).toEqual(live.agentGroups);
  expect(causal.mode).toBe('causal');
});
// canvas-layout.test.ts
test('因果视角下思考节点用大尺寸，其余尺寸不变', () => {
  expect(sizeOf(thinkingViewNode, 'causal')).toEqual({ width: 280, height: 56 });
  expect(sizeOf(thinkingViewNode)).toEqual({ width: 160, height: 28 });
  expect(sizeOf(toolViewNode, 'causal')).toEqual(sizeOf(toolViewNode));
});
```

- [ ] **Step 2: 运行，确认失败**
- [ ] **Step 3: 实现。** `upstreamChain` 先为视图建一次"入边索引"（`to → 边[]`），遍历用队列。
- [ ] **Step 4: 全量测试、类型检查、构建通过后提交**（`feat(web): causal mode and upstream chain in the view model`）

---

### Task 2: 因果视角的界面

**Files:**
- Modify: `packages/web/src/canvas/nodes.tsx`、`Canvas.tsx`、`Drawer.tsx`、`canvas.css`、`packages/web/src/pages/Session.tsx`

**Interfaces:**
- Consumes: `upstreamChain`、`EMPTY_CHAIN`、`ViewMode`。
- Produces: `Drawer` 的 props 增加 `chain: UpstreamChain`、`view: CanvasView`、`onSelect(id: string): void`。

行为：
- 视角切换增加第三项 `因果`。
- 因果视角下的思考节点（280×56）：第一行"思考 · 3.4s"，第二行是 `summary`（单行省略）；`summary` 为空时第二行显示灰色的 `思考内容未记录`。
- 因果视角下选中任意 `graphNode`：`upstreamChain` 的节点和边高亮（节点正常显示并加琥珀色外描边 `#f59e0b`，边加粗并改为琥珀色），其余节点和边不透明度降到 0.3；起点另有选中描边。没有选中时一切正常显示。其他视角下不做链高亮。
- 高亮通过 className / style 实现，不改变节点尺寸和位置，不触发布局请求。
- 抽屉在因果视角下、`chain.reasoning` 非空时，在正文最上方多一段"推理链"：按顺序列出每个思考/回复节点一行（类型标签、时间、`summary`，思考无文本时显示 `思考内容未记录` 和耗时）；点击一行即选中该节点（画布高亮随之更新，抽屉切到该节点）。`chain.reasoning` 为空时该段显示"这一步之前没有记录到思考或回复"。
- 选中的节点从视图中消失时，高亮清空并关闭抽屉（沿用已有逻辑）。

- [ ] **Step 1: 实现**
- [ ] **Step 2: 全量测试、类型检查、构建通过后提交**（`feat(web): causal view with upstream highlighting and a reasoning list`）

---

### Task 3: 文档与浏览器验收

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新 README**："画布"一节加因果视角的说明；"已知限制"里把思考文本一条改为：在一份真实数据上，约 3% 的思考节点带有原文（6352 个中 217 个），其余只有耗时；因果链因此以回复文本和思考耗时为主。
- [ ] **Step 2: 用合成数据在浏览器里核对**（临时目录、`--port 4399`；合成会话含：带文本的思考、不带文本的思考、一组并行工具后接一个工具、一个展开后内部有思考的子代理、足以让第一轮折叠的多个轮次），逐条写结果：
  1. 切到"因果"：思考节点变大并显示内容或 `思考内容未记录`；其他节点位置随之重排一次，之后选中不再引起重排。
  2. 选中汇合点之后的工具：两个并行分支、之前的思考和回复、本轮提示都高亮，其余变淡；上一轮的节点不高亮。
  3. 选中子代理容器内部的节点：内部上游、容器节点、容器之前直到提示的节点都高亮。
  4. 抽屉"推理链"按时间顺序列出思考和回复；点击其中一行，选中跳到该节点。
  5. 切回"实时"：高亮消失，思考节点恢复小尺寸。
  6. 无控制台错误。
- [ ] **Step 3: 全量测试、类型检查、构建通过后提交**（`docs: describe the causal view`）
