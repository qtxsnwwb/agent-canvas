# claude-canvas 里程碑 6（诊断与安装）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一条命令安装/卸载 hooks（先展示、再确认、先备份、只追加）；网页上有诊断页；并修掉真实数据验收里记下的四个显示问题（项目名取错目录、部分会话没有标题、首页活跃数不随时间降级、打开不存在的会话时无限重试）。

**Architecture:** hooks 的合并逻辑是不碰文件系统的纯函数（输入 settings 对象，输出新对象和变更清单），CLI 只负责读、展示、确认、备份、原子写入。诊断页只消费已有的 `GET /api/diagnostics`，接口增加"各类 hook 事件收到多少次"。四个显示问题各在其所属模块里修。

**Tech Stack:** 无新增依赖（确认提示用 `node:readline`）。

**Spec:** `docs/superpowers/specs/2026-11-10-claude-canvas-design.md`（7.1 诊断页、第 10 节的 `hooks install` / `hooks uninstall`、4.3 关于 stale 的最后一句、12 节第 6 项）

## Global Constraints

- 里程碑 2–5 计划的 Global Constraints 继续适用；本里程碑允许改 `packages/server`。
- **任何测试都不得读写真实的 `~/.claude/settings.json`。** settings 路径可由 `--settings <路径>` 和环境变量 `CLAUDE_CANVAS_SETTINGS_FILE` 覆盖，测试一律指向临时文件。
- `hooks install` 只追加，不修改、不重排、不删除 settings 里已有的任何内容；写入前必须备份；写入必须是"写临时文件再改名"。
- settings 不是合法 JSON、或结构不是预期形状时，不写入任何东西，以退出码 1 报错。
- 诊断页不得把未识别记录的样例直接铺在页面上（样例含对话原文）：默认收起，点击才展开。

## Review Focus

1. **settings 已有别人的 hooks。** 同一事件下已有其他命令型 hook、带 `matcher` 的条目、甚至另一个端口的 claude-canvas hook。期望：原有条目逐字节保留（顺序、字段都不变），只在该事件数组末尾追加一项；重复执行不产生重复项。（测试在 Task 1）
2. **settings 形状异常。** 文件不存在、空文件、不是对象、`hooks` 不是对象、某事件的值不是数组、带 BOM、CRLF 换行。期望：不存在或空文件视为 `{}`；BOM 和 CRLF 能读，写回时保持原换行风格；形状不对时报错且不写。（测试在 Task 1、Task 2）
3. **确认环节被绕过。** 非交互终端（管道、CI）里没有 `--yes`。期望：不写入，提示需要 `--yes`，退出码 1。（测试在 Task 2）
4. **卸载误删。** 期望：只删 `type` 为 `http` 且 `url` 恰好等于本服务地址（按 `--port`）的 hook；删空的条目和事件键一并移除，其余原样；别的端口的 claude-canvas hook 不动。（测试在 Task 1）
5. **标题来源互相覆盖。** 自定义标题、代理名、hook 带来的标题、首条提示先后到达且顺序不定。期望：按固定优先级取值，低优先级的后到不覆盖高优先级的；重放结果相同。（测试在 Task 4）

---

### Task 1: hooks 合并的纯函数

**Files:**
- Create: `packages/server/src/hooks-config.ts`
- Test: `packages/server/test/hooks-config.test.ts`

**Interfaces:**
- Produces:

```ts
export const HOOK_EVENTS: readonly string[];          // 14 个事件，顺序同 docs/hooks-snippet.json
export const HOOK_TIMEOUT_SECONDS = 2;
export function hookUrl(port: number): string;        // `http://127.0.0.1:${port}/hooks`
export class SettingsShapeError extends Error {}
export interface InstallPlan { next: Record<string, unknown>; added: string[]; alreadyPresent: string[] }
/** 不修改传入对象。事件"已存在"= 该事件数组里任一条目的 hooks 含 { type: 'http', url: hookUrl(port) }。 */
export function planInstall(settings: unknown, port: number): InstallPlan;
export interface UninstallPlan { next: Record<string, unknown>; removed: string[] }   // removed：被移除了 hook 的事件名
export function planUninstall(settings: unknown, port: number): UninstallPlan;
```

追加的条目固定为 `{ "hooks": [{ "type": "http", "url": hookUrl(port), "timeout": 2 }] }`。`settings` 为 `undefined`/`null` 视为 `{}`；不是普通对象、`hooks` 存在但不是普通对象、某个我们要动的事件的值不是数组 → 抛 `SettingsShapeError`（消息指出是哪个键）。卸载：从每个事件的每个条目的 `hooks` 数组里删掉匹配项；条目的 `hooks` 变空则删该条目；事件数组变空则删该事件键；`hooks` 对象变空则删 `hooks` 键。

- [ ] **Step 1: 写失败的测试**

```ts
test('空 settings：加上全部 14 个事件', () => {
  const p = planInstall({}, 4317);
  expect(p.added).toEqual([...HOOK_EVENTS]);
  expect((p.next.hooks as any).PreToolUse).toEqual([{ hooks: [{ type: 'http', url: 'http://127.0.0.1:4317/hooks', timeout: 2 }] }]);
});
test('保留其他键和已有 hooks，只在事件数组末尾追加', () => {
  const before = { theme: 'dark', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] } };
  const p = planInstall(before, 4317);
  expect(p.next.theme).toBe('dark');
  expect((p.next.hooks as any).PreToolUse[0]).toEqual(before.hooks.PreToolUse[0]);
  expect((p.next.hooks as any).PreToolUse).toHaveLength(2);
  expect(before.hooks.PreToolUse).toHaveLength(1);                 // 入参未被修改
});
test('重复安装不产生重复项', () => {
  const once = planInstall({}, 4317).next;
  const twice = planInstall(once, 4317);
  expect(twice.added).toEqual([]);
  expect(twice.alreadyPresent).toEqual([...HOOK_EVENTS]);
  expect(twice.next).toEqual(once);
});
test('另一个端口的 claude-canvas hook 不算已存在，也不被改动', () => {});
test('HOOK_EVENTS 与 docs/hooks-snippet.json 的事件一致', () => {});
test.each([[[], 'settings'], ['x', 'settings'], [{ hooks: [] }, 'hooks'], [{ hooks: { Stop: {} } }, 'hooks.Stop']])('形状异常 %j 抛 SettingsShapeError 并指出 %s', (s, key) => {
  expect(() => planInstall(s, 4317)).toThrow(SettingsShapeError);
  expect(() => planInstall(s, 4317)).toThrow(key);
});
test('卸载只删本端口的 http hook；删空的条目、事件键、hooks 键一并移除；其余原样', () => {
  const s = planInstall({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } }, 4317).next;
  const u = planUninstall(s, 4317);
  expect(u.next).toEqual({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } });
  expect(u.removed).toEqual([...HOOK_EVENTS]);
  expect(planUninstall(planInstall({}, 4317).next, 4317).next).toEqual({});
});
test('卸载不动别的端口的 hook；没有可删的时 removed 为空且 next 与入参深相等', () => {});
test('同一条目里既有我们的 hook 又有别的 hook：只删我们的那个', () => {});
```

- [ ] **Step 2: 运行，确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 全量测试、类型检查、构建通过后提交**（`feat: plan hook installation and removal as pure functions`）

---

### Task 2: `hooks install` / `hooks uninstall` 命令

**Files:**
- Modify: `packages/server/src/cli.ts`、`packages/server/src/config.ts`
- Create: `packages/server/src/hooks-cli.ts`
- Test: `packages/server/test/hooks-cli.test.ts`

**Interfaces:**
- Consumes: Task 1。
- Produces:

```ts
export interface HooksCliIo {
  out(line: string): void;
  err(line: string): void;
  confirm(question: string): Promise<boolean>;   // 交互终端下读一行，y/yes 为真
  isInteractive: boolean;
  now(): Date;
}
export interface HooksCliOptions { settingsFile: string; port: number; yes: boolean }
/** 返回进程退出码。 */
export function runHooksInstall(opts: HooksCliOptions, io: HooksCliIo): Promise<number>;
export function runHooksUninstall(opts: HooksCliOptions, io: HooksCliIo): Promise<number>;
export function defaultSettingsFile(env: NodeJS.ProcessEnv): string;   // CLAUDE_CANVAS_SETTINGS_FILE，否则 ~/.claude/settings.json
```

命令行：`claude-canvas hooks install [--port N] [--yes] [--settings <路径>]`，`hooks uninstall` 同参数。行为（install，uninstall 对称）：

1. 读文件：不存在或内容为空白 → `{}`；去掉开头的 BOM；JSON 解析失败 → `err("<路径> 不是合法的 JSON：<原因>")`，返回 1，不写。
2. `planInstall`；`SettingsShapeError` → `err`，返回 1，不写。
3. `added` 为空 → `out("hooks 已全部安装，无需改动（<路径>）")`，返回 0，不写、不备份。
4. 输出将要做的事：settings 路径、hook 地址、将添加的事件列表、"不会改动已有的其他内容"、备份文件的路径。
5. 没有 `--yes`：非交互终端 → `err("非交互终端下需要加 --yes 才会写入")`，返回 1；交互终端 → `confirm("写入以上改动？(y/N) ")`，否则 `out("已取消，未做任何改动")`，返回 0。
6. 备份：原文件存在时复制为 `<路径>.bak-claude-canvas-<YYYYMMDD-HHMMSS>`（本地时间，取自 `io.now()`）；同名已存在则在末尾加 `-2`、`-3`…
7. 写入：`JSON.stringify(next, null, 2)` 加末尾换行；原文件用 CRLF 则写回 CRLF；先写 `<路径>.tmp-<pid>` 再 `rename` 覆盖；目录不存在则创建。
8. 输出"已写入"、备份路径，以及"新开的 Claude Code 会话才会使用这些 hooks"。返回 0。

`uninstall`：`removed` 为空时输出"没有找到指向 <地址> 的 hooks"并返回 0；否则同样展示、确认、备份、写入。

- [ ] **Step 1: 写失败的测试**（全部在临时目录里，`io` 用可记录输出、可预设 `confirm` 结果的假对象）

```ts
test('文件不存在 + --yes：创建文件，含 14 个事件，返回 0，不产生备份', async () => {});
test('已有 settings + --yes：先备份（内容与原文件逐字节相同），再写入；其他键保留', async () => {});
test('交互确认为否：返回 0，文件未变，没有备份', async () => {});
test('非交互且没有 --yes：返回 1，文件未变，stderr 提到 --yes', async () => {});
test('重复安装：第二次不写入、不备份，提示已全部安装', async () => {});
test('非法 JSON：返回 1，文件未变', async () => {});
test('hooks 形状异常：返回 1，文件未变，stderr 指出键名', async () => {});
test('带 BOM、CRLF 的文件：能读；写回为 CRLF、无 BOM 亦可但必须是合法 JSON', async () => {});
test('备份名冲突时加序号，不覆盖已有备份', async () => {});
test('写入后目录里没有残留的 .tmp- 文件', async () => {});
test('uninstall：只移除本端口的 hooks，备份后写入；没有可移除的时不写入', async () => {});
test('--port 4400 安装的是 4400 端口的地址', async () => {});
test('cli：`hooks` 后跟未知子命令时返回 1 并打印用法', async () => {});
```

- [ ] **Step 2: 运行，确认失败**
- [ ] **Step 3: 实现，并在 `cli.ts` 的命令分发里接上；无参数或未知命令时的用法文字包含新命令**
- [ ] **Step 4: 全量测试、类型检查、构建通过后提交**（`feat: hooks install and uninstall commands with confirmation and backup`）

---

### Task 3: 诊断页

**Files:**
- Modify: `packages/shared/src/api.ts`、`packages/server/src/store/schema.ts`、`packages/server/src/store/store.ts`、`packages/server/src/api/server.ts`
- Modify: `packages/web/src/App.tsx`、`packages/web/src/client.ts`、`packages/web/src/styles.css`
- Create: `packages/web/src/pages/Diagnostics.tsx`、`packages/web/src/diagnostics.ts`
- Test: `packages/server/test/store.test.ts`、`packages/server/test/api.test.ts`、`packages/web/test/diagnostics.test.ts`、`packages/web/test/app.test.ts`（没有则在已有的路由测试里加）

**Interfaces:**
- Produces:

```ts
// shared/api.ts —— Diagnostics 增加：
//   hookEvents: { eventName: string; count: number; lastAt: string }[]   // 按 eventName 升序；从未收到的事件不出现
// store：hookEventStats(): Diagnostics['hookEvents']，由 raw_event 中 source='hook' 的行按事件名聚合。
//   为它建部分索引（只覆盖 hook 行），使查询不扫描 transcript 行。
// web/client.ts
api.diagnostics(): Promise<Diagnostics>;
// web/App.tsx：Route 增加 { page: 'diagnostics' }，对应 `#/diagnostics`
// web/diagnostics.ts
export const EXPECTED_HOOK_EVENTS: readonly string[];   // 14 个事件，与服务端 HOOK_EVENTS 相同（各自定义，测试保证一致）
export interface DiagnosticsSummary {
  hooks: 'never' | 'recent' | 'quiet';        // lastHookAt 为空 / 距今 ≤ 10 分钟 / 更久
  hookAgeMs: number | null;
  missingHookEvents: string[];                // EXPECTED_HOOK_EVENTS 里从未收到的
  filesTotal: number;
  filesBehind: { path: string; offset: number; size: number }[];   // offset < size 的，最多 200 条
  unknownTotal: number;                       // unknownRecords 的 count 之和
}
export function summarizeDiagnostics(d: Diagnostics, nowMs: number): DiagnosticsSummary;
```

页面（`#/diagnostics`，顶栏"Claude Canvas"右侧加"诊断"链接）：每 5 秒刷新一次，卸载时停止；请求失败时保留上一次内容并在顶部显示"刷新失败：…"。分区：
- **服务**：是否正在导入、推导规则版本、数据库标识。
- **Hooks**：最近一次收到的时间（"N 秒/分钟前"）；`never` 时提示"尚未收到任何 hook。运行 `claude-canvas hooks install` 安装；新开的会话才会生效"；`quiet` 时提示"超过 10 分钟没有收到 hook"。表格：事件名、次数、最近一次；其下一行"尚未收到过：…"列出 `missingHookEvents`（为空则不显示）。
- **导入失败**：文件、错误、时间；为空显示"无"。
- **未识别的记录类型**：类型、次数；样例放在 `<details>` 里默认收起，展开后以文本显示，最多 2000 字符。
- **文件读取进度**：共 N 个文件，M 个尚未读完；列出未读完的（路径、已读/总字节）。

