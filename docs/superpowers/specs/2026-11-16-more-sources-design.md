# 更多来源（Gemini CLI、Grok Build、Copilot CLI）设计规格

- 日期：2026-11-16
- 状态：已评审通过并实现；无真实数据可核对（见 9.1）
- 路线图：第 8 项

## 1. 目标

除 Claude Code、Codex、Cursor 之外，再读取三种编码代理留在本机的会话，在同一套页面里显示：

- **Gemini CLI**（Google，`google-gemini/gemini-cli`）
- **Grok Build**（xAI 官方的 `grok` 命令，`xai-org/grok-build`）
- **GitHub Copilot CLI**（`@github/copilot`）

### 成功标准

1. 对应工具的会话目录存在时，其会话出现在项目列表和画布里：用户输入、回复、思考、工具调用及结果、子代理、标题、模型、工作目录、token 用量（该工具有记录的部分）。
2. 对应目录不存在时，该来源不启动，不产生任何文件、监听或报错，现有三个来源的行为不变。
3. 读到不认识的记录不报错、不丢弃其余内容，并在诊断页按来源列出类型和数量。
4. 检索、统计、按文件视图、异常检测、导出与遮蔽对新来源的会话照常工作（第 6 节列出例外）。
5. Grok、Copilot 因读取 Claude Code 钩子配置而触发我们的钩子时，不产生错误的会话。

### 不做

- 不安装这三个工具的钩子，不提供它们的实时状态（“等待确认”等）。会话状态只由文件活动推断。
- 不接社区项目 `superagent-ai/grok-cli`（`~/.grok/grok.db`）。
- 不读 Gemini 的 `/chat save` 存档、`logs.json`；不读 Copilot 的检查点、`plan.md`、`session.db`、`session-store.db`；不读 Grok 的 `chat_history.jsonl`、`usage.json`、`signals.json`。
- 不向这三个工具的目录写任何东西。

## 2. 依据与把握程度

**本机没有这三个工具的任何数据**（2026-11-16 核对：`~/.gemini`、`~/.grok` 不存在，`~/.copilot` 是空目录）。本设计只依据公开资料，全部结论**未经真实数据核对**。

| 来源 | 依据 | 把握 |
|---|---|---|
| Gemini CLI | 源码（`main`，2026-11-13，v0.68.0）和官方文档 | 较高 |
| Grok Build | 源码（`main`，1.0.77）、官方文档、第三方读取器 | 中等 |
| Copilot CLI | 闭源。公开 SDK 的事件类型定义、官方文档、第三方读取器 | 最低 |

各来源“只有真实数据才能定”的问题列在第 5 节各小节末尾。实现时这些地方按最可能的情况写，并且写成宽容的（见 4.3）。

用户文档里把这三个来源标为“未经真实数据核对”。

## 3. 数据模型

- `Origin` 增加 `'gemini' | 'grok' | 'copilot'`，`ORIGINS` 顺序为 `claude, codex, cursor, gemini, grok, copilot`。
- 存储键前缀：`gemini:`、`grok:`、`copilot:`。
- 新增变更类型 `node_removed { sessionId, id }`：节点及其详情、检索索引条目、相连的边一并移除；未知 id 忽略。用于回退和删除（Gemini 的 `$rewindTo` / `removeIds`、Grok 的回退标记和文件重写）。重建数据库时由同一批原始事件得到同样结果。被移除节点的子树和指向它的其余节点由各归一化器自己发出 `node_removed` / `node_updated`。
- 边按目标节点建索引 `edge_to (session_id, to_id)`，移除节点时不扫描整个会话的边。索引由打开数据库时 `CREATE INDEX IF NOT EXISTS` 建立：已有数据库在升级后的第一次启动时一次性创建，约每一百万条边 1–2 秒；不改表结构，旧版本照样能打开。它是长期的代价，所有来源都要付：边的表约大 84%，写入边约慢 2.2 倍（终审测量，22 万条边）；换来的是删除节点时不扫描整个会话的边。
- 异常检测的两个来源清单（`packages/shared/src/anomalies.ts`）：`COST_EXCLUDED_ORIGINS = ['copilot']`（这些来源的会话不判也不进“消耗异常高”的基线）；`COST_USAGE_REQUIRED_ORIGINS = ['grok']`（这些来源的会话没有任何带用量的节点时不判也不进基线）。见第 6 节。
- 数据库列 `origin` 是不带约束的文本，不需要改表；`NORMALIZER_VERSION` 不变（现有来源的输出不变），不需要重建。
- 环境变量（测试和自定义位置用）：`AGENT_CANVAS_GEMINI_DIR`、`AGENT_CANVAS_GROK_DIR`、`AGENT_CANVAS_COPILOT_DIR`。未设置时依次取工具自己的变量（`GEMINI_CLI_HOME` 下的 `.gemini`、`GROK_HOME`、`COPILOT_HOME`），再取主目录下的默认位置。

