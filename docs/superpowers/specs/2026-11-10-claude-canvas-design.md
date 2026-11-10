# claude-canvas 设计规格

- 日期：2026-11-10
- 状态：待评审

## 1. 目标

Claude Code 执行任务时，过程对使用者不透明。claude-canvas 是一个本地常驻服务，提供一个固定地址的网页，使用者在页面上选择项目和会话，以画布（节点图）的形式查看该会话的执行进程。

要满足四类需求，优先级从高到低：

| 代号 | 需求 | 说明 |
|---|---|---|
| A | 实时监控 | 当前跑到哪一步、调了什么工具、卡在哪里 |
| C | 多代理拓扑 | 谁派发了谁、并行关系、各自进度 |
| B | 推理因果链 | 还原思考到决策到行动的链条 |
| D | 事后复盘 | 回放、定位哪一步走偏、耗时和 token 统计 |

A 是第一优先级。C、B、D 的先后是实现顺序，不代表重要性。

### 成功标准

- 打开固定地址，能看到本机所有 Claude Code 项目及其会话，会话的运行状态在列表里直接可见。
- 进入一个正在运行的会话，画布随执行实时更新；工具开始执行、等待权限确认这两个状态在 hooks 已安装时延迟不超过 1 秒。
- 服务未启动或 hooks 未安装时，Claude Code 自身的行为和速度不受影响。
- Claude Code 升级导致 transcript 格式变化时，服务不崩溃，已有数据不丢，诊断页能看到哪些记录没被识别。
- 源 transcript 文件被 Claude Code 清理后，已采集的会话仍可复盘。

### 不做

- 不从页面反向控制 Claude Code（暂停、批准权限、发消息）。只读。
- 不做多用户、鉴权、远程访问。服务只监听 `127.0.0.1`。
- 不支持 Claude Code 之外的工具。
- 不做开机自启。

## 2. 数据源

不修改 Claude Code，只做旁路采集。两路数据都是正式组成部分。

### 2.1 Transcript JSONL

位置：`~/.claude/projects/<项目目录名>/<session_id>.jsonl`，每个会话一个文件，执行过程中持续追加。

2026-11-10 在本机实测确认的结构：

- 对话记录（`user`、`assistant`、`system`、`attachment`）带 `uuid`、`parentUuid`、`timestamp`、`sessionId`、`cwd`、`gitBranch`、`isSidechain`、`version`。
- `assistant` 记录的 `message.content` 是内容块数组，块类型包括 `thinking`、`text`、`tool_use`；记录上有 `thinkingDurationMs`、`thinkingDisplay`、`requestedModel`。
- `user` 记录可带 `toolUseResult` 和 `sourceToolAssistantUUID`、`promptId`、`permissionDecision`。
- 另有多种无文档的内部记录类型，例如 `queue-operation`、`file-history-snapshot`、`api-request`、`api-request-shape`、`api-request-blob`、`tools-used`、`relocated`、`atis-latch`。

这个格式不是官方稳定契约。解析必须对未知类型和缺失字段容错（见第 8 节）。

同日进一步实测确认：

- 每条 `assistant` 记录只含一个内容块。同一次 API 响应的多个块拆成多条记录，共享 `message.id`。并行工具调用表现为多条共享 `message.id` 的 `tool_use` 记录。实现不依赖这一点：一条记录有多个块时逐块处理（见 4.4）。
- `assistant` 记录的 `message.stop_reason` 可用（`tool_use`、`end_turn` 等），`message.usage` 含 `input_tokens`、`output_tokens` 及缓存相关字段。
- `user` 记录的 `message.content` 要么是字符串（用户输入），要么是 `tool_result` 块数组。并非所有 `user` 记录都是用户输入，见 4.3 的会话状态规则。
- 子代理的记录写在独立文件 `<项目目录>/<session_id>/subagents/agent-<agentId>.jsonl`，每条带 `agentId` 和 `isSidechain: true`，`sessionId` 与主会话相同。同目录的 `agent-<agentId>.meta.json` 含 `toolUseId`（指向主线派发它的 `tool_use`）、`agentType`、`description`、`spawnDepth`、`finished`。主线对应的工具结果记录里 `toolUseResult.agentId` 也给出同一关联。
- 会话标题在 `<项目目录>/<session_id>/custom-title.json` 的 `customTitle` 字段。
- **思考内容在抽查的会话里是空的**：`thinking` 块只有 `signature`，`thinking` 文本长度为 0（该会话 `thinkingDisplay` 为 `updates`）。能拿到的只有思考的存在和耗时 `thinkingDurationMs`。其他配置下是否有文本未验证。这是数据源的上限：因果视角（B）在思考文本为空时只能展示"此处思考了多久"以及前后的文本和工具调用，不能展示思考内容。