- [ ] **Step 1: 写失败的测试**

```ts
// store / api
test('hookEventStats 按事件名聚合次数和最近时间，不含 transcript 行', () => {});
test('GET /api/diagnostics 带 hookEvents', async () => {});
// web
test('summarizeDiagnostics：从未收到 / 10 分钟内 / 更久', () => {});
test('missingHookEvents 是 14 个事件里没出现的，顺序同 EXPECTED_HOOK_EVENTS', () => {});
test('filesBehind 只含未读完的文件，最多 200 条；unknownTotal 是次数之和', () => {});
test('EXPECTED_HOOK_EVENTS 与 docs/hooks-snippet.json 一致', () => {});
test('parseHash("#/diagnostics") 是诊断页；未知路径仍回首页', () => {});
```

- [ ] **Step 2: 运行，确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 全量测试、类型检查、构建通过后提交**（`feat: diagnostics page and per-event hook counts`）

---

### Task 4: 验收遗留的四个显示问题

**Files:**
- Modify: `packages/server/src/normalize/normalizer.ts`、`transcript.ts`、`hooks.ts`、`version.ts`、`packages/server/src/store/store.ts`、`packages/server/src/api/server.ts`
- Modify: `packages/web/src/client.ts`、`packages/web/src/pages/Session.tsx`、`packages/web/src/pages/Home.tsx`
- Modify: 规格 4.1、4.3
- Test: `packages/server/test/normalize-transcript.test.ts`、`normalize-hooks.test.ts`、`store.test.ts`、`api.test.ts`、`packages/web/test/client.test.ts`

