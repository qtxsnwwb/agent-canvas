# 再接四个来源：DeepSeek Harness、WorkBuddy、CodeBuddy Code、豆包工作

状态：待评审
日期：2026-11-17

## 1. 目的与范围

在已有的六种来源（Claude Code、Codex、Cursor、Gemini CLI、Grok、Copilot CLI）之外，再读取四种工具留在本机的会话：

| 来源（`Origin`） | 产品 | 厂商 | 依据 |
|---|---|---|---|
| `deepseek` | DeepSeek Harness（`dsh`，命令行、网页界面、桌面应用共用一套数据） | DeepSeek | 官方开源代码 |
| `workbuddy` | WorkBuddy（桌面办公代理） | 腾讯 | 腾讯发布的 CodeBuddy Code 安装包里的类型定义，四个第三方读取工具 |
| `codebuddy` | CodeBuddy Code（命令行） | 腾讯 | 同上；与 WorkBuddy 同一引擎、同一格式 |
| `doubao` | 豆包工作（独立客户端，以及豆包桌面应用里的“工作任务”模式） | 字节 | 一个第三方读取工具 |

每个来源显示它的文件里有的东西：用户输入、回复、思考、工具调用及结果、子代理、标题、模型、工作目录和用量。检索、统计、按文件视图、异常检测、导出、遮蔽、通知照常适用。

### 1.1 没有真实数据

开发机上没有这四个工具，实现只依据公开资料。三份格式说明在 `docs/formats/`，每条结论标明出处和强度；它们是本设计关于文件格式的依据，实现以它们为准：

- `docs/formats/deepseek-harness.md`
- `docs/formats/buddy-family.md`（WorkBuddy 与 CodeBuddy Code）
- `docs/formats/doubao-work.md`

测试样例全部按这些说明自造。测试通过只说明实现与对资料的理解一致，不说明与真实文件一致。文档里这四个来源与 Gemini CLI、Grok、Copilot CLI 一样标明“未经真实数据核对”。

### 1.2 不做的

- 千问办公（QwenWork）：2026 年 11 月起改存数据库，新格式没有公开资料。等真实数据。
- TRAE CLI：是 Codex 的闭源分支，但记录的写法随版本变化，只有一个第三方工具作依据。等真实数据。
- Qwen Code：依据充分，另立一批。
- 这四个工具的钩子；会话状态由文件活动推断。
- DeepSeek Harness 第 4 版以前的会话文件；CodeBuddy 的 IDE 插件（另一种格式）；豆包的普通聊天和在云电脑上执行的任务（本机不留记录）。

## 2. 共同部分

### 2.1 来源与标识

- `Origin` 增加 `deepseek`、`workbuddy`、`codebuddy`、`doubao`，共十种。
- 会话 id 的前缀（`KEY_PREFIXES`）：`deepseek:`、`workbuddy:`、`codebuddy:`、`doubao:`，后接工具自己的会话 id。
- 现有六种来源的输出不变；`NORMALIZER_VERSION` 不变；数据库结构不变，不需要重建。

### 2.2 位置与覆盖

每个来源的位置取第一个存在的：本程序的环境变量、工具自己的环境变量、默认位置。

| 来源 | 本程序的变量 | 工具自己的变量 | 默认 |
|---|---|---|---|
| `deepseek` | `AGENT_CANVAS_DSH_DIR`（指向 dsh 的主目录） | `DSH_HOME` | `~/.dsh` |
| `workbuddy` | `AGENT_CANVAS_WORKBUDDY_DIR`（一个目录） | `WORKBUDDY_CONFIG_DIR` | `~/.workbuddy` 和 `~/.workbuddy-ai`，两个都扫 |
| `codebuddy` | `AGENT_CANVAS_CODEBUDDY_DIR` | `CODEBUDDY_CONFIG_DIR` | `~/.codebuddy` |
| `doubao` | `AGENT_CANVAS_DOUBAO_DIR`（一个“User Data”级的目录） | 无 | 见 5.1，按系统取两个 |