### 2.2 Hooks

通过 `~/.claude/settings.json` 配置 `type: "http"` 的 hooks，把事件 POST 到本服务。

依据官方文档（https://code.claude.com/docs/en/hooks ，2026-11-10 查阅）确认的事实：

- 所有事件的通用入参：`session_id`、`prompt_id`、`transcript_path`、`cwd`、`hook_event_name`，部分事件有 `permission_mode`；在子代理内触发时带 `agent_id`、`agent_type`。
- HTTP hook 在连接失败、非 2xx、超时时默认是非阻塞错误（`onFailure` 默认 `continue`），Claude Code 照常继续。
- HTTP hook 是同步的，没有后台模式，默认超时 600 秒。

订阅的事件及其关键字段：

| 事件 | 关键字段 | 用途 |
|---|---|---|
| `SessionStart` | `source` | 会话开始或恢复 |
| `UserPromptSubmit` | `prompt` | 新轮次开始，会话进入运行中 |
| `PreToolUse` | `tool_name`、`tool_input`、`tool_use_id` | 工具节点进入"执行中" |
| `PermissionRequest` | `tool_name`、`tool_input`（**没有** `tool_use_id`） | 工具节点进入"等待权限确认" |
| `PermissionDenied` | `tool_use_id`、`reason` | 工具节点"被拒绝" |
| `PostToolUse` | `tool_use_id`、`tool_response`、`duration_ms` | 工具节点"成功" |
| `PostToolUseFailure` | `tool_use_id`、`error`、`is_interrupt` | 工具节点"失败" |
| `SubagentStart` | `agent_id`、`agent_type` | 子代理节点"执行中" |
| `SubagentStop` | `agent_id`、`agent_type`、`agent_transcript_path`、`last_assistant_message` | 子代理节点结束 |
| `Notification` | `message`、`notification_type`（`permission_prompt`、`idle_prompt` 等） | 会话"等待输入" |
| `Stop` | `last_assistant_message`、`stop_hook_active` | 轮次结束，会话进入空闲 |
| `StopFailure` | `error`、`last_assistant_message` | 轮次因错误结束 |
| `PreCompact` / `PostCompact` | `trigger`；后者另有 `compact_summary` | 压缩系统事件 |
| `SessionEnd` | `reason` | 会话结束 |

以上字段来自文档。里程碑 1 的验收环节会装上 hooks 录制真实载荷，与本表核对。

hooks 里没有"权限已批准、开始执行"的独立事件：`PreToolUse` 在权限检查之前触发，批准之后直到 `PostToolUse` 之间没有事件。因此一个工具节点一旦进入"等待权限确认"，会保持该状态直到出结果。

约束带来的两条设计要求：

- 每个 hook 配置显式设 `timeout: 2`（秒），不设 `onFailure`。
- 服务端的 hook 接收端点收到请求后立即返回 `200` 和空响应体，处理放到应答之后。空响应体在文档中定义为成功且不影响 Claude Code 的决策。

## 3. 总体架构

