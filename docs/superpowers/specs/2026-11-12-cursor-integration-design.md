# 接入 Cursor 设计规格

- 日期：2026-11-12
- 状态：已实现（2026-11-12）。实现过程中在真实数据上发现的事实和由此做的改动见文末“实现修订”，与正文冲突处以修订为准。
- 前置：`2026-11-10-agent-canvas-design.md`（主规格）、`2026-11-11-codex-integration-design.md`（Codex 规格）。本文只写新增和改动的部分。

## 1. 目标

让 Cursor 的 Agent 会话和 Claude Code、Codex 的会话出现在同一个系统里：同样的首页、画布、瀑布图、复盘，同样的数据模型。

已确认的范围（2026-11-12）：

- 数据来源是 **Cursor 的本地状态数据库**（只读），不是 `~/.cursor/projects` 下的会话记录文件。
- **不导入已归档会话**。
- **hooks 一起做**。
- Grok 这次不做。

### 成功标准

- 首页能看到本机 Cursor 未归档的 Agent 会话，和同目录的其他来源会话在同一个项目下，卡片标明来源，可按来源筛选。
- 进入一个 Cursor 会话，五个视角都能用；每一步有起止时间和成败；子代理显示在派出它的那一步下面，可展开。
- 正在运行的 Cursor 会话，不装 hooks 时靠轮询数据库更新，延迟不超过约 5 秒；装了 hooks 时会话开始运行、结束的延迟不超过 1 秒。
- 对 Cursor 没有任何影响：数据库只读打开、不持有长事务；hooks 永远不会阻止 Cursor 的任何动作；服务没启动或转发程序出错时 Cursor 的行为不变。
- Cursor 升级导致库里的记录形状变化时，服务不崩溃，诊断页能看到哪些记录没被识别。
- 已有的 Claude Code、Codex 数据和测试不受影响；升级后自动重建一次。

### 不做

- 已归档会话；草稿（没发出过消息的会话）。
- Cursor 的云端 / 后台 Agent（Background Agent）、Tab 补全。
- 会话记录文件（`agent-transcripts/*.jsonl`）的解析：它没有时间、没有工具结果，本设计不读它。
- 能阻止动作的 hooks（见 7.1）。

## 2. 本机事实（2026-11-12，只看结构）

数据库：`%APPDATA%\Cursor\User\globalStorage\state.vscdb`，SQLite，WAL 模式，本机 12.8 GB。

| 位置 | 内容 |
|---|---|
| 表 `composerHeaders`（570 行） | 每个会话（Cursor 称 composer）一行：`composerId`、`workspaceId`、`createdAt`、`lastUpdatedAt`、`isArchived`、`isSubagent`、`subagentTypeName`、`value`（JSON：`name`、`workspaceIdentifier`、`isDraft`、`unifiedMode` 等） |
| `cursorDiskKV` 键 `composerData:<composerId>` | 会话详情 JSON：`name`（标题）、`status`（`none` / `completed` / `aborted`）、`fullConversationHeadersOnly`（按顺序的气泡列表，每项有 `bubbleId`、`type`、`createdAt`、`startedAtMs`、`completedAtMs`）、`subagentInfo`（子代理才有：`parentComposerId`、`rootParentConversationId`、`toolCallId`、`subagentTypeName`）、`modelConfig.modelName`、`workspaceIdentifier` |
| `cursorDiskKV` 键 `bubbleId:<composerId>:<bubbleId>`（29 万行） | 一条消息或一步（Cursor 称 bubble），见下 |

气泡的形状（抽样 4 万条）：

| 形状 | 占比 | 含义 |
|---|---|---|
| `type=1`，有 `text` | 3% | 用户消息 |
| `type=2`，`capabilityType=15`，有 `toolFormerData` | 57% | 工具调用：`name`、`status`（`completed` / `error` / `loading` / `cancelled`）、`params`、`result`、`toolCallId` |
| `type=2`，`capabilityType=30`，有 `thinking` | 34% | 思考：`thinking.text`、`thinkingDurationMs` |
| `type=2`，有 `text` | 6% | 助手回复 |
| 其他（空） | <1% | 忽略并计数 |

