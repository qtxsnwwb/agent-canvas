# 接入 Codex 设计规格

- 日期：2026-11-11
- 状态：待评审
- 前置：`2026-11-10-claude-canvas-design.md`（下称"主规格"）。本文只写新增和改动的部分。

## 1. 目标

让 OpenAI Codex（桌面应用和 CLI）的会话和 Claude Code 的会话出现在同一个系统里：同样的首页、画布、瀑布图、复盘，同样的数据模型。

已确认的范围（2026-11-11）：

- Codex 会话和 Claude Code 会话**合在一起**：同一个工作目录下的两类会话属于同一个项目，每个会话带来源标记，首页可按来源筛选。
- **会话文件和 hooks 都接**。
- **不导入已归档会话**（`~/.codex/archived_sessions`）。

### 成功标准

- 首页能看到本机 Codex 的主会话，和同目录的 Claude Code 会话在同一个项目下，卡片上标明来源。
- 进入一个 Codex 会话，概览、逐步、拓扑、因果、复盘五个视角都能用；子代理线程显示为它被派出的那一步下面的子代理。
- 正在运行的 Codex 会话，不装 hooks 时靠监视文件更新（延迟几秒）；装了 hooks 时工具开始执行、等待权限确认的延迟不超过 1 秒。
- 服务没启动、hooks 没装、或转发程序出错时，Codex 的行为和速度不受影响。
- Codex 升级导致记录格式变化时，服务不崩溃，诊断页能看到哪些记录没被识别。
- 已有的 Claude Code 数据、行为和测试不受影响；升级后自动重建一次。

### 不做

- 已归档会话。
- Codex 云端任务（`codex cloud`）。
- 修改 Codex 的行为：hooks 只观察，永远放行。
- 每个节点的 token 用量（Codex 的用量记录按"响应"而不是按"步骤"，对不上节点；第一版复盘视角里 Codex 会话的 token 合计显示为 0，见第 9 节）。

## 2. 调研结论（本机，Codex 0.142.5）

以下结构是 2026-11-11 在本机 100 个会话文件上核对过的（只看了结构和字段名）。

### 2.1 会话文件

- 位置：`~/.codex/sessions/YYYY/MM/DD/rollout-<时间>-<线程 id>.jsonl`，每个**线程**一个文件。
- 每行：`{ timestamp, ordinal, type, payload, metadata }`。
- 第一行 `session_meta`：`id` 是线程 id（等于文件名里的 id）；`session_id` 是**根线程**的 id（子代理线程的 `session_id` 是它所属主会话的 id）；`parent_thread_id` 只有子代理线程有；还有 `cwd`、`originator`、`agent_nickname`、`agent_path`、`forked_from_id`。
- 100 个文件里 8 个是主会话，92 个是子代理线程。
- 标题在 `~/.codex/session_index.jsonl`：每行 `{ id, thread_name, updated_at }`。

### 2.2 记录类型

| 记录 | 关键字段 | 用途 |
|---|---|---|
| `event_msg/task_started` | `turn_id` | 轮次开始 |
| `event_msg/task_complete` | `turn_id`, `duration_ms`, `error` | 轮次结束 |
| `event_msg/turn_aborted` | `turn_id`, `reason` | 轮次被打断 |
| `event_msg/item_completed`，`item.type = UserMessage` | `item.content`, `client_id` | 用户真正输入的提示 |
| `response_item/message`，`role = assistant` | `content`, `phase`（`commentary` / `final_answer`） | 回复 |
| `response_item/reasoning` + `item_completed/Reasoning` | `summary`（多为空）、`started_at_ms`、`completed_at_ms` | 思考：只有摘要和时长，正文是加密的 |
| `response_item/custom_tool_call`、`function_call` | `call_id`, `name`, `namespace`, `input` / `arguments` | 工具调用开始 |
| `…_output` | `call_id`, `output` | 工具调用结束 |
| `item_completed`，`item.type = CommandExecution / McpToolCall / FileChange / …` | `status`, `exit_code`, `duration`, `command` | 一次调用内部实际发生的事（命令、MCP、改文件） |
| `item_completed/SubAgentActivity` | `id`（等于派出它的 `call_id`）、`agent_thread_id`, `agent_path`, `kind` | 把"派出子代理"的那次调用和子代理线程连起来 |
| `response_item/message`，`role = developer` 或 `user`（上下文注入） | — | 不产生节点 |
| `token_usage_record`、`event_msg/token_count`、`world_state`、`turn_context`、`thread_settings_applied` | — | 第一版不产生节点 |
| `response_item/compaction`、`compacted` | — | 上下文压缩（系统节点） |