## 4. 共同做法

### 4.1 接入方式

三者都是“目录里的追加式 JSONL”，都实现现有的 `FileSource` 接口，由现有的监听、逐行读取、偏移记录、整库重建流程驱动；各有一个归一化器登记到 `NORMALIZER_FACTORIES`。不使用轮询来源。

- 逐行读取已能处理文件变短（从头重读）和不完整的末行。
- 小的旁路文件整份读取，但都有大小上限，超过按缺失处理：Gemini 的 `.project_root`（4 KB）、`projects.json`（1 MB）和 Grok 的 `summary.json`（1 MB）作为 `index` 类文件，每个会话存一条投影后的记录；Copilot 的 `workspace.yaml`（64 KB）作为 `title` 类文件（大小在分类时检查）。
- `FileSource.lineIdentity`（`'content'` 缺省 | `'offset'`）：决定存储如何识别重复行。缺省按行内容（现有来源不变）；Grok 设为 `'offset'`，行按（文件代次、偏移、内容）识别，所以内容完全相同的多行各自保留；文件变短时代次加一，整份重读。

### 4.2 来源是否启用

启动时目录不存在则不创建该来源。目录在服务运行期间才出现的，下次启动生效（文档写明）。

### 4.3 宽容读取

- 每行独立解析；解析失败的行跳过并计数。
- 不认识的记录类型、不认识的片段类型：跳过，通过现有的 `unknownRecordType` 上报，类型名带来源前缀（`gemini:<类型>`、`grok:<类型>`、`copilot:<类型>`）。类型名取自记录里的类型字段，截到 60 个字符，只保留字母、数字、`.`、`_`、`-`、`/`、`$`，不含任何内容值。
- 认识的记录里缺少可选字段：按缺省处理，不上报。
- 字段有多种可能写法的（如路径参数名），按第 5 节给出的顺序逐个尝试。

### 4.4 工具名与路径

每个来源一张对照表，把工具名归到现有的类别（读、写、改、执行、搜索、子代理、其他），并指出哪个参数是文件路径、哪个是命令。按文件视图和输入指纹用这张表。表里没有的工具归“其他”，仍显示名字、输入和输出。

### 4.5 会话状态

没有钩子。状态按现有“只有文件”的规则：最近有写入为运行中，超过 `STALE_AFTER_MS` 为空闲；有明确结束记录的（Copilot 的 `session.shutdown`）立即为已结束。

## 5. 各来源

### 5.1 Gemini CLI

**位置**：`<根>/tmp/<项目目录名>/chats/`。

- 主会话：`session-*.jsonl`（旧版 `session-*.json`）。
- 子代理：`chats/<父会话 id>/<子会话 id>.jsonl`，作为父会话的一个代理线程。
- 忽略 `*.tmp-*`、`*.unreadable-*`。
- 监听深度到 `tmp/*/chats/*/*`。

**项目**：会话文件不含工作目录。取 `<根>/tmp/<项目目录名>/.project_root` 的内容；没有则反查 `<根>/projects.json`；都没有则项目为 `gemini:<项目目录名>`、工作目录未知。`.project_root` 在 Windows 上是全小写路径，与其他来源的同一目录归并时不区分大小写比较（仅 Windows）。

**记录**（JSONL 每行一种，按此顺序判断）：

1. `{"$rewindTo": id}`：移除该消息及其后的全部消息；id 未知则移除全部。值不是字符串时按未识别上报（`gemini:$rewindTo`），不移除任何消息。
2. `{"$patch": {...}}`：`id`+`content` 或 `updates[]` 改消息内容；`toolCalls[{id, result}]` 按工具调用 id 补结果；`removeIds` 移除；`orderIds` 忽略顺序变化（节点顺序按首次出现）。
3. 带字符串 `id` 的对象：一条消息。同一 `id` 再次出现时整条替换，位置不变。
4. `{"$set": {...}}`：合并进会话元数据（`summary` 为标题）；其中的 `messages` 数组替换全部消息。
5. 带 `sessionId` 和 `projectHash` 的对象：元数据行。

**消息**：