- 本程序的变量设为空字符串表示关闭该来源（测试用，与现有的 `AGENT_CANVAS_GEMINI_DIR` 等相同）。
- 目录不存在时该来源不启动，不创建、不监听任何东西。服务运行期间才出现的目录，重启后才读取（与现有三个来源相同）。
- 对这些目录只读。

### 2.3 宽容读取与诊断

- 不认识的记录类型跳过，按来源计入诊断页的“未识别记录”（类型和数量，不含内容），沿用现有的 `unknownTypeName` 机制。
- 诊断页的 `sources` 增加四项：目录、是否存在、是否在读、会话数；`deepseek` 另有“旧格式文件数”和“运行环境不支持解压”两项状态。
- 读取失败计入现有的读取失败统计，不中断其他会话。

### 2.4 项目归属

- 有工作目录的来源（`deepseek`、`workbuddy`、`codebuddy`）：用现有的 `ProjectIdResolver.forCwd`，与其他来源在同一目录下归为同一个项目。
- 工具给目录起的名字（各自的有损编码）不用来还原路径；工作目录一律取自记录。

### 2.5 网页

- 来源的名称、颜色、筛选项增加四种。首页的来源筛选仍只显示有数据的来源。
- 名称：DeepSeek、WorkBuddy、CodeBuddy、豆包。

### 2.6 异常检测与统计

- 没有用量的会话不参与“消耗异常高”（现有规则，Grok 已如此）。`doubao` 整个来源没有用量，加入 `COST_EXCLUDED_ORIGINS`。
- 其余检测（循环、反复失败、反复改同一文件）照常。

## 3. DeepSeek Harness

依据：`docs/formats/deepseek-harness.md`（下称“格式说明”）。

### 3.1 文件

- 根：`<主目录>/sessions/<项目键>/<会话段>/`，其中的 `session.v4.jsonl.zstd`。
- 同一目录里可能并存更早版本的文件（`session.jsonl.zstd`、`session.v1`–`v3`）。只读 `session.v4.jsonl.zstd`；一个会话目录里没有 v4 文件但有旧文件时，计入诊断的“旧格式文件数”，不读。出现比 4 更高的版本文件时同样计数并跳过。
- 附件、归档状态等旁边的东西不读。已归档的会话照常显示（归档状态存在别处，不读）。

### 3.2 解压与续读

文件是若干个独立的标准 Zstandard 帧首尾相接：第 1 帧只有头行，之后每帧是一次追加的若干整行。

- 自己按帧头找出帧的边界（移植格式说明 2.2 里那段约 60 行的帧扫描），逐帧用 `zlib.zstdDecompressSync` 解压。不依赖“一次调用解多个帧”的行为。
- 续读：记住“已解到第几个字节”，该位置总是一个完整帧的末尾；下次从那里继续。
- 末尾的帧不完整时忽略它，等下次。
- 文件变短，或第 1 帧的字节变了：视为重写，整个文件重读，并重新推导该会话（多出来的旧节点移除）。
- 每行的身份是 `(会话 id, seq)`；`seq` 从 0 起逐行加 1。分叉出来的会话里复制的前缀带着原来的 `seq` 和消息 id，所以不能用消息 id 跨文件去重。
- `zlib.zstdDecompressSync` 自 Node 22.15 起才有（标记为实验性）。本项目声明的最低版本仍是 Node 22：启动时检测，没有该函数时 `deepseek` 来源不启动，诊断页写明“需要 Node 22.15 或更高”。不新增依赖。

### 3.3 记录到节点