```
 Claude Code（CLI / 桌面端 / IDE）
     │ 写文件                    │ HTTP hooks
     ▼                           ▼
 ~/.claude/projects/*.jsonl   POST /hooks
     │                           │
 ┌───┴───────────────────────────┴────────┐
 │ 采集层  TranscriptSource   HookSource   │
 │ 归一层  统一事件模型 + 两平面对齐         │
 │ 存储层  SQLite（原始记录 + 派生图）       │
 │ 接口层  REST 快照 + WebSocket 增量      │
 └────────────────────┬───────────────────┘
                      ▼
      固定地址的网页：项目 → 会话 → 画布
```

### 3.1 两个平面

两路数据不描述同一件事，因此不需要去重：

| 平面 | 来源 | 负责什么 | 性质 |
|---|---|---|---|
| 内容平面 | JSONL | 图里有哪些节点和边，节点的内容 | 权威、可重放 |
| 状态平面 | hooks | 节点和会话此刻的状态 | 实时、低延迟 |

对齐规则：

1. 带 `tool_use_id` 的 hook 事件，按 `(session_id, tool_use_id)` 对到工具节点。
2. `PermissionRequest` 没有 `tool_use_id`：在同一 `session_id`、同一 `agent_id`（主线为空）下，找状态为"执行中"且 `tool_name` 和 `tool_input` 相同的最新工具节点。找不到时把会话状态置为"等待权限确认"，不绑定到具体节点。
3. hook 先到而内容平面还没有对应节点时，创建占位节点，标记 `confirmed: false`。JSONL 记录到达后填入内容并置 `confirmed: true`，节点 id 不变。
4. 内容平面与状态平面冲突时（例如 JSONL 里已经有工具结果，但没收到 `PostToolUse`），以内容平面为准推导终态。具体地：由 hook（`PostToolUse`、`PostToolUseFailure`、`SubagentStop`）设出的“成功/失败”，会被之后到达的 `tool_result` 纠正（`is_error` 为真则失败，否则成功）；来自 `tool_result` 的终态是最终的，之后的 hook 和重复的 `tool_result` 都不再改变它；“被拒绝”永远不被 `tool_result` 改写。`tool_result` 的内容总会写入节点的 `output`。终态来源只记在归一器内存里，按原始事件顺序重放可得到相同结果。
5. hooks 未安装或事件丢失时，状态完全由内容平面推断：有 `tool_use` 无结果为"执行中"，有结果按结果判成功或失败。"等待权限确认"在这种情况下无法区分，显示为"执行中"。

## 4. 统一事件模型

### 4.1 层级

```
项目（transcript 所在目录名，即 ~/.claude/projects 下的目录名）
└─ 会话（session_id）
   └─ 轮次（一次用户 prompt 到 Claude 停下，以 prompt_id 标识）
      └─ 节点
         └─ 子代理（agent_id，内部是又一串节点）
```

轮次没有单独的表：节点上的 `turnId` 就是它所属轮次的 `promptId`（缺失时取 prompt 记录的 uuid）。

### 4.2 节点

| 类型 | 内容来源 | 字段要点 |
|---|---|---|
| `prompt` | JSONL | 文本 |
| `thinking` | JSONL | 文本、耗时 |
| `text` | JSONL | 文本 |
| `tool` | JSONL + hooks | 工具名、入参、结果、耗时、状态 |
| `subagent` | JSONL + hooks | 代理类型、任务描述、状态、内部节点 |
| `system` | 两路 | 子类型：压缩（`compact`）、用户中断（`interrupt`）；模型切换、hook 报错、会话开始、会话结束留待后续 |
| `unknown` | JSONL | 无法解析的对话记录，保留原始内容 |

所有节点共有：`id`、`sessionId`、`turnId`、`agentId`（主线为空）、`parentId`、`timestamp`、`confirmed`、`usage`（token 用量，有则填）。

### 4.3 状态

工具和子代理节点：

```
执行中 → （等待权限确认） → 成功 | 失败 | 被拒绝
```

终态不回退：节点进入成功、失败、被拒绝之后，迟到的状态事件一律忽略。唯一例外是 3.1 规则 4：hook 设出的成功/失败会被 `tool_result` 纠正。

会话：`运行中`、`等待输入`、`等待权限确认`、`空闲`、`已结束`，另有附加标记`源文件已删除`（可与任何状态并存）。