- `user`：内容含 `functionResponse` 片段的是工具结果回传，不作为用户输入节点；其余是用户输入。
- `gemini`：`content` 为回复文字；`thoughts[]` 为思考（`subject` + `description`）；`toolCalls[]` 为工具调用；`tokens` 为用量（`input`、`output`、`cached`、`thoughts`、`tool`、`total`）；`model`。
- `info` / `warning` / `error`：提示节点。
- 工具调用状态：`success` 成功；`error`、`cancelled` 失败；其余进行中。结果取 `result[].functionResponse.response` 的 `output` 或 `error`。`agentId` 存在时把该调用与同 id 的子代理线程相连；对不上则只显示调用本身。

**旧版 `.json`**：整份是一个对象（元数据 + `messages`）。整份读取，作为一条“替换全部消息”的记录处理。同一 `sessionId` 同时有 `.json` 和 `.jsonl` 时只读 `.jsonl`。超过 64 MB 的不读：每次分类时检查大小，超过则记入失败列表，什么也不存。

**工具对照**：`read_file`、`read_many_files`（读）；`write_file`（写）；`replace`（改）；`run_shell_command`（执行，命令 `command`）；`list_directory`、`glob`、`grep_search`、`search_file_content`（搜索）；`invoke_agent`、`codebase_investigator`、`cli_help`（子代理）。路径参数依次尝试 `file_path`、`absolute_path`、`path`、`dir_path`、`directory`。

**实现时补充的规则**：

- 会话从第一条消息开始存在：只有元数据行、`$set` 的文件（或没有消息的旧版 `.json`）不产生会话。
- `.project_root`、`projects.json` 有大小上限（4 KB、1 MB），按 mtime + 大小缓存；超过上限、内容不是单个绝对路径（含控制字符也不算）时按缺失处理，继续下一个回退。
- 回退或删除移除了派发子代理的那次调用时，子代理线程保留（它的文件还在），改挂在会话下（`parentId` 为空）。

**未定**：每轮实际写盘的顺序与重复次数；`agentId` 是否等于子会话 id；压缩后留下的记录；旧版参数名；大输出是否被换成指针。

### 5.2 Grok Build

**位置**：`<根>/sessions/<编码后的工作目录>/<会话 id>/`，含 `summary.json` 才算会话。读 `updates.jsonl`（会话内容）和 `summary.json`。`summary.json` 整份读取（≤ 1 MB），但不整份存储：只取一条投影（标题、摘要、模型、工作目录、分支、创建时间）存为索引记录，投影变化时才存新的一条。

**项目与标题**：工作目录取 `summary.json` 的 `info.cwd`；没有则对目录名做 URL 解码，结果像绝对路径才采用；再没有则读上级目录的 `.cwd`。标题取 `generated_title`，否则 `session_summary`。模型取 `current_model_id`。

**子代理**：`summary.json` 里 `session_kind` 为 `subagent` 且有 `parent_session_id` 的会话，作为父会话的一个代理线程（代理 id 为子会话 id）。沿 `parent_session_id` 一直找到最上层的会话（最多 16 层，有环则停）：子代理的子代理也是最上层会话的代理线程，挂在派出它的那一步下。链上某个 `summary.json` 还读不到时，这个子代理先暂存、不建任何会话（最多暂存 10,000 个），父会话出现后再挂上；重启后由全量扫描重新找到。有 `parent_session_id` 但不是子代理的（分叉）作为独立会话。

**记录**：每行 `{timestamp（秒）, method, params}`；没有 `method` 的旧行把整行当作 `params`。

- `method` 为 `session/update`：看 `params.update.sessionUpdate`：
  - `user_message_chunk`、`agent_message_chunk`、`agent_thought_chunk`：文字片段。同一轮里连续的同类片段拼成一个节点；一段达到 4 Ki 个字符（`GROK_RUN_MAX_CHARS = 4096`）后，下一个片段接到新节点上（片段本身不切开），以限制反复改写长节点的代价。所以很长的回复显示为几个连续的节点。
  - `tool_call`：新建工具节点（`toolCallId`、`title`、`kind`、`status`、`rawInput`、`locations`）。
  - `tool_call_update`：按 `toolCallId` 更新状态、输出（`content[]` 里的文字，没有则 `rawOutput`）。`failed`、`error`、`cancelled` 为失败。
  - `plan`、`available_commands_update`、`current_mode_update`：忽略，不上报。