| 文件里的事件 | 显示为 |
|---|---|
| 头行（`type: 'session'`） | 会话：id、创建时间、工作目录；`parentSession` / `origin: 'subagent'` 见 3.5 |
| `user/message`，`data.source.kind === 'user'` | 提问 |
| `user/message`，`source.kind === 'compact-checkpoint'` | 一个系统节点“上下文已压缩”；此前的节点保留 |
| `user/message`，其他来源种类 | 不显示（注入的上下文） |
| `assistant/message` 的 `reasoning` 块 | 思考 |
| `assistant/message` 的 `text` 块 | 回复 |
| `assistant/message` 的 `tool-call` 块 / `tool/call` | 工具调用（以 `callId` 为准，两处只算一个） |
| `tool/result` | 对应工具调用的结果与成败，按 `toolCallId` 配对 |
| `session/title` | 标题，取最后一条 |
| `working-directory/change` | 更新工作目录 |
| `turn/start` … `turn/end` | 轮次；`turn/end` 的原因是出错或中止时，这一轮标为失败或中断 |
| `compaction/start`、`compaction/summary`、`compaction/end` | 不显示（压缩由上面的检查点消息表示），不计入未识别 |
| `agent/inbox/spliced` | 不显示（与提问重复） |
| `system/message`、`request/header`、`request/context` 及其余日志类事件 | 不显示，不计入未识别 |
| 不在格式说明里的类型 | 跳过并计入未识别 |

- 用量取自 `assistant/message.data.usage`：`input = inputTokens`（已是不含缓存的输入），`cachedInput = cacheReadTokens`，`output = outputTokens`（已含思考，不再加）。
- 模型取自 `assistant/message` 的来源信息；一个会话用过多个模型时按现有来源的做法取最近的。
- 标题：`session/title` 的最后一条；没有时用第一条提问（现有规则）。

### 3.4 分叉

分叉是一个新的会话文件，头行 `isSeeded`，前面复制了原会话的一段。显示为独立的会话，复制的前缀照常显示。不在两个会话之间建立关联。

### 3.5 子代理

- 子代理是独立的会话文件，头行有 `parentSession` 和 `origin: 'subagent'`，与父会话在同一个项目目录下。
- 显示为根会话里的一条线程（多级子代理都挂在根会话下，与 Grok 的做法一致），不作为单独的会话出现在列表里。
- 连到父会话里派出它的那次工具调用：父会话的 `tool/result.data.meta = {kind: 'activation', name}`，`name` 的最后一段对应同一文件里 `subagent/catalog` 的 `name`，由此得到子会话 id。对不上时线程挂在会话下，不连线。
- 子代理文件先于父会话被读到时先留着，等父会话出现（现有的“孤儿子代理”机制）；`mode: 'external'` 的子代理没有本地文件，只显示工具调用本身。

## 4. WorkBuddy 与 CodeBuddy Code

依据：`docs/formats/buddy-family.md`。两者由同一个引擎写出，共用一个规整器和一个文件来源实现，只有根目录和 `Origin` 不同。

### 4.1 文件

- `<根>/projects/<项目名>/<会话 id>.jsonl`；子代理在 `<会话 id>/subagents/agent-*.jsonl`。
- WorkBuddy 的两个默认根都扫；同一个会话 id 出现在两个根里时取先读到的一个，另一个计入诊断。
- 项目名是有损编码，不用；工作目录取自记录的 `cwd`。
- 不读 `workbuddy.db`、`traces/`、`.meta.json`。
- 文件只追加；一次追加失败时可能被截短。文件变短时整个文件重读并重新推导该会话。

### 4.2 记录到节点