会话状态的推导规则：

- hook：`UserPromptSubmit`、`PreToolUse`、`PermissionDenied`、`PostToolUse*` → 运行中；`PermissionRequest`、`Notification(permission_prompt)` → 等待权限确认；`Notification(idle_prompt)` → 等待输入；`SessionStart`、`Stop`、`StopFailure` → 空闲；`SessionEnd` → 已结束（之后只有 `SessionStart`、`UserPromptSubmit` 能把它带回）。
- transcript（只看主线，子代理记录不改会话状态）：用户 prompt → 运行中；`assistant` 记录的 `stop_reason` 为 `end_turn` → 空闲，其他值（含缺失）→ 运行中（“有活动即运行中”，轮次不一定以可识别的 prompt 开始）。
- 不是用户输入的 `user` 记录：文本（字符串内容，或数组中各 `text` 块的拼接）去掉开头空白后以 `[Request interrupted by user` 开头的是中断标记，产生 `system`/`interrupt` 节点（标题 `Interrupted`），不开启新轮次，主线上把会话置为空闲；以 `<local-command-stdout>`、`<local-command-stderr>`、`<command-name>`、`<command-message>`、`<command-args>`、`<bash-input>`、`<bash-stdout>`、`<bash-stderr>`、`<task-notification>`、`<system-reminder>` 开头的，以及 `isCompactSummary` 为真的，不产生节点、不改状态，只保持父链。这份前缀清单待验收时用真实数据核对。
- 时间顺序（`statusAt`）：会话记住最近一次状态观测的事件时间（transcript 的 `timestamp` 或 hook 的接收时间）；事件时间早于它的 transcript 记录不改变状态（迟到的记录不覆盖较新的状态）。
- `长时间无活动`（stale）是派生的显示状态，不存储：存储的状态为运行中且最近活动距今超过 15 分钟时显示为它。等待权限确认、等待输入不会降级（它们本来就在等用户）。首页的活跃会话数不计 stale 会话；页面至少每分钟重新计算一次。

### 4.4 边

| 类型 | 含义 | 来源 |
|---|---|---|
| 顺序边 | 同一轮次内的因果先后 | `parentUuid` 链 |
| 并行分叉 | 一条助手消息里同时发出多个工具调用，从同一点分叉，结果到齐后汇合 | 共享 `message.id` 的多个 `tool_use` 块（多条记录或同一记录） |
| 派发边 | 主线的子代理节点连到其内部第一个节点 | 子代理关联字段 |

一条 `assistant` 记录的多个内容块按顺序各成节点：第 0 块的 id 是记录 uuid，第 i 块（i ≥ 1，按 `content` 数组下标）是 `<uuid>#<i>`，`tool_use` 块始终是 `tool:<tool_use_id>`。第 i 块的父节点是第 i−1 块的节点（`tool_use` 仍按并行批次规则分叉）。不认识的块类型跳过；一个可识别块都没有的记录仍是 `unknown` 节点。

## 5. 存储

SQLite，单文件，WAL 模式，位置 `~/.claude-canvas/data.db`。WAL 检查点由独立的工作线程（单独的连接，`PASSIVE`）每秒做一次，主连接关闭自动检查点，避免导入期间事件循环被检查点卡住。

| 表 | 内容 |
|---|---|
| `raw_event` | 两路原始记录共用一张表，自增主键即采集顺序，重建时按它重放。JSONL 行：来源文件（相对 projects 目录的路径，`/` 分隔）、字节偏移、原文、记录类型；hook：接收时间、事件名、原文，以及 `project_id`（入库时由载荷的 `transcript_path` 推出，推不出为空） |
| `file_offset` | 每个文件（同样是相对路径）已读到的字节偏移和文件大小 |
| `session` / `node` / `node_detail` / `edge` | 派生图。`node` 只存节点本体；完整入参、输出、文本在 `node_detail`，不带详情的节点更新不读写它 |
| `change_log` | 带 `seq` 的派生变更，不含节点详情；同一批写入里每个会话只记最后一次会话变更；最多保留 20 万行，超出时删到 90% |
| `unknown_stat` | 未识别记录类型的计数和一条样例 |
| `meta` | 键值表：`epoch`（建库时生成的随机 id）、`last_hook_at`、`normalizer_version`、`rebuild_in_progress` |