四项各自的规则：

**(a) 项目显示的目录。** `Project.cwd` = 该项目各会话的 `cwd` 中，"把每个非字母数字字符换成 `-` 后等于项目 id"的那个（Claude Code 就是这样由目录得到项目目录名的）；有多个不同写法时取出现次数最多的，并列取字典序最小的；一个都没有则为 `null`（页面显示项目 id）。

**(b) 会话标题。** 标题按来源取优先级最高的非空值：`custom`（`custom-title.json` 文件或 transcript 里 `type: "custom-title"` 记录的 `customTitle`）> `agentName`（`type: "agent-name"` 记录的 `agentName`）> `hook`（`UserPromptSubmit` 载荷的 `session_title`）> `prompt`（主线第一条用户提示的前 60 个字符，换行换成空格）。同一来源后到的覆盖先到的；低优先级的不覆盖高优先级的。各来源的当前值只记在归一器内存里，按原始事件顺序重放得到相同结果。`custom-title`、`agent-name` 两种记录类型从此不再计入未识别统计。`NORMALIZER_VERSION` 加 1。

**(c) 首页活跃数。** `GET /api/projects` 的 `activeSessionCount` 不计 stale 会话（状态为运行中且最近活动距今超过 15 分钟，判定复用 `shared` 里的 `effectiveStatus`）；服务端用请求时刻计算。首页每 60 秒重新取一次项目列表。

