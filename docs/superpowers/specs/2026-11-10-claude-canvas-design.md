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

尚未确认、在里程碑 1 开头用真实数据确认的事项：

- 思考块里是完整原文还是摘要，`thinkingDisplay` 的取值含义。
- 子代理的记录是写在主会话文件里（`isSidechain: true`）还是独立文件，以及它与主线 `tool_use` 的关联字段。

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
| `PreToolUse` | `tool_name`、`tool_input`、`tool_use_id` | 工具节点进入"排队" |
| `PermissionRequest` | `tool_name`、`tool_input`（**没有** `tool_use_id`） | 工具节点进入"等待权限确认" |
| `PermissionDenied` | `tool_use_id`、`reason` | 工具节点"被拒绝" |
| `PostToolUse` | `tool_use_id`、`tool_response`、`duration_ms` | 工具节点"成功" |
| `PostToolUseFailure` | `tool_use_id`、`error`、`is_interrupt` | 工具节点"失败" |
| `SubagentStart` / `SubagentStop` | 待确认 | 子代理节点状态 |
| `Notification` | `message`、`notification_type` | 会话"等待输入"等状态 |
| `Stop` / `StopFailure` | 待确认 | 轮次结束，会话进入空闲 |
| `PreCompact` / `PostCompact` | 待确认 | 压缩系统事件 |
| `SessionEnd` | 待确认 | 会话结束 |

标"待确认"的事件，文档对应章节在调研时未读到。里程碑 1 的第一项工作是装上 hooks 录制一份真实载荷，据此补全本表并作为测试夹具。

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
2. `PermissionRequest` 没有 `tool_use_id`：在同一 `session_id`、同一 `agent_id`（主线为空）下，找状态为"排队"且 `tool_name` 和 `tool_input` 相同的最新工具节点。找不到时把会话状态置为"等待权限确认"，不绑定到具体节点。
3. hook 先到而内容平面还没有对应节点时，创建占位节点，标记 `confirmed: false`。JSONL 记录到达后填入内容并置 `confirmed: true`，节点 id 不变。
4. 内容平面与状态平面冲突时（例如 JSONL 里已经有工具结果，但没收到 `PostToolUse`），以内容平面为准推导终态。
5. hooks 未安装或事件丢失时，状态完全由内容平面推断：有 `tool_use` 无结果为"执行中"，有结果按结果判成功或失败。"等待权限确认"在这种情况下无法区分，显示为"执行中"。

## 4. 统一事件模型

### 4.1 层级

```
项目（按 cwd 归并）
└─ 会话（session_id）
   └─ 轮次（一次用户 prompt 到 Claude 停下，以 prompt_id 标识）
      └─ 节点
         └─ 子代理（agent_id，内部是又一串节点）
```

### 4.2 节点

| 类型 | 内容来源 | 字段要点 |
|---|---|---|
| `prompt` | JSONL | 文本 |
| `thinking` | JSONL | 文本、耗时 |
| `text` | JSONL | 文本 |
| `tool` | JSONL + hooks | 工具名、入参、结果、耗时、状态 |
| `subagent` | JSONL + hooks | 代理类型、任务描述、状态、内部节点 |
| `system` | 两路 | 子类型：压缩、模型切换、hook 报错、会话开始、会话结束 |
| `unknown` | JSONL | 无法解析的对话记录，保留原始内容 |

所有节点共有：`id`、`sessionId`、`turnId`、`agentId`（主线为空）、`parentId`、`timestamp`、`confirmed`、`usage`（token 用量，有则填）。

### 4.3 状态

工具和子代理节点：

```
排队 → 等待权限确认 → 执行中 → 成功 | 失败 | 被拒绝
```

会话：`运行中`、`等待输入`、`等待权限确认`、`空闲`、`已结束`、`源文件已删除`（可与已结束并存，作为附加标记）。

### 4.4 边

| 类型 | 含义 | 来源 |
|---|---|---|
| 顺序边 | 同一轮次内的因果先后 | `parentUuid` 链 |
| 并行分叉 | 一条助手消息里同时发出多个工具调用，从同一点分叉，结果到齐后汇合 | 同一 `assistant` 记录里的多个 `tool_use` 块 |
| 派发边 | 主线的子代理节点连到其内部第一个节点 | 子代理关联字段 |

## 5. 存储

SQLite，单文件，WAL 模式，位置 `~/.claude-canvas/data.db`。

| 表 | 内容 |
|---|---|
| `raw_transcript` | JSONL 原始行：来源文件、字节偏移、原文、记录类型 |
| `raw_hook` | hook 原始载荷：接收时间、事件名、原文 |
| `file_offset` | 每个 transcript 文件已读到的字节偏移和文件大小 |
| `session` / `turn` / `node` / `edge` | 派生图 |
| `unknown_stat` | 未识别记录类型的计数和一条样例 |

原则：

- 原始记录原样保存，派生表可以整体删除后由原始表重建。CLI 提供重建命令。解析器修改后跑一次重建即可，历史数据不丢。
- 自己保存原始记录，而不是只引用源文件，因为 Claude Code 会定期清理旧 transcript。
- 每条派生变更带全局递增的序号 `seq`，用于增量推送和断线续传。

## 6. 接口

REST：

| 路径 | 返回 |
|---|---|
| `GET /api/projects` | 项目列表，含各自的会话数和活跃会话数 |
| `GET /api/projects/:id/sessions` | 会话列表，含状态、开始时间、最近活动时间、标题、分支 |
| `GET /api/sessions/:id/graph` | 该会话的完整图快照和快照对应的 `seq` |
| `GET /api/sessions/:id/nodes/:nodeId` | 节点完整内容（工具的完整入参和输出） |
| `GET /api/diagnostics` | 未识别记录统计、hooks 是否在收事件、各文件读取进度 |
| `POST /hooks` | 接收 hook 事件，立即返回空响应 |

图快照里的节点只带摘要（文本截断到固定长度），完整内容按需取，避免长会话的快照过大。

WebSocket `/ws`：客户端订阅会话列表或某个会话，并带上已持有的 `seq`；服务端先补发缺失的变更，再持续推送。变更类型为节点新增、节点更新、边新增、会话状态变化。

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
| 读到写了一半的行（不以换行结尾） | 不推进偏移，等下次文件变化后重读 |
| 文件比已记录偏移短（被截断或重写） | 该文件偏移归零重读，按原始行内容去重 |
| 服务重启 | 从 `file_offset` 续读；重启期间丢失的 hook 状态按 3.1 节规则 5 由内容平面推断 |
| hook 先到而 JSONL 记录迟迟不来 | 占位节点保留并显示为"未确认"，不删除 |
| 源 transcript 文件被删除 | 已入库数据不变，会话加"源文件已删除"标记 |
| hook 载荷无法解析 | 存入 `raw_hook`，计入诊断，仍返回 `200` |

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
- `claude-canvas rebuild`：由原始表重建派生表。

首次启动时，服务对 `~/.claude/projects/` 下已有的全部 transcript 做一次全量导入，之后转为增量。

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

1. **管线打通**：录制真实 hook 载荷并补全 2.2 节表格；确认 2.1 节两项未决事实；两个事件源、归一、入库、接口；页面能浏览项目和会话，以简单列表显示节点。目的是验证数据正确。
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
| 思考内容可能只有摘要 | 里程碑 1 确认；若只有摘要，因果视角按摘要展示，这是数据源的上限 |
| transcript 含代码和对话等敏感内容 | 只监听回环地址；数据库在用户目录下；测试夹具脱敏后才能入库 |