没有单独的 `turn` 表（见 4.1）；项目以 transcript 所在目录名为键。

原则：

- 原始记录原样保存，派生表可以整体删除后由原始表重建。CLI 提供重建命令。
- 原始记录里的路径相对 projects 目录：移动该目录、盘符或大小写变化都不会让历史失联或被重复导入；重放只从存储的相对路径（hook 用存储的 `project_id`）推出项目，不看当前配置。
- 自己保存原始记录，而不是只引用源文件，因为 Claude Code 会定期清理旧 transcript。
- 每条派生变更带全局递增的序号 `seq`，用于增量推送和断线续传；重建清空变更日志但 `seq` 不回退。
- 每个读取片段（原始行、未识别统计、派生变更、偏移）在一个事务里写入；hook 和 meta 的写入同样。进程中途被杀时，一个片段要么全部在库里，要么全不在。
- 归一化规则有版本号 `NORMALIZER_VERSION`，`meta` 记录派生表是用哪个版本建的。`start` 发现版本不同，或上次重建没完成（`rebuild_in_progress` 仍在），会在监听前先重建并打印原因；全新的空库只记下当前版本。
- 重建逐个会话进行：分页重放该会话的原始记录，提交该会话自己的事务，释放内存再处理下一个，内存峰值只取决于最大的单个会话；`unknown_stat` 一并重新统计。
- `start` 与 `rebuild` 共用锁文件 `<数据目录>/claude-canvas.lock`（pid 和启动时间）：持有者还活着时以退出码 1 退出并给出它的 pid；持有者已不存在时接管。正常退出时释放。

## 6. 接口

REST：

| 路径 | 返回 |
|---|---|
| `GET /api/projects` | 项目列表，含各自的会话数和活跃会话数 |
| `GET /api/projects/:id/sessions` | 会话列表，含状态、开始时间、最近活动时间、标题、分支 |
| `GET /api/sessions/:id/graph` | 该会话的完整图快照和快照对应的 `seq` |
| `GET /api/sessions/:id/nodes/:nodeId` | 节点完整内容（工具的完整入参和输出） |
| `GET /api/diagnostics` | 未识别记录统计、最近一次 hook 时间、各文件读取进度、导入失败（文件、错误、时间）、是否正在导入、归一化版本、数据库 epoch |
| `POST /hooks` | 接收 hook 事件，立即返回空响应 |

图快照里的节点只带摘要（文本截断到固定长度），完整内容按需取，避免长会话的快照过大。

WebSocket `/ws`：

- 连接打开后服务端先发 `{type:'hello', epoch}`。客户端重连后若 epoch 变了（数据库被换掉），按 resync 处理。
- 客户端订阅会话列表，或某个会话并带上已持有的 `seq`。若 `seq` 早于变更日志保留的最小 seq，或需要补发的变更超过 5000 条，服务端发 `{type:'resync', sessionId}`，客户端重新取快照；否则先分块补发（每条消息最多 1000 个变更），再持续推送。
- 变更类型为节点新增、节点更新、边新增、会话状态变化。节点详情从不经 WebSocket 发送，按需走 REST。
- 发送缓冲超过 16 MB 的连接被断开（客户端会重连并 resync）。
- 取快照期间到达的变更由客户端暂存，快照到后只应用 seq 大于快照 seq 的部分。

请求校验（服务无认证）：`Host` 必须是回环地址；带 `Origin` 时也必须是回环地址；带 `Sec-Fetch-Site: cross-site` 的请求一律拒绝。不满足时返回 403，`/hooks` 仍返回空的 200 但不采纳内容。所有响应带 `X-Content-Type-Options: nosniff`，页面 HTML 带 Content-Security-Policy（只允许同源脚本和到本机的 WebSocket）。

## 7. 前端

### 7.1 页面