- 时间：几乎所有气泡有 `createdAt`、`startedAtMs`；71% 有 `completedAtMs`；每轮最后一条带 `turnDurationMs`。
- token：每个气泡有 `tokenCount.inputTokens` / `outputTokens`。
- 子代理：派发工具名是 `task_v2`；子代理自己是一个 `isSubagent=1` 的 composer，它的 `subagentInfo.toolCallId` 等于父会话里那次 `task_v2` 的 `toolCallId`。本机 414 个子代理 composer。
- 主会话 156 个，其中归档 113 个；`composerData` 缺失 4 个。
- 工作目录：`workspaceIdentifier.uri.fsPath`（约半数会话有），或 `workspaceId` 对应 `User/workspaceStorage/<id>/workspace.json` 里的 `folder`。
- 数据库的 id 和 `~/.cursor/projects/*/agent-transcripts/<id>` 的目录名一一对应（89/89，子代理 213/214）。

以上字段没有公开文档，是这台机器上这个版本的实际形状。

## 3. 总体方案

沿用 Codex 规格的结构：一个来源（怎么找到数据、数据属于哪个会话）加一个归一化器（记录 → 共用的 `Change` 流），下游全部共用。区别在来源：Cursor 的数据不是只追加的文件，而是一个会被原地修改的数据库，所以新增一种**轮询来源**。

```
state.vscdb ──(只读，按键查询)──> CursorSource（轮询）
                                      │ 气泡 / 会话记录（裁剪后的 JSON）
                                      ▼
                         raw_event（origin = cursor）──> CursorNormalizer ──> Change 流 ──> 现有存储 / API / 页面
Cursor hooks ──> hook-forward ──> POST /hooks?origin=cursor ──┘（只留状态标记，并催一次轮询）
```

关键决定：**读到的记录先存成原始事件，再由归一化器推导**，和另外两个来源一致。这样升级后的重建只读我们自己的库，不需要重新扫 Cursor 的 12.8 GB；Cursor 归档或删掉会话后，已采集的内容仍在。

## 4. 数据模型的改动

- `Origin` 增加 `'cursor'`；`ORIGINS` 顺序为 `claude`、`codex`、`cursor`。`Session.origin`、`Project.origins`、诊断里的按来源统计随之支持。
- 文件键前缀 `cursor:`：`raw_event.file` / `file_offset.file` 用 `cursor:<composerId>`（会话级记录）。
- `Diagnostics` 增加 `cursor: { dbPath, dbExists, lastPollAt, lastError }`。
- `NORMALIZER_VERSION` 递增。

## 5. CursorSource：轮询数据库

### 5.1 打开方式

- 用 better-sqlite3 以 `readonly` 打开，设置 `query_only`、`busy_timeout = 1000`。只做自动提交的短查询（按主键或主键范围），不开显式事务，不写入，不执行 `VACUUM` / `checkpoint`。
- 路径：环境变量 `AGENT_CANVAS_CURSOR_DB`；默认 Windows `%APPDATA%\Cursor\User\globalStorage\state.vscdb`，macOS `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`，Linux `~/.config/Cursor/User/globalStorage/state.vscdb`。空字符串表示关闭。文件不存在时视为没装 Cursor，不轮询、不报错。
- 打开失败、表或列不存在、查询超时：记入诊断的 `lastError`，下个周期重试；不影响其他来源。

### 5.2 轮询周期

每 3 秒一轮（hook 到达时立即对它的会话加一轮，见 7.3）：

1. 读 `composerHeaders` 的全部行的 `composerId, workspaceId, lastUpdatedAt, isArchived, isSubagent, value`（几百行，不读大字段以外的内容）。
2. 选出要处理的 composer：未归档、非草稿的主会话，以及根会话在此列的子代理。和上次记住的 `lastUpdatedAt` 比较，变了的才处理；另外，最近 10 分钟内有过变化的会话每轮都处理（防止流式输出期间 `lastUpdatedAt` 不更新，实现时用真实会话确认后可收紧）。
3. 对每个要处理的 composer：读 `composerData:<id>`，取气泡列表；只读取**需要读的气泡**：上次没见过的、上次见到时还没结束的（没有 `completedAtMs`，或工具状态是 `loading`），以及列表末尾的 20 条。
4. 每条记录裁剪后（见 5.3）算哈希，和上次存的哈希不同才写一条原始事件。