本机工具分布：`exec` 3801 次（Codex 的通用执行工具，一次调用里跑一条或多条命令）、`collaboration.send_message` 537、`followup_task` 71、`wait_agent` 59、`spawn_agent` 50，其余是 MCP 工具。

### 2.3 Hooks

来源：官方文档 <https://developers.openai.com/codex/hooks>。

- 事件：`SessionStart`、`SessionEnd`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`SubagentStart`、`SubagentStop`、`Stop`、`PreCompact`、`PostCompact`、`Interrupt`、`PreModelRequest`、`PostModelRequest`。
- 配置：`~/.codex/hooks.json`，结构和 Claude Code 的 `hooks` 一样（事件 → 匹配组 → 处理器）。
- 处理器只有 `command` 和 `mcp_tool` 两种，**没有 HTTP**。命令从标准输入收到 JSON。可设 `async: true`（后台运行，不阻塞、不能改变结果）和 `timeout`；Windows 用 `commandWindows`。
- 载荷字段：`session_id`、`transcript_path`、`cwd`、`hook_event_name`、`model`；工具类事件有 `turn_id`、`tool_name`、`tool_use_id`、`tool_input`、`tool_response`；子代理事件有 `agent_id`、`agent_type`，`session_id` 是父会话的。
- **信任**：新增或改动的 hook 默认不运行，要使用者在 Codex 里确认（CLI 的 `/hooks`，桌面应用的"设置 → Hooks"）。信任绑定在 hook 的内容上，改了要重新确认。

以上字段来自文档。和主规格里对 Claude Code 的做法一样，验收时要装上 hooks 录一批真实载荷核对，尤其是 `tool_use_id` 是否等于会话文件里的 `call_id`。

## 3. 总体做法

不新建一套系统，在现有管线上加一个**来源**（origin）维度：`claude` 或 `codex`。

```
~/.claude/projects ──► Claude 文件源 ──┐
~/.codex/sessions  ──► Codex 文件源  ──┼─► 原始事件（带 origin）─► 按 origin 选归一器 ─► 同一套图模型 ─► 存储 / 接口 / 页面
POST /hooks（两种来源）────────────────┘
```

- 原始事件、文件偏移、会话都带上 `origin`。
- 每个来源有自己的文件源（怎么找文件、怎么从文件得到会话和线程）和自己的归一器（记录 → 节点和边）。
- 归一器的输出是同一套 `Change`，所以存储、接口、推送、页面上的五个视角都不用为 Codex 另写。

## 4. 数据模型的改动

### 4.1 共享类型

- `Session` 增加 `origin: 'claude' | 'codex'`。老数据重建后都是 `claude`。
- `Project` 不变：项目 id 仍是工作目录的编码（非字母数字换成 `-`）。Codex 会话的项目 id 由它的 `cwd` 按同样规则算出；如果已有一个只是大小写不同的项目 id（Windows 盘符大小写），用已有的那个。
- `Project` 增加 `origins: ('claude' | 'codex')[]`（这个项目里出现过哪些来源），首页筛选用。
- `Diagnostics.files[].path` 对 Codex 文件加前缀 `codex:`；`hookEvents[]` 增加 `origin`。
- `GraphNode` 不变。`toolName` 存 Codex 的工具名原样（`exec`、`spawn_agent`、MCP 工具全名）。

### 4.2 存储

- `raw_event` 增加列 `origin`（默认 `claude`），Codex 的记录同时写入 `project_id`、`session_id`、`agent_id`（重放时不再从路径推断）。
- `raw_event.file`、`file_offset.file`：Claude 文件保持原样（相对 `~/.claude/projects`）；Codex 文件是 `codex:` 加相对 `~/.codex/sessions` 的路径。
- `hook_stat` 的键改为（来源，事件名）。
- 会话 id：Codex 线程 id 和 Claude 会话 id 都是全局唯一的标识，不加前缀。
- 这些是结构改动，库打开时迁移（加列、重建 `hook_stat`）；推导规则版本加一，启动时自动重建。

## 5. Codex 文件源

- 新配置 `codexSessionsDir`，默认 `~/.codex/sessions`，环境变量 `CLAUDE_CANVAS_CODEX_DIR`；设为空字符串表示不接 Codex。目录不存在时静默跳过。
- 发现文件：监视该目录（深度 4：年/月/日/文件），加上和 Claude 文件源相同的定时复查与全量扫描。
- 一个文件属于哪个会话，文件名里只有线程 id，要读第一行 `session_meta` 才知道根线程和父线程。读到之前不处理这个文件的其他行；第一行不是 `session_meta` 的文件记入诊断页的"导入失败"。
- 映射：会话 id = `session_meta.session_id`（根线程）；主线程的 `agentId` 为空；子代理线程的 `agentId` = 它的线程 id。
- 标题：监视 `~/.codex/session_index.jsonl`，按 `id` 给会话设置标题（标题优先级：这个标题 > 第一条提示）。
- 读取、偏移、截断、去重沿用现有的 `readNewLines` 和原始事件去重。
- 源文件消失（被归档或删除）：和 Claude 一样标记"源文件已删除"，数据保留。