- **首页**：左侧项目列表，右侧所选项目的会话列表。会话行显示状态、标题、分支、最近活动时间，状态实时更新。
- **会话页**：画布占主体；顶部切换视角；右侧抽屉显示选中节点的完整内容。
- **诊断页**：第 6 节 `diagnostics` 的内容。

### 7.2 画布

- 自上而下的分层布局，自动计算位置，不要求使用者手动摆放。
- 节点状态用固定颜色区分，执行中的节点有动效。
- 长会话默认只展开最近若干轮次，更早的轮次折叠为摘要节点（prompt 首句、工具调用数、耗时），点击展开。
- 子代理是可展开的容器节点。

### 7.3 四个视角

同一份图的四种显示方式，不是四张画布：

| 视角 | 做法 |
|---|---|
| 实时（默认） | 自动跟随最新节点；思考节点折叠；突出执行中的节点。使用者手动平移或缩放后停止跟随，提供"回到最新"按钮 |
| 拓扑 | 子代理全部折叠为单节点，隐藏思考和文本，只留派发关系、并行关系和状态 |
| 因果 | 思考和文本节点展开；选中一个工具节点时高亮它上游的思考和文本链 |
| 复盘 | 底部出现时间轴，拖动后画布只显示该时刻之前的节点及当时的状态；节点上叠加耗时和 token 用量 |

## 8. 容错

| 情况 | 处理 |
|---|---|
| 不认识的 JSONL 记录类型 | 存入原始表，不派生，计入 `unknown_stat`；不报错不中断 |
| 对话记录字段缺失或结构变化 | 该条派生为 `unknown` 节点并保留原始内容，其余照常 |
| 读到写了一半的行（不以换行结尾） | 不推进偏移，但记下文件大小，文件再次变化后重读 |
| 文件比已记录偏移短（被截断或重写） | 该文件偏移归零重读，按原始行内容去重 |
| 服务重启 | 从 `file_offset` 续读；重启期间丢失的 hook 状态按 3.1 节规则 5 由内容平面推断 |
| hook 先到而 JSONL 记录迟迟不来 | 占位节点保留并显示为"未确认"，不删除 |
| 源 transcript 文件被删除 | 已入库数据不变，会话加"源文件已删除"标记 |
| hook 载荷无法解析 | 存入 `raw_event`，计入诊断，仍返回 `200` |
| 文件读不了、写库失败 | 该片段整体回滚；记入诊断的导入失败，并写一行到 stderr（只含路径和错误信息，同一文件每分钟最多一行）；下次扫描重试 |

扫描节奏：chokidar 监听之外，每 `rescanMs`（3 秒）只检查“热”会话（最近 `evictAfterMs` 内被处理过的）的文件和导入失败过的文件；每 `fullScanMs`（60 秒）做一次完整的目录列举，补上 chokidar 漏掉的新文件，并用同一份列举判断源文件是否被删除。

内存：久未处理的会话会从归一器内存中淘汰，再有事件时从原始记录分页（每页最多 200 行或约 256 KB）重放恢复；状态为运行中、等待权限确认、等待输入且 15 分钟内有活动的会话不淘汰。

## 9. 模块划分

单仓库，全栈 TypeScript。

| 模块 | 职责 | 依赖 |
|---|---|---|
| `shared` | 统一事件模型和接口的类型定义 | 无 |
| `server/sources/transcript` | 监听目录、按偏移增量读取、输出原始行 | 文件系统 |
| `server/sources/hooks` | 接收 POST、立即应答、输出原始事件 | 无 |
| `server/normalize` | 原始记录转统一事件；两平面对齐规则 | `shared` |
| `server/store` | SQLite 读写、`seq` 分配、重建 | `shared` |
| `server/api` | REST 和 WebSocket | `store` |
| `web` | 页面、画布、四个视角 | `shared` |
| `cli` | 启动服务、安装和卸载 hooks、重建派生数据 | `server` |

`normalize` 是纯函数：输入原始记录和当前图状态，输出变更列表，不接触文件和数据库。格式变化的风险集中在这一个模块。