`file_offset` 里为每个 composer 记 `lastUpdatedAt`；每个气泡上次的哈希和是否结束记在内存里，重启后第一轮对每个未归档会话全量读一遍来重建（哈希相同的不会重复入库，靠 `raw_event` 的去重索引）。

首次导入：未归档主会话约 40 个加它们的子代理，逐个处理，在后台进行，页面可用；进度显示在诊断页。

### 5.3 存成什么

两种原始事件，都是 `source: 'transcript'`、`origin: 'cursor'`、`file: 'cursor:<composerId>'`，带 `projectId`、`sessionId`（根会话 id）、`agentId`（主会话为 null，子代理为它的 composerId）：

- `recordType: 'composer'`：会话级信息的裁剪——`composerId`、`name`、`status`、`createdAt`、`lastUpdatedAt`、`modelName`、`unifiedMode`、`subagentInfo`（四个 id 字段和类型名）、气泡 id 的有序列表、工作目录。
- `recordType: 'bubble'`：一个气泡的裁剪——`bubbleId`、`type`、`capabilityType`、`createdAt`、`startedAtMs`、`completedAtMs`、`turnDurationMs`、`text`、`thinking.text`、`thinkingDurationMs`、`tokenCount`、`toolFormerData` 的 `name` / `status` / `toolCallId` / `params` / `result`。`params`、`result`、`text` 各截到 64 KB（和现有的工具输出上限一致）；不存 `toolCallBinary` 和各种编辑器状态字段。

同一个气泡被修改后会产生新的一条原始事件（内容不同、哈希不同）。归一化器按 `bubbleId` 更新同一个节点，所以**后到的版本覆盖先到的**，重放的结果和实时一致。

### 5.4 会话、项目、子代理的归属

- 会话 = 一个非子代理的 composer。子代理 composer 归到 `subagentInfo.rootParentConversationId` 指向的根会话；根会话不在处理范围内（已归档、不存在）时，这个子代理不采集。
- 工作目录按顺序取第一个有的：`composerData.workspaceIdentifier.uri.fsPath` → `composerHeaders.value.workspaceIdentifier.uri.fsPath` → `workspaceStorage/<workspaceId>/workspace.json` 的 `folder`（`file://` URI 转路径）。
- 项目 id：和 Codex 一样，用 Claude 的编码方式（非字母数字换成 `-`）编码工作目录，并复用只有大小写不同的已有项目 id。取不到工作目录时，项目 id 为 `cursor-<workspaceId>`，项目名显示为“Cursor（未知目录）”。
- 归档：会话在某一轮变成 `isArchived = 1`，或从 `composerHeaders` 里消失 → 标记“源文件已删除”，已采集的数据保留，之后不再读它。

## 6. CursorNormalizer：记录 → 图

| 记录 | 结果 |
|---|---|
| `composer` | 建立或更新会话：标题取 `name`（没有时用第一条用户消息的前 60 个字符）；创建时间、最近活动时间；气泡顺序以它的列表为准 |
| 气泡 `type=1` | 提示节点，开始一个新轮次 |
| 气泡 `type=2` 且有 `text` | 文本节点 |
| 气泡 思考 | 思考节点：摘要取 `thinking.text`，时长取 `thinkingDurationMs` |
| 气泡 工具 | 工具节点：名称取 `toolFormerData.name`，摘要取 `params` 里的主要参数；状态 `completed` → 成功，`error` → 失败，`cancelled` → 失败（详情注明“已取消”），`loading` → 执行中 |
| 气泡 工具且 `name = task_v2` | 子代理节点；`toolCallId` 和某个子代理 composer 的 `subagentInfo.toolCallId` 相同时，`childAgentId` 指向它，并加派发边 |
| 子代理 composer 的气泡 | 同样的规则，节点带 `agentId`，显示在派发节点的容器里 |
| 认不出的形状 | 不建节点，按形状计数，显示在诊断页 |