## 6. Codex 归一器

独立的类，和现有归一器实现同一个接口，由管线按原始事件的来源选择。

| Codex 记录 | 产生什么 |
|---|---|
| `task_started` | 开始一个轮次（`turnId` = `turn_id`）；会话状态 → 运行中 |
| `item_completed/UserMessage` | 提示节点（轮次的第一个节点）。子代理线程里，派出时给它的任务也作为提示节点 |
| `response_item/message`（assistant） | 回复节点；`phase` 记在 `systemSubtype` 以外不展示 |
| `response_item/reasoning` | 思考节点；摘要作为内容（为空则为空，精简模式下不显示），时长取对应 `item_completed/Reasoning` 的起止时间 |
| `custom_tool_call` / `function_call` | 工具节点，状态"执行中"；`toolUseId` = `call_id` |
| 对应的 `…_output` | 该节点结束：成功或失败，记录结束时间和耗时 |
| 调用期间出现的 `CommandExecution` / `McpToolCall` / `FileChange` 等 | 不单独成节点，归到正在进行的那次调用上：命令文本作为节点摘要，各条的退出码和耗时进节点详情；任何一条失败则节点为失败 |
| `spawn_agent` 调用 + `SubAgentActivity` | 子代理节点，`childAgentId` = `agent_thread_id`，标题取代理的昵称或路径 |
| 子代理线程的记录 | 该子代理内部的节点（`agentId` = 线程 id），和派发节点之间有派发边 |
| `task_complete` | 轮次结束；主线程：会话状态 → 空闲；`error` 非空时在轮次末尾加一个失败的系统节点 |
| `turn_aborted` | 中断的系统节点；会话状态 → 空闲 |
| `compaction` / `compacted` | 压缩的系统节点 |
| 其余已知但不展示的类型 | 忽略，不计入"未识别" |
| 不认识的类型 | 计入诊断页的"未识别的记录类型" |

**子代理节点的状态**：Codex 的子代理是长期存在的线程，可以被反复追加任务（`send_message`、`followup_task`），不是一次性的。派发节点的状态跟着子代理线程走：线程里有轮次在进行 → 执行中；最后一个轮次已结束 → 成功（结束时间取那个轮次的结束时间）；之后又开始新轮次 → 回到执行中。会话已结束或长时间无动静时的显示沿用主规格现有规则（"未结束"）。

**节点的连接**：同一线程内按记录顺序串联；同一条模型响应里的多个工具调用按并行处理（同父分叉、之后汇合），和 Claude 的规则一致。

## 7. Hooks

### 7.1 转发程序

Codex 不能直接发 HTTP，所以加一个子命令：

```
node <claude-canvas>/packages/server/dist/cli.js hook-forward --origin codex --port 4317
```

它从标准输入读一段 JSON，原样 POST 到 `http://127.0.0.1:<port>/hooks?origin=codex`，然后退出。要求：

- 永远以退出码 0 结束，标准输出不写任何内容（Codex 会解析 hook 的输出，写了东西可能影响它）。
- 连接超时 1 秒；服务没启动时立刻结束。
- 不读写任何文件。

### 7.2 安装

- `hooks install --codex` / `hooks uninstall --codex`，默认操作 `~/.codex/hooks.json`（可用 `--settings` 指定别的文件）。
- 写入的事件：`SessionStart`、`SessionEnd`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`SubagentStart`、`SubagentStop`、`Stop`、`PostCompact`、`Interrupt`。不装 `PreModelRequest`、`PostModelRequest`、`PreCompact`（量大，用不上）。
- 每条 hook：`type: command`，`command` 和 `commandWindows` 都写（用绝对路径指向当前安装的 `node` 和 `cli.js`），`async: true`，`timeout: 5`。
- 沿用现有安装流程的全部保护：先列出改动、确认、备份、只追加不改动已有内容、遇到不寻常的文件拒绝写入。文件不存在时新建。
- 安装成功后明确提示：**需要在 Codex 里确认信任这些 hooks 才会生效**（桌面应用"设置 → Hooks"，CLI 里 `/hooks`）；升级 claude-canvas 后如果命令路径变了，要重新安装并重新确认。

### 7.3 接收