| 记录 | 显示为 |
|---|---|
| `message`，`role: 'user'`，是人的输入（见 4.3） | 提问 |
| `message`，`role: 'user'`，压缩边界（`isCompacted` / `isSummary`） | 系统节点“上下文已压缩” |
| `message`，`role: 'user'`，其余 | 不显示 |
| `message`，`role: 'assistant'` | 回复（`output_text` 各段拼接） |
| `message`，`role: 'system'`（`/clear` 的分隔） | 系统节点 |
| `reasoning` | 思考；文本先取 `rawContent[].text`，没有时取 `content` |
| `function_call` | 工具调用；`arguments` 是字符串时按 JSON 解析，解析不了原样保留 |
| `function_call_result`（以及旧类型 `function_call_output`） | 对应调用的结果：与同一 `callId` 的、此前最近一个还没有结果的调用配对；`status` 不是完成时标为失败 |
| `custom-title` > `ai-title` > `topic` | 标题，按这个优先级，各取最后一条 |
| `session-meta`、`file-history-snapshot`、计量与运行时记录 | 不显示，不计入未识别 |
| 其余类型 | 跳过并计入未识别 |

- 轮次：有 `providerData.conversationRequestId` 时按它分组；没有时每条被接受的提问开一轮。`startsNewUserRequest === false` 的提问留在当前轮里。
- 模型：`providerData.model`；值是 `auto` 且同一会话里出现过具体模型时用具体的那个。
- 没有配到调用的结果：丢弃并计数。没有结果的调用：显示为未完成。

### 4.3 提问的提取

对用户消息的每个文本段：去掉 `<system-reminder …>…</system-reminder>`；有 `<user_query>…</user_query>` 时取其中的内容；只剩提醒或本地命令记录的段丢弃。全部段都丢弃的消息不是提问。

`providerData` 里带 `skipRun`、`isMeta`、`isAdditionalData`、压缩标记或队友消息标记的用户消息不是人的输入。这些标记的位置以引擎为准（在 `providerData` 里），不采用个别第三方工具从顶层读的写法。

### 4.4 当前分支

记录用 `parentId` 连成一棵树。回退和“改写后重发”不删除任何行，只追加一条 `resend-fork-notice`，之后的记录接在新的位置上。

- 文件里没有 `resend-fork-notice`（也没有内容过滤提示）：全部显示，不做遍历。引擎自己也是这样，因为重复的 id 会让盲目遍历丢消息。
- 有：按格式说明第 7 节的算法求出当前分支，只显示当前分支上的记录；不在分支上的节点移除（现有的 `node_removed`）。
- 压缩不属于分支切换：压缩前的记录继续显示。

### 4.5 用量

- 同一次模型回复的用量会重复出现在回复、各个工具调用和 `model-usage` 记录上：按 `providerData.messageId` 去重，取其中最大的一份。没有 `messageId` 的用量记录各算一份。
- 换算到本项目的口径：`cachedInput` 取缓存读取；`input` = 提示词总数 − 缓存读取 − 缓存写入（来源给出的输入已不含缓存时不再减）；`output` 含思考。具体认哪些字段名、哪种形状属于哪种上游，见格式说明 6.3，照表实现并逐项测试。
- 格式说明标出几个第三方工具在这一点上互相矛盾。结论以引擎的类型定义为准；手册注明用量的换算未经真实数据核对。

### 4.6 子代理

- 目录结构决定归属：`<会话 id>/subagents/agent-*.jsonl` 是该会话的子代理线程。子代理文件里各行的 `sessionId` 是另一个运行时 id，不能用来归属，以路径为准。
- 连到父会话的工具调用：父会话里 Agent 工具的 `function_call_result.providerData.toolResult.subAgent.sessionId` 等于子代理文件名的主干。没有这个字段时线程挂在会话下，不连线。

### 4.7 WorkBuddy 的临时工作目录

WorkBuddy 会给会话建以时间命名的工作目录（如 `…/WorkBuddy AI/2026-10-27-13-46-52`）。工作目录的最后一段是纯时间戳形式时，项目取它的上一级目录；会话的工作目录本身照原样显示。只对 `workbuddy` 来源这样做。

## 5. 豆包工作

依据：`docs/formats/doubao-work.md`。只有一个第三方工具解析过这种文件，是这一批里最可能与真实文件不符的。