规则：

- **顺序**：同一个 composer 内按 `composer` 记录里的气泡列表顺序连成链；列表里还没有的气泡按 `createdAt` 排在末尾。
- **时间**：节点开始时间取 `startedAtMs`（没有则 `createdAt`），结束时间取 `completedAtMs`；没有 `completedAtMs` 的已完成工具，结束时间取下一个气泡的开始时间。
- **并行**：相邻的几个工具气泡，后一个的开始时间早于前一个的结束时间，视为并行：它们从同一个上游分叉，在下一个非并行的气泡处汇合（和 Codex 的并行规则相同）。
- **轮次结束**：出现带 `turnDurationMs` 的气泡，或下一条用户消息到达。
- **派发节点的状态**：跟着子代理 composer 走——它的最后一个轮次没结束 → 执行中，结束了 → 成功或失败（取 `task_v2` 自己的状态）。找不到对应的子代理 composer 时，用 `task_v2` 气泡自己的状态。
- **会话状态**：`composer.status` 为 `completed` / `aborted` 且最后一个轮次已结束 → 空闲；最后一个轮次没结束（有执行中的工具，或最后一条是用户消息、还没有带 `turnDurationMs` 的气泡）→ 运行中。超过 15 分钟没有活动的“运行中”沿用主规格的“长时间无活动”。Cursor 没有“会话已结束”的概念，只有 hook 的 `sessionEnd` 会把它标为已结束。
- **token**：每个气泡的 `tokenCount` 记到节点上，复盘视角的合计可用。
- 以上都是“当前已读记录的函数”，与记录到达的先后无关；重建结果相同。

未确认、实现时用真实会话核对的两点：流式输出期间 `lastUpdatedAt` 和气泡内容多久落盘一次（决定实际延迟）；正在生成时 `composer.status` 的取值。核对结果写回本文和 README。

## 7. Cursor hooks

### 7.1 安全边界

Cursor 的 hooks 是同步执行的，其中一类“权限 hooks”（`preToolUse`、`beforeShellExecution`、`beforeMCPExecution`、`beforeReadFile`、`subagentStart` 等）在输出不是合法 JSON 时会**阻止动作**。本设计**不安装任何权限 hook**，所以无论转发程序发生什么，都不可能拦住 Cursor 的操作。代价是：Cursor 会话没有“等待权限确认”状态，工具开始执行的时刻靠轮询得到。

### 7.2 安装

`hooks install --cursor` / `hooks uninstall --cursor`，写 `~/.cursor/hooks.json`（`--settings <文件>` 或环境变量 `AGENT_CANVAS_CURSOR_HOOKS_FILE` 可改），文件不存在时新建，`~/.cursor` 不存在时视为没装 Cursor、不做改动。其余行为和现有的安装器一致：写入前列出改动并询问、先备份、只追加、只移除本安装本端口的条目、遇到不寻常的文件拒绝写入。

安装 5 个事件，都是观察类：

| 事件 | 用途 |
|---|---|
| `sessionStart` | 会话存在、恢复 |
| `beforeSubmitPrompt` | 一轮开始 → 运行中 |
| `stop` | 一轮结束 → 空闲 |
| `subagentStop` | 催一次轮询 |
| `sessionEnd` | 会话已结束 |

每条的形状：`{ "command": "<转发命令>", "timeout": 5 }`。Windows 上 Cursor 用 PowerShell 执行命令，所以命令写成 `& "<node 绝对路径>" "<cli.js 绝对路径>" hook-forward --origin cursor --port <n>`；其他平台是带引号的普通命令行。Cursor 监视 `hooks.json`，保存后自动生效，不需要像 Codex 那样确认信任。

### 7.3 转发与效果