- `method` 为 `_x.ai/session/update`：类型名依次从 `params.update.sessionUpdate`、`params.update.type`、`params.type` 取。
  - 轮次结束（`turn_completed`）：用量取 `usage` 的 `inputTokens`、`outputTokens`、`cachedReadTokens`、`cacheCreationTokens`、`reasoningTokens`，设到该轮最后一个回复节点（没有回复节点时设到该轮最后一个节点；之后同一轮又有回复时移到新的回复上；重复的记录是覆盖，不累加）。归类是推测的：新输入 = `inputTokens + cacheCreationTokens`，缓存读取 = `cachedReadTokens`，输出 = `outputTokens + reasoningTokens`。
  - 回退标记（类型名含 `rewind`）：有 `target_prompt_index` 时移除该序号及之后各轮的节点；取不到序号则不移除，按未识别上报。被移除的调用派出的子代理线程保留：改挂到之后仍在、同样指名它的调用上，没有则挂在会话下。
  - 其余：上报为未识别。
- 轮次：`_meta.promptId`（先看 `params._meta`，再看 `params.update._meta`）变化即新一轮；没有则以用户片段开始新一轮。

**行的识别**：`updates.jsonl` 的行按位置加内容识别（见 4.1 的 `lineIdentity`），内容完全相同的片段每一行都生效。文件被改写（变短）时，受影响的线程按新文件从头重建：旧节点全部 `node_removed`，再按新内容生成，结果与第一次读新文件相同。

**异常检测**：没有任何带用量节点的 Grok 会话不参与“消耗异常高”（不判，也不进基线），见第 6 节。

**工具对照**：`run_terminal_cmd`、`run_terminal_command`、`bash`（执行，`command`）；`read_file`、`read`（读）；`write`、`write_file`（写）；`search_replace`、`edit`、`edit_file`、`hashline_edit`、`apply_patch`（改）；`list_dir`、`glob`、`grep`（搜索）；`task`、`Task`、`spawn_subagent`（子代理）。工具名取不到时用 ACP 的 `kind`（`read`、`edit`、`delete`、`move`、`search`、`execute`、`fetch`）归类。路径依次尝试 `rawInput` 的 `target_file`、`file_path`、`path`、`target_directory`、`filePath`，再取 `locations[0].path`。

**未定**：`_x.ai` 扩展记录的确切形状；`_meta` 的位置；`rawInput` 是否每个版本都有；Windows 上目录名的编码；父会话记录里出现的是否是子会话 id；片段是逐字写入还是合并后写入。

### 5.3 GitHub Copilot CLI

**位置**：`<根>/session-state/<会话 id>/events.jsonl`；1.0 以前的 `<根>/session-state/<会话 id>.jsonl` 按同一格式读取。`workspace.yaml` 整份读取。

**项目与标题**：工作目录取 `session.start` 的 `data.context.cwd`（和其他来源一样规整：去掉末尾的分隔符、盘符大写），之后的 `session.context_changed`、`session.resume` 里的 `context.cwd` 不改变会话所属项目。`workspace.yaml` 只取顶层的 `name`、`summary`、`cwd` 三个键（逐行按 `键: 值` 解析，取第一行，去引号；不引入 YAML 库）。标题取 `name`，否则 `summary`，否则第一条用户输入。

**记录**：每行 `{type, data, id, timestamp, parentId, agentId?}`，顺序即文件顺序。