技术选型：

| 用途 | 选型 |
|---|---|
| 服务框架 | Fastify |
| 数据库 | SQLite（better-sqlite3） |
| 文件监听 | chokidar |
| 前端 | React + Vite |
| 画布 | React Flow |
| 自动布局 | elkjs |
| 包管理 | pnpm workspace |
| 测试 | Vitest；端到端用 Playwright |

## 10. 安装与运行

- `claude-canvas start`：启动服务，默认地址 `http://127.0.0.1:4317`，端口可用参数覆盖。
- `claude-canvas hooks install`：向 `~/.claude/settings.json` 追加本项目的 hooks。写入前打印将要添加的内容并要求确认；只追加，不改动已有 hooks；写入前备份原文件。
- `claude-canvas hooks uninstall`：只移除指向本服务地址的 hooks。
- `claude-canvas rebuild`：由原始表重建派生表，向 stderr 打印进度。与 `start` 互斥（锁文件，见第 5 节）。

首次启动时，服务对 `~/.claude/projects/` 下已有的全部 transcript 做一次全量导入，之后转为增量。升级后归一化版本变化时，`start` 会先自动重建。

## 11. 测试

| 对象 | 方法 |
|---|---|
| `normalize` | 测试重心。用脱敏的真实 JSONL 片段做夹具，覆盖：单工具调用、并行工具调用、子代理、压缩、工具失败、权限拒绝、未知记录类型、字段缺失 |
| 两平面对齐 | 构造四种时序：hook 先到、JSONL 先到、只有 hook、只有 JSONL；另测 `PermissionRequest` 的匹配和匹配不到的回退 |
| `transcript` 源 | 半行、文件截断、文件删除、重启续读 |
| `store` | 重建后的派生表与增量构建的结果一致 |
| 端到端 | 把录制的会话（JSONL 追加序列加 hook 序列）回放给服务，断言 WebSocket 收到的变更和最终快照 |
| 画布 | 在浏览器里实测布局、跟随、折叠、四个视角；不为界面写大量单元测试 |

夹具来自真实会话，入库前必须脱敏：替换路径、用户名、对话文本和工具输出，只保留结构。

## 12. 里程碑

每一步都可独立使用，且都是最终架构的一部分。

1. **管线打通**：两个事件源、归一、入库、接口；页面能浏览项目和会话，以简单列表显示节点；验收时录制真实 hook 载荷与 2.2 节表格核对。目的是验证数据正确。
2. **实时画布（A）**：节点和边渲染、状态和动效、自动跟随、长会话折叠、节点详情抽屉。
3. **子代理拓扑（C）**：容器节点、展开折叠、拓扑视角。
4. **因果视角（B）**：思考节点、上游链高亮。
5. **复盘（D）**：时间轴回放、耗时和 token 叠加、首页的历史会话检索。
6. **诊断与安装**：诊断页、hooks 安装卸载命令的备份和确认流程。

里程碑 1 中的 hooks 录制需要先手动配置一条临时 hook；正式的安装命令在里程碑 6 完成，在此之前按 README 手动配置。

## 13. 风险

| 风险 | 应对 |
|---|---|
| transcript 格式随 Claude Code 版本变化 | 原始记录保留、派生可重建、未知类型计数并在诊断页可见、`normalize` 集中且以夹具覆盖 |
| hook 给 Claude Code 增加延迟 | 2 秒超时、端点先应答后处理；在里程碑 1 实测单次 hook 往返耗时 |
| 长会话节点数过多，画布卡顿 | 轮次折叠、快照只带摘要、子代理默认折叠；里程碑 2 用本机最大的真实会话验证 |
| 思考文本在 transcript 里可能为空（已在一个会话中观察到） | 思考节点始终保留并显示耗时；有文本则显示文本。里程碑 4 开始前抽查更多会话和配置，确认是否存在能拿到思考文本的条件 |
| transcript 含代码和对话等敏感内容 | 只监听回环地址；数据库在用户目录下；测试夹具脱敏后才能入库 |