- `hook-forward --origin cursor`：和现有行为一样读 stdin、POST 到本机、1 秒超时、永远退出码 0、不读写文件。唯一的不同：事件是 `beforeSubmitPrompt` 时向 stdout 输出 `{"continue":true}`（明确放行），其他事件不输出。
- 这些 hook 是同步的：每次触发 Cursor 会等转发命令结束（约 0.25 秒，服务无响应时最多约 1.3 秒）。5 个事件每轮各触发至多一次，所以每轮对话多等不到 1 秒；这也是不装 `postToolUse` 之类每步触发的事件的原因。
- 服务端 `POST /hooks?origin=cursor`：存为原始事件；`conversation_id` 是会话 id。效果和 Codex hooks 第一版相同——**不建、不改节点**，只留会话级标记（开始运行、停止、已结束），由归一化器和数据库里的记录一起算出会话状态；另外立即对这个会话加一轮轮询。
- 没见过的会话收到 hook：记下标记，等轮询读到这个会话后生效（不靠 hook 建会话，因为会话的项目归属只有数据库知道）。

## 8. 页面

- 来源标记增加 Cursor（卡片、搜索结果、会话页标题栏）；首页筛选增加“Cursor”一项。
- 诊断页增加 Cursor 一栏：数据库路径、是否存在、上次轮询时间、上次错误、hooks 按事件的计数、未识别的气泡形状。
- 画布、瀑布图、复盘不需要改。

## 9. 错误处理与限制

- 数据库被 Cursor 独占锁住、正在迁移、文件损坏：本轮跳过，记诊断，下轮重试。
- 单个会话读取或解析失败：只影响这个会话，记入“导入失败”，其他会话照常。
- 气泡 JSON 解析失败或形状不认识：跳过并计数，不中断。
- 已知限制（写入 README）：库的格式没有公开文档，Cursor 升级后可能需要跟着改；没有“等待权限确认”；延迟取决于 Cursor 多久把内容写进库；思考内容只有 Cursor 存下来的那部分文本；归档会话不导入。

## 10. 测试

- 归一化器：合成的 `composer` / `bubble` 记录（形状照本机的真实结构，内容虚构）覆盖第 6 节的每条规则，包括气泡被修改后重放结果相同、子代理先于或晚于父会话到达、并行工具、认不出的形状。
- 来源：测试里用 better-sqlite3 建一个同样表结构的临时库，写入合成数据，验证选会话、增量读取、归档、工作目录的三级回退、库不存在或缺表时不报错。
- 端到端：三个来源放在一个临时环境里，重建前后结果一致。
- hooks：安装器对临时文件的各种情况；转发程序对 `beforeSubmitPrompt` 的输出和其余事件的静默。
- 约束不变：测试和手动运行都不读写真实的 `~/.cursor/hooks.json`；真实数据库只在验收时只读打开，只看结构和计数。

## 11. 里程碑

1. **来源维度**：`Origin` 加 `cursor`，文件键前缀，轮询来源的接口，配置项。
2. **CursorSource**：读库、选会话、增量、裁剪、归属。
3. **CursorNormalizer**：第 6 节的映射。
4. **页面**：来源标记、筛选、诊断。
5. **hooks**：安装器、转发、服务端标记与催轮询。
6. **验收**：在真实的库上只读试跑（独立数据目录），核对计数和几个会话的画布；用一个真实的 Cursor 会话核对第 6 节末尾的两点和 hooks；更新 README 和使用手册。

## 12. 实现修订（2026-11-12）

在真实数据库上只读试跑三次后，对正文做了以下修订。

### 12.1 关于数据库的补充事实