- `session.start`：会话开始、模型（`selectedModel`）、工作目录。`session.model_change`：换模型。
- `user.message`：用户输入（`content`）。
- `assistant.reasoning`：思考。`assistant.message`：回复文字（`content` 为空且有 `toolRequests` 时不建回复节点）。
- `tool.execution_start`：工具节点（`toolCallId`、`toolName`、`arguments`；`arguments` 是字符串时尝试按 JSON 解析）。没有对应开始记录的 `assistant.message.toolRequests[]` 项也建工具节点。
- `tool.execution_complete`：按 `toolCallId` 补结果；`success` 为假是失败，输出取 `result.content`，否则 `error.message`。
- `subagent.started` / `subagent.completed` / `subagent.failed`：按 `toolCallId` 对应到子代理调用。带 `agentId` 的事件属于该代理线程；线程与调用的对应依次用：事件上的 `data.parentToolCallId`；`agentId` 等于某个调用的 `toolCallId`；`subagent.started` 之后首次出现的新 `agentId`——这一条只在恰好有一个尚未结束、尚未被认领的 `subagent.started` 时才用（几个子代理同时运行时分不清，宁可不连）。都对不上则线程挂在会话下，不连到调用；之后的事件带上 `parentToolCallId` 或出现 id 相同的调用时再连上。
- `session.compaction_complete`、`session.truncation`：压缩节点。
- `session.error`、`abort`：错误 / 中断节点。
- `session.shutdown`：会话结束；`modelMetrics` 里各模型的 `usage`（`inputTokens`、`outputTokens`，有则加 `cacheReadTokens`、`cacheWriteTokens`）合计为会话用量，记在这次结束的节点上（该节点不属于任何轮次；统计把它当作会话退出时刻的一条独立记录，用量记在退出那一刻、退出那一天，它不延长最后一轮的时长；新输入 = `inputTokens + cacheWriteTokens`，缓存读取 = `cacheReadTokens`，输出 = `outputTokens`；归类是推测的）。一个会话有多次结束时：上一次的每个模型都还在、且没有一项变小，就只记增长的部分（数字若是累计值则正好，若是每次运行的值则少算）；否则整份记为新的一次。所以只会少算，不会多算。
- 其余已知但无需显示的类型（`assistant.turn_start`、`assistant.turn_end`、`assistant.intent`、`session.resume`、`session.info`、`session.idle`、`hook.*`、`permission.*`、`skill.invoked` 等）：忽略，不上报。清单之外的上报为未识别。

**工具对照**：`bash`、`powershell`（执行，命令依次 `command`、`fullCommandText`）；`view`（读）；`create`（写）；`edit`、`apply_patch`（改）；`glob`、`grep`、`rg`（搜索）；`task`（子代理）。路径依次尝试 `path`、`file_path`、`filePath`、`fileName`。

**大文件**：单个 `events.jsonl` 实测可超过 500 MB。现有逐行读取是流式的；本来源不做任何整份读入 `events.jsonl` 的操作（取工作目录只读第一行，最多 256 KB）。归一化器不在内存里保留工具的参数和输出：它们出现时作为节点详情发出一次就丢掉，每个调用只留从中算出的有界字段（文件、输入指纹、摘要等）。

**文件被改写**：Copilot 修复会话文件时会删掉坏行、重写文件。重读后，仍在的事件按事件 id 跳过，不会重复；已经不在文件里的事件，它们建的节点仍然保留（原始记录还在），实时、重建、重启的结果一致。

**异常检测**：只有会话总用量，Copilot 的会话不参与“消耗异常高”（`COST_EXCLUDED_ORIGINS`），见第 6 节。

**未定**：磁盘上的行是否与 SDK 类型逐字一致；各工具的参数名；`agentId` 与调用的对应方式；`workspace.yaml` 的键；旧版平铺文件的格式。

## 6. 对现有功能的影响

- **统计**：Copilot 只有会话总用量，没有按轮用量；统计把总量记在会话结束（`session.shutdown`）那一刻，按日统计时记在退出那一天。结束节点不属于任何轮次，也不拉长最后一轮（统计按“会话退出”节点单独计：主线程上 `system` 类、`systemSubtype` 为 `shutdown` 的节点，目前只有 Copilot 产生）。`session.resume` 之后没有新提示的步骤属于以这次恢复开头的单独一轮。没有按模型的统计。Gemini 的 `cached` 记为缓存读取，`thoughts` 计入输出。
- **异常检测**：“消耗异常高”需要按轮用量，Copilot 的会话不参与（`COST_EXCLUDED_ORIGINS`），没有任何带用量节点的 Grok 会话不参与（`COST_USAGE_REQUIRED_ORIGINS`）；不参与的会话既不判也不进同项目同来源的基线。其余三类照常。
- **通知**：照常，但没有钩子，“等待确认”类通知不会出现。
- **导出与遮蔽、检索、按文件视图**：照常，不需要按来源改动。
- **页面**：来源标签和筛选增加三项（标记是自绘的字母 G、K、C，不用厂商标志）；诊断页增加三个来源的状态块（目录、是否存在、会话数、未识别记录，接口 `GET /api/diagnostics` 的 `sources`），以及“被丢弃的外来 hook 调用”的计数（`foreignHooksDropped`），沿用现有布局。

## 7. 钩子串扰

Grok Build 会读取 Claude Code 的 `.claude/settings.json` 和 Cursor 的 `.cursor/hooks.json` 里的钩子；Copilot CLI 会读取 `.claude/settings(.local).json` 里的钩子。它们因此可能调用我们为 Claude Code、Cursor 安装的钩子，但载荷不同。（依据公开资料；它们是否真的调用、载荷是什么形状，未经核对。Copilot 若发 Claude 式载荷，本校验认不出。）