### 5.1 文件

默认根（两个变体，存在的都读）：

| 系统 | 独立客户端 | 豆包应用的工作任务模式 |
|---|---|---|
| Windows | `%LOCALAPPDATA%\DoubaoWork\User Data` | `%LOCALAPPDATA%\Doubao\User Data` |
| macOS | `~/Library/Application Support/DoubaoWork` | `~/Library/Application Support/Doubao` |

其下：`<配置>/<命名空间>/agent_mode/workspace/.sessions/<会话 id>/agents/<代理 id>/system/trajectory.jsonl`，旁边有 `assignment.md`。`<配置>` 是 `Default` 或 `Profile N`，全部扫描；`<命名空间>` 是 `.doubaowork` 或 `.doubao`。Linux 没有客户端。

- 一个 `.sessions/<会话 id>` 目录是一个会话。主代理是名字以 `m_` 开头的那个代理目录；其余代理是子代理线程。
- 行没有 id，也没有时间：行的身份是它在文件里的位置（现有的按位置识别行，`lineIdentity: 'offset'`）。
- 预期只追加。文件变短，或已读部分的开头和结尾的字节变了：整个文件重读并重新推导该会话。

### 5.2 记录到节点

| 行 | 显示为 |
|---|---|
| `role: 'user'` | 提问；去掉开头的 `<system-reminder>…</system-reminder>` |
| `role: 'assistant'` 的 `content`（非空） | 回复 |
| `role: 'assistant'` 的 `tool_calls[]` | 工具调用：`id`、`function.name`、`function.arguments`（对象，或 JSON 字符串） |
| `role: 'tool'` | 按 `tool_call_id` 配到调用上的结果 |
| 其他 `role`，或 `content` 不是字符串 | 跳过并计入未识别 |

文件里没有思考、模型、用量、工作目录，对应的地方留空。

### 5.3 标题、时间、项目

- 标题：没有可靠的文件来源，用第一条提问（现有规则）。
- 时间：主代理的 `assignment.md` 里每个需求段（`## [时间] 需求`）的标题行带时间。只含提醒、没有正文的需求段不算。第 n 条提问对应第 n 个需求；一轮里的节点都用这一轮需求的时间，先后顺序按文件位置。子代理线程用它自己的 `assignment.md`。解析不出时间时退而用文件的修改时间（唯一的那个第三方工具不采用修改时间，这里只作为最后的办法，并在诊断里计数）。
- 轮次：每条提问开一轮。
- 项目：没有工作目录，所有 `doubao` 会话归入一个固定的项目，id 为 `doubao-work`，显示名“豆包工作”。
- 首条需求可能在 `trajectory.jsonl` 里没有对应的用户行：这时用 `assignment.md` 里第一个需求的文字补一个提问节点。

### 5.4 子代理

父代理的 `create_agent` 调用，其结果行的内容以 `create_agent ok` 开头，后面有 `agent_id: <子代理>`、`parent_id: …`、`thread_id: …` 三行。子代理的文件是同一会话下 `agents/<子代理>/system/trajectory.jsonl`，显示为会话里的线程并连到这次调用上。解析不出时线程挂在会话下。代理之间互发的消息没有资料，不处理。

## 6. 对现有部分的改动

- `Origin`、`KEY_PREFIXES`、配置（四个目录，`workbuddy` 和 `doubao` 各可以是多个根）、来源的启动与诊断。
- `ProjectIdResolver` 不变。
- 文件来源的公共部分如需支持“一个来源多个根”“二进制分帧文件按字节位置续读”，以可选项的方式加，不改变现有来源的行为。
- 网页：来源的名称、颜色、筛选。
- 异常检测：`COST_EXCLUDED_ORIGINS` 增加 `doubao`。
- 发布包的描述和关键词。

## 7. 测试