- **步骤清单有两种存放位置**。较早的会话放在 `composerData.fullConversationHeadersOnly`；较新的会话这个字段为空，清单分页存在 `composerConvHeaders:<composerId>:<六位页号>`，每页最多 256 项，项的形状相同。气泡本身的形状没有区别。本机 11 个有内容的未归档会话里 6 个是分页的。
- **多数未归档会话是空的**（43 个里 28 个）：没有任何气泡，也没有名字。
- **`rootParentConversationId` 不能用来判断子代理属于谁**。从同一个会话分叉出来的会话共用同一批子代理，这个字段只指向其中一个。可靠的是父会话的 `composerData.subagentComposerIds` 和子代理的 `subagentInfo.parentComposerId`。
- **分叉出来的会话有时被标成子代理**，里面带着父会话的 `task_v2` 调用的副本（同样的 `toolCallId`）。
- **约五分之一的“用户消息”其实是 Cursor 注入的系统通知**：文本以 `<timestamp>…</timestamp><system_notification>` 或 `<system_notification>` 开头，是后台任务结束时插入的。
- 会话很长：最大的主会话 1.75 万步，连同子代理一个会话有 3.9 万个节点；全部 11 个会话共约 17 万个节点。

### 12.2 记录格式（替代 5.3）

- `composer` 记录只放变化慢的事实：`composerId`、`name`、`status`、`createdAt`、`modelName`、`unifiedMode`、`cwd`、`subagentInfo`。不带步骤清单，不带 `lastUpdatedAt`。
- 每条 `bubble` 记录带 `order`：它在会话步骤清单里的序号。序号变了，这条记录重新存一次。
- 存储键：主会话 `cursor:<composerId>`；子代理 `cursor:<所属会话 id>/<子代理 composerId>`，被多个会话共用的子代理每个会话各存一份。

### 12.3 读取（修订 5.2、5.4）

- 步骤清单：内嵌的非空就用内嵌的，否则用一次主键范围查询读分页清单。
- 没有任何气泡的会话不产生任何记录，也不成为会话。
- 子代理归属：从每个入选会话的 `subagentComposerIds` 出发，沿 `subagentComposerIds` / `parentComposerId` 逐层找；`rootParentConversationId` 只在两者都没有时兜底。
- 重启：每个会话完整读完后，把当时的 `lastUpdatedAt` 记在 `meta` 表（`poll:<键>`）；重启后这个值没变的会话不再读。正文里“记在 `file_offset`”不再适用。
- 出错：数据库级错误（被占用、损坏、表不存在）或连续 3 次查询失败，整轮放弃，下轮重试；读取过程中定期让出，不长时间占用服务。

### 12.4 归一化（修订第 6 节）

- 图的变更新增 `edge_removed`（三个来源共用的模型、存储和页面都支持）：一个气泡的新版本让之前推导出的连线不再成立时，旧连线被撤掉。
- 系统通知气泡是系统节点（子类型 `task_notification`），不另起一轮；标题回退时跳过。
- 终端命令：状态为完成但退出码不为 0 → 失败；结果里 `rejected: true` → 已拒绝。
- 会话的 `status` 为 `aborted` 时，最后一轮里仍在执行的工具记为失败（已中止），这一轮算结束。
- 并行判断用节点实际采用的结束时间（没有 `completedAtMs` 的已结束调用，结束于下一个气泡开始时）。
- 派发节点：父轮次已结束而子代理无法表明自己结束时，取 `task_v2` 调用自己的状态。对同一个子代理的再次唤起不带 `childAgentId`（一个子代理只有一个容器）。
- 另一个关联途径：`task_v2` 的结果里的 `agentId`，在 `toolCallId` 对不上时使用。

### 12.5 hooks（修订第 7 节）

- `sessionStart` 只表示“会话恢复”（清除已结束标记），不表示开始运行；`beforeSubmitPrompt` 才是开始运行。
- 比所有气泡都新的 `stop` 标记使会话为空闲，即使记录看起来还没结束。
- 存下来的 hook 内容去掉 `user_email`；载荷有大小上限。
- 子代理会话的 hook 归到它所属的会话（分叉时每个所属会话都催一次轮询）。

### 12.6 仍未用真实的 Cursor 确认的

- 流式输出期间 Cursor 多久把内容写进数据库（决定不装 hooks 时的实际延迟）。
- 正在生成时 `composerData.status` 的取值。
- hooks：载荷字段、Windows 上 PowerShell 的调用方式、hook 命令本身失败时 Cursor 是否照常继续。