- `POST /hooks` 读查询参数 `origin`（缺省 `claude`，现有 Claude Code 的 hook 配置不用动）。
- Codex 的 hook 事件和 Claude 的含义相同，映射到同样的效果：`PreToolUse` 提前建立"执行中"的工具节点、`PermissionRequest` → 等待权限确认、`PostToolUse` 结算、`Stop` → 空闲、`SessionEnd` → 已结束、`SubagentStart/Stop`、`Interrupt` → 中断。
- 子代理的 hook 带的是父会话的 `session_id` 和它自己的 `agent_id`，正好对上本系统的会话和线程。
- hook 和会话文件说的是同一件事时，以会话文件为准（和 Claude 一致）。

## 8. 页面

- 会话卡片、搜索结果、会话页标题栏上有来源标记（Claude Code / Codex）。
- 首页多一组筛选：全部 / Claude Code / Codex，选择记在浏览器里。项目卡片上的会话数随筛选变化；筛选后没有会话的项目不显示。
- 五个视角、精简模式、瀑布图、详情抽屉不改逻辑。工具节点显示 Codex 的工具名；`exec` 这类一次跑多条命令的调用，详情里列出每条命令的退出码和耗时。
- 诊断页：hooks 一节按来源分开；增加一行说明 Codex 会话目录是否存在、Codex hooks 是否收到过。
- README 增加 Codex 一节：如何启用、hooks 如何安装和确认信任、已知限制。

## 9. 已知限制（写进 README）

- 思考内容：Codex 的思考正文是加密的，只有摘要，而且摘要多数为空。Codex 会话的"因果"视角主要靠回复文本。
- token：第一版不显示 Codex 的 token 用量。
- 已归档会话不导入。归档一个会话后，它在本系统里显示为"源文件已删除"，已采集的内容仍可看。
- hooks 需要使用者在 Codex 里手动确认信任；没确认时本系统只靠会话文件工作。
- Codex 的会话文件格式不是稳定接口（官方文档原话），升级后可能出现未识别的记录。

## 10. 测试

- 归一器：用仿照真实结构、脱敏后的记录序列做夹具，覆盖轮次、提示、回复、思考、工具（成功、失败、多条命令）、并行调用、子代理（派出、内部步骤、追加任务后重新运行）、压缩、中断、轮次失败、未识别类型。
- 文件源：临时目录里的年/月/日结构；第一行不是 `session_meta`；文件先于父线程文件出现；截断和追加；`session_index.jsonl` 更新。
- 管线：两种来源同时导入、重建后结果一致、Claude 的既有测试全部不变。
- 存储迁移：从旧结构的库打开后，老数据的来源都是 `claude`，hook 统计不丢。
- 转发程序：服务没启动、超时、输入不是 JSON 时都以 0 退出且无输出。
- 安装：沿用现有安装测试的全部场景，目标换成 `hooks.json`；任何测试和手动运行都不读写真实的 `~/.codex/hooks.json`。
- 测试和测试服务一律用临时目录（`CLAUDE_CANVAS_CODEX_DIR`、`CLAUDE_CANVAS_PROJECTS_DIR`、`CLAUDE_CANVAS_DATA_DIR`）。查看真实 Codex 数据只看结构和数量，不看内容。

## 11. 里程碑

1. **数据模型与存储**：`origin` 贯穿共享类型、原始事件、存储和迁移；管线按来源选择文件源和归一器。Claude 的行为不变。
2. **Codex 文件源与归一器**：历史会话可见，五个视角可用，子代理线程挂到派发节点下。
3. **页面**：来源标记、首页筛选、诊断页。
4. **Hooks**：转发程序、安装命令、接收和归一。
5. **验收**：在本机真实数据上导入并核对数量；经使用者同意后安装 hooks、在 Codex 里确认信任、录一批真实载荷和第 2.3 节核对；更新 README。

## 12. 风险

| 风险 | 应对 |
|---|---|
| 会话文件格式随 Codex 版本变化 | 原始记录保留、派生可重建、未识别类型进诊断页；归一器集中在一个文件并以夹具覆盖 |
| hook 的 `tool_use_id` 和文件里的 `call_id` 对不上 | 验收时用真实载荷核对；对不上时按"同一线程里最近一个同名、未结束的调用"匹配，和 Claude 的权限匹配同一思路 |
| 每个 hook 事件启动一次 node 进程，拖慢 Codex | `async: true` 不阻塞；验收时实测一次转发的耗时并写进 README |
| 一次 `exec` 调用里的多条命令被收成一个节点，丢了细节 | 详情里逐条列出；瀑布图以调用为单位，后续可按需要拆开 |
| 子代理线程文件先于主线程文件被读到 | 线程 → 会话的对应关系来自文件自己的第一行，不依赖读取顺序；派发边在两端都出现后补上（和现有做法相同） |
| 改动存储结构影响已有数据 | 迁移只加列；派生表本来就可重建；迁移有测试覆盖 |