服务端在 `/hooks` 入口按来源校验载荷，不符合的直接丢弃（返回成功，不入库），并在诊断里计数“被丢弃的外来钩子调用”（内存中计数，自服务启动以来，重启归零）：

- 来源为 `claude` 或 `cursor` 时，满足以下任一条即丢弃：
  - 顶层有 `hookEventName`（Grok 的写法；Claude Code 和 Cursor 都用 `hook_event_name`）。
  - 顶层有 `sessionId`，且没有 `session_id` 和 `conversation_id`（Grok、Copilot 的写法）。
- 来源为 `codex`：不变。
- 其余情况走现有逻辑（包括现有的 `hook:invalid` 上报）。

转发程序本身不改，仍然只转发、总是退出 0。

## 8. 错误处理

- 目录、文件读不了：记到现有的失败列表，其余文件继续。
- 旁路文件（`summary.json`、`workspace.yaml`、`.project_root`、`projects.json`）缺失或损坏：按缺省处理（标题、工作目录未知），不报错。
- 归一化器对任何输入都不抛出异常。
- 回退指向未知 id：按 5.1、5.2 的规则处理。

## 9. 测试

没有真实数据，全部用自造样例，内容为虚构、不含真实路径和凭据。

- 每个来源：按第 5 节逐条规则的单元测试；一份完整样例会话的端到端测试（文件 → 存储 → 图）；逐行追加与一次读完结果一致；重建数据库结果一致。
- 宽容性：每个来源一组“变形”样例（缺字段、未知类型、损坏行、空文件、只有元数据、乱序的更新）不报错，且未识别类型被正确上报。
- 回退与替换：Gemini 的五种记录、Grok 的回退标记，移除后图、检索索引、统计一致。
- 目录不存在时来源不启动；三个来源同时存在时互不影响；现有三个来源的全部测试不变且通过。
- 钩子串扰：Grok、Copilot 形状的载荷打到 `claude`、`cursor` 入口被丢弃并计数；现有正常载荷不受影响。
- 测试和临时服务只用临时目录和 `AGENT_CANVAS_*_DIR`，不读写真实的工具目录。

### 9.1 真实数据核对

**无法进行**，本机没有这三个工具的数据。实现完成后只能确认：真实服务启动时三个来源均未启用、现有数据不受影响。将来任一工具在本机产生会话后，以诊断页的未识别记录和第 5 节的“未定”清单为起点核对。

终审（2026-11-16）的结果：在同样的自造输入上，现有三个来源的原始记录、推导结果、图、统计、异常、检索和 Markdown 导出与 `main` 逐字节一致，HTML 导出里内嵌的数据一致（外层的查看器模板随本分支的页面改动而不同）（实时、追加、重建、重启后都是）；`main` 建的数据库经本分支打开后只多一个 `edge_to` 索引，之后 `main` 仍能打开并照常工作；没有这三个工具的目录时，启动的来源与 `main` 完全相同。

本机真实服务核对（2026-11-16，只看数量）：升级前把数据库备份到 D 盘；用本分支启动后，Codex（53,562）和 Cursor（193,824）的原始记录数不变，Claude Code 只增加了停机期间积压的会话；连线表（约 28 万条）多了 `edge_to` 索引，启动没有可感知的延迟；元数据条目数不变（350），没有重建，归一化版本仍是 34；节点数与详情数一致，没有指向不存在节点的连线，读取失败 0 个；三个新来源在诊断里均为“不存在、未读取、0 个会话”，没有创建任何目录。

没有真实数据就无法核对的：三个工具的每一种记录形状和字段名（第 5 节各“未定”）；Copilot 的 `agentId` 与派发的对应、`modelMetrics` 是累计值还是每次运行的值、`inputTokens` 是否已含缓存读取；Grok 的 `_x.ai` 扩展记录、`_meta` 的位置和 Windows 上目录名的编码；Gemini 真实会话的大小（内存约为文件的两倍）和 `.project_root` 的大小写；Grok、Copilot 是否真的调用我们为 Claude Code / Cursor 安装的 hook、发来什么；成千上万个真实会话目录下监听和全量扫描的开销。

## 10. 里程碑

1. 共用部分：`Origin` 扩展、`node_removed`、来源启用判断、钩子串扰校验、页面的来源标签与诊断块。
2. Gemini CLI。
3. Copilot CLI。
4. Grok Build。
5. 文档：README、手册（新增三个来源的说明、位置、限制、“未经真实数据核对”）。