**(d) 不存在的会话。** `getJson` 失败时抛出的错误带 `status`；`openLiveSession` 首次取图得到 404 时页面显示"会话不存在"和返回首页的链接；重新同步（resync）时得到 404 则停止重试并让页面显示同样的内容；其他错误沿用原有的重试。

- [ ] **Step 1: 写失败的测试**

```ts
// (a)
test('项目目录取编码后等于项目 id 的 cwd；子目录里启动的会话不影响', () => {
  // 项目 id 'D--work-app'：会话 cwd 为 'D:\\work\\app'（2 个）和 'D:\\work\\app\\packages\\web'（3 个）
  expect(store.listProjects(now)[0]).toMatchObject({ id: 'D--work-app', cwd: 'D:\\work\\app' });
});
test('没有任何 cwd 能对上项目 id 时为 null', () => {});
// (b)
test.each([
  [['prompt', 'hook', 'agentName', 'custom'], 'custom'],
  [['custom', 'agentName', 'hook', 'prompt'], 'custom'],
  [['prompt', 'agentName'], 'agentName'],
  [['hook', 'prompt'], 'hook'],
  [['prompt'], 'prompt'],
])('标题来源按 %j 的顺序到达，最终取 %s', (order, winner) => {});
test('首条提示作标题：取前 60 个字符，换行换成空格；之后的提示不改标题', () => {});
test('custom-title 和 agent-name 记录不再计入未识别统计', () => {});
// (c)
test('运行中但 15 分钟无活动的会话不计入 activeSessionCount；等待输入、等待权限确认的照常计入', () => {});
// (d)
test('首次取图 404：openLiveSession 以带 status 404 的错误 reject', async () => {});
test('resync 时 404：不再重试，订阅者收到通知，isGone() 为真', async () => {});
test('resync 时 500：按原有间隔重试', async () => {});
```

`LiveSession` 增加 `isGone(): boolean`。

- [ ] **Step 2: 运行，确认失败**
- [ ] **Step 3: 实现；规格 4.1 加项目目录的取法，4.3 加标题优先级**
- [ ] **Step 4: 全量测试、类型检查、构建通过后提交**（`fix: project directory, session titles, stale-aware active count, missing sessions`）

---

### Task 5: 文档与验收

**Files:**
- Modify: `README.md`、`docs/hooks-snippet.json`（仅当与 `HOOK_EVENTS` 不一致）

- [ ] **Step 1: 更新 README**：Hooks 一节以 `claude-canvas hooks install` / `uninstall` 为主（参数、确认、备份文件名、改端口时用 `--port`），手动合并降为备选；新增"诊断页"一节（地址 `#/diagnostics`，各分区看什么）；"已知限制"删去"目前还没有诊断页"。
- [ ] **Step 2: 用临时目录核对命令行**：对一个含其他 hooks 的临时 settings 文件依次执行 install（交互取消）、install `--yes`、再次 install、uninstall `--yes`，逐条写出文件前后差异和退出码。
- [ ] **Step 3: 由控制者核对真实配置（只读）**：把使用者真实的 settings 复制到临时目录，对副本执行 `hooks install --yes --settings <副本>`，期望"已全部安装，无需改动"；不对真实文件执行任何写入。
- [ ] **Step 4: 浏览器核对**（临时目录、`--port 4399`）：诊断页各分区；发送几类 hook 后表格更新、"尚未收到过"相应缩短；首页项目名与标题；打开一个不存在的会话 id 显示"会话不存在"且网络面板里不再有重复请求。
- [ ] **Step 5: 由控制者在真实数据上核对**（只看结构）：升级后自动重建；没有标题的会话数应为 0；项目名与项目 id 对应。
- [ ] **Step 6: 全量测试、类型检查、构建通过后提交**（`docs: hooks commands and the diagnostics page`）