所有测试只用临时目录和按格式说明自造的数据；不读写真实的工具目录（沿用守卫测试 `no-real-tool-dirs.test.ts`，把四个新目录加进去）；假密钥在运行时拼接。

| 要证明的事 | 做法 |
|---|---|
| DeepSeek 的分帧解压与续读 | 测试里用 `zlib.zstdCompressSync` 现场生成多帧文件：逐帧追加后只读新帧；末帧不完整时等待；文件变短、首帧变化时整文件重读；结果与一次读完相同 |
| DeepSeek 的记录映射 | 提问的来源种类过滤、三种块、工具配对、标题、目录变化、轮次结束原因、压缩、不显示的事件、未识别类型计数、用量换算 |
| DeepSeek 的版本与环境 | 只有旧版文件的会话被计数并跳过；模拟没有解压函数时来源不启动且诊断写明 |
| DeepSeek 的子代理与分叉 | 子代理文件先到或后到都挂到根会话并连到工具调用；多级；对不上时不连线；分叉显示为独立会话 |
| Buddy 的记录映射 | 每种记录；提问提取的各种包装；非人输入的各个标记；思考的两种字段；结果的各种形状；标题优先级；`auto` 模型 |
| Buddy 的当前分支 | 无标记时全部显示；回退、改写重发、内容过滤、压缩各一例，结果与按算法手算的一致；追加过程中分支切换时移除旧分支的节点 |
| Buddy 的用量 | 去重规则；格式说明 6.3 表里的每种形状 |
| Buddy 的两个产品 | 同一份样例放在三个根下分别得到 `workbuddy` / `codebuddy`；两个 WorkBuddy 根里的重复会话；临时工作目录归到上一级项目（只对 `workbuddy`） |
| Buddy 的子代理 | 按路径归属；按 `subAgent.sessionId` 连线；没有时不连线 |
| 豆包 | 两个变体、多个配置；行映射；按位置识别相同内容的两行；`assignment.md` 的时间与缺行补提问；子代理连线；文件被重写时重读 |
| 四个来源在各功能里 | 项目列表、检索、统计、按文件视图、异常、导出、遮蔽（沿用 `more-sources-features.test.ts` 的做法） |
| 目录不存在 | 不启动，不创建，不监听 |
| 现有来源不变 | 另检出 `main`，在相同的自造输入上对比现有六种来源的全部输出（图、详情、会话、统计、异常、按文件、检索、导出） |
| 资源 | 大文件（数百 MB 的 Buddy 会话、数万帧的 DeepSeek 会话）下的内存和耗时有界，限时测试放在 `timing` 项目并沿用 `AGENT_CANVAS_TIMING_SCALE` |

Linux 和 Windows 的 CI 都运行。

### 7.1 真实机器

- 升级真实数据库前先备份；升级后只看数量：现有来源的原始记录数不变，没有重建，四个新来源在目录不存在时显示“不存在”。

## 8. 文档与发布

- `docs/formats/` 三份格式说明入库。
- 手册新增一节，写四个来源各自读哪里、显示什么、不显示什么、限制，并标明未经真实数据核对；环境变量表增加四项。
- README 的来源列表和说明更新。
- 作为 0.2.0 发布，走打标签自动发版。

## 9. 只有真实数据才能确定的问题

各格式说明末尾列有完整清单。影响最大的几条：

- DeepSeek：Windows 上桌面应用的主目录是否就是 `~/.dsh`；`outputTokens` 是否对所有模型适配器都含思考；界面上的删除、编辑、回退在磁盘上做了什么。
- Buddy：各版本 WorkBuddy 内嵌的引擎版本；`providerData.usage` 在磁盘上的实际形状；`toolResult.subAgent` 是否真的存在；真实的回退和压缩长什么样；重复 id 有多常见。
- 豆包：行里是否还有别的字段；`assignment.md` 的时间格式；重试、编辑、停止时文件怎么变；Windows 上的路径是否与 macOS 一致。
