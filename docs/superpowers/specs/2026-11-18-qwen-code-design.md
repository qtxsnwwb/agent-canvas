# 接入 Qwen Code

状态：已实现（分支 feat/qwen-code，0.3.0；未经真实数据核对）
日期：2026-11-18

## 1. 目的与范围

在已有的十种来源之外，再读取 Qwen Code（阿里的命令行编码代理）留在本机的会话。显示它的文件里有的东西：用户输入、回复、思考、工具调用及结果、子代理、标题、模型、工作目录、用量、上下文压缩的位置。检索、统计、按文件视图、异常检测、导出、遮蔽、通知照常适用。

`Origin` 增加 `qwen`，共十一种。作为 0.3.0 发布。

### 1.1 没有真实数据

开发机上没有 Qwen Code。实现只依据它的开源代码（`QwenLM/qwen-code` 标签 `v0.27.4`），格式说明在 `docs/formats/qwen-code.md`，每条结论标明出处；它是本设计关于文件格式的依据，实现以它为准。下文“说明 x.y”指这份文件的章节。

测试样例全部按说明自造。测试通过只说明实现与对源码的理解一致，不说明与真实文件一致。文档里这个来源与上一批的四个一样标明“未经真实数据核对”。

### 1.2 不做的

- **托管会话**（说明 4.6）：文件里是包装过的记录，包装格式没有追到。识别出来、不显示、在诊断页计数（见 3.4）。
- **0.4.0 以前的旧文件**（说明 1.5，`tmp/<hash>/chats/session-*.json`）：不读，不计数。
- **按项目各放一份的输出目录**（设置 `advanced.runtimeOutputDir` 为相对路径，说明 1.1）：不自动寻找。用户可以用环境变量指到其中一个。
- Qwen Code 的钩子；会话状态由文件推断。
- `workflows/`、`tmp/` 下的文件；`.runtime.json`、`.worktree.json`、`.pr.json`、`.jsonl.stream`。
- 千问办公（QwenWork）、TRAE CLI：仍等真实数据。

## 2. 位置与标识

- 配置项 `qwenDir`：Qwen Code 的“运行时根目录”（说明 1.1）。取第一个有值的：`AGENT_CANVAS_QWEN_DIR`、`QWEN_RUNTIME_DIR`、`QWEN_HOME`、`~/.qwen`。前三个里的 `~` 展开，相对路径按本程序的工作目录解析。`AGENT_CANVAS_QWEN_DIR` 设为空字符串表示关闭。
- 读的是 `<qwenDir>/projects`。它不存在时来源不启动，不创建、不监听任何东西；服务运行期间才出现的，重启后读取。对这个目录只读。
- 文件键的前缀（`KEY_PREFIXES`）：`qwen:`。会话 id 直接用 Qwen Code 的会话 id，不加前缀。
- 网页上的名称：Qwen Code。颜色、筛选项随之增加。
- 现有十种来源的输出不变；`NORMALIZER_VERSION` 不变；数据库结构不变，升级不重建。
- 守卫测试 `no-real-tool-dirs.test.ts` 和发布脚本的隔离环境加上这个目录。

## 3. 文件

依据：说明第 1 节。

```
<qwenDir>/projects/<项目名>/
    chats/<会话 id>.jsonl                  会话的主线
    chats/<会话 id>.title.json             标题
    chats/archive/<会话 id>.jsonl          归档的会话（标题文件也在旁边）
    subagents/<会话 id>/agent-<名>.jsonl       子代理的线程
    subagents/<会话 id>/agent-<名>.meta.json   子代理的说明
```

- 主线文件名必须是 32 到 36 个十六进制字符或连字符加 `.jsonl`（Qwen Code 自己的规则）；别的名字不读。
- 项目名是工作目录的有损编码，只当作不透明的名字，不用来还原路径。

### 3.1 归档

归档只是把文件从 `chats/` 移到 `chats/archive/`。两处的同一个文件用**同一个键**（`qwen:<项目名>/chats/<会话 id>.jsonl`，标题文件同理）；由键找路径时先看 `chats/`，没有再看 `chats/archive/`。所以归档和取消归档不重读、不重复、不把会话标成“源文件已删除”。两处同时存在时读 `chats/` 的。

### 3.2 读取与重写

Qwen Code 平时只追加，但“删除消息组”会整个替换文件（说明 4.4）。沿用上一批的做法（上一批设计 10.5、10.6、10.21）：

- 主线和子代理文件用 `readGuardedLines` 读，行按位置识别（`lineIdentity: 'offset'`）。
- 文件变短，或已读部分的开头、结尾的字节变了：认作重写，整个文件重新读、重新存一代，会话重新推导。
- 文件存在却一时读不了：不是重写，抛给管线，下次再读。
- 标题文件和子代理说明文件整个读，作为元数据事件。

### 3.3 项目归属

- 工作目录取自记录的 `cwd`（每条记录都有，值都一样）。来源给文件分类时从头往后找：超过 64 KiB 的行跳过、不读进内存，取第一条不超过 64 KiB 的有效记录；还没有这样的记录时会话暂不分类、不显示。每个字节只看一次，下次从上次停下的地方接着找。
- 工作目录落在 `<仓库>/.qwen/worktrees/` 之下时，项目取 `<仓库>`（Qwen Code 自己也把它们算作同一个项目）；会话的工作目录照原样显示。
- 项目 id 用 `ProjectIdResolver.forCwd`，与 DeepSeek、WorkBuddy、CodeBuddy 共用同一个解析器（上一批设计 10.23）。
- 子代理文件的项目跟它的会话走。

### 3.4 托管会话

来源给主线文件分类时看它的第一条记录（前面可以有一条 `session_execution_engine` 记录）：是 `managed_session_header_v1` 记录的，是托管会话，不读，计入诊断的 `unsupportedSessions`（`FileSourceStatus` 新增的可选项）。它的子代理文件也不读。

### 3.5 同一个会话 id 出现在两个项目目录下

Qwen Code 自己不会这样写；用户复制了 `projects/` 下的一个项目目录时会出现。一个会话 id 只归一个项目目录，只读它的文件（主线、标题文件、`subagents/<会话 id>/` 下的文件）；其余目录里的这几样都不读，在诊断的 `duplicateSessions` 里计数（每个多出来的目录算一个）。归属在列目录时决定，不取决于路径排序或分类的先后：已经存进数据库的那一份优先；都没存过时，取目录名按字符编码（逐个 UTF-16 码元）比较最小的。归属者的主线文件还在就一直归它；它真的不见了，下次列目录时由仍在的另一份接手，会话不标“源文件已删除”。同一个目录里 `chats/` 和 `chats/archive/` 是同一个键（3.1），不算重复。

接受、不改（整体评审复查 R-1、R-2、R-4）：都没存过时只按目录名选，不看哪一份更新，可能选中旧的一份；归属者的文件被删、另一份接手之后原文件又回来，两份都已存过，重启后目录名小的一份胜出，显示的可能换成另一份，之后追加的记录可能成为历史缺口；启动后第一次列目录之前由文件变动事件先遇到的会话 id，归第一个主线文件存在或已存过的目录（只在这一小段时间里与“先后无关”有出入）。这些都要用户手动复制或来回移动目录才会出现，手册注明。

## 4. 记录到节点

依据：说明第 2、3 节。一行一条记录。无效的行（不是对象；`uuid`、`sessionId` 不是字符串；`parentUuid` 既不是字符串也不是 null；`type` 不是四种之一）跳过并计数。主线文件里 `sessionId` 与文件名不符的行跳过并计数。

### 4.1 对话记录

| 记录 | 显示为 |
|---|---|
| `user`，无 `subtype` | 提问，开一轮（文字见 4.3）；`provenance` 是 `mod_prompt` 的显示为系统节点 |
| `user` / `mid_turn_user_message` | 提问，留在当前轮里 |
| `user` / `notification`、`cron` | 系统节点，文字取 `systemPayload.displayText`，没有时取文本段 |
| `user` / `realtime_message` | 提问 |
| `user` / `goal_runtime`、`agent_mention`、`agent_message` | 不显示 |
| `assistant`（含 `realtime_message`） | 按 `message.parts` 的顺序：`thought: true` 的文本段是思考；其余文本段是回复；`functionCall` 是工具调用。只带 `thoughtSignature` 而没有可见文本的段不显示。图片等非文本段显示为 `[image]` |
| `tool_result` | 对应调用的结果（见 4.2） |
| `tool_result` / `code_mode_tool_result`、`tool_loop_end` | 不显示 |

- 模型：回复记录上的 `model`，记在节点详情里。
- 同一个 `uuid` 的多行是一条记录的片段：各段的 `parts` 按出现顺序相接，`usageMetadata` 取最后一份，`model` 和 `toolCallResult` 取第一份。

### 4.2 工具调用与结果

- 结果记录里的 `functionResponse.id`（等于 `toolCallResult.callId`）对上回复记录里的 `functionCall.id`。只在当前分支上、结果之前的调用里找，取最近的一个还没有结果的。
- 没有 id 的结果：与它的父记录（回复）里同名的、第一个还没有结果的调用配对。
- 配不上的结果丢弃并计数。没有结果的调用显示为进行中。
- 状态：`toolCallResult.status` 为 `error` 或 `functionResponse.response` 里有 `error` 时是失败；`cancelled` 是失败并注明取消；其余是成功。子代理文件里成功的结果没有 `status`，也是成功。
- 结果的正文取 `functionResponse.response.output`，没有时取 `.error`。`toolCallResult.resultDisplay` 是字符串时作为结果的摘要。
- 工具名为 `agent`（旧名 `task`）的调用是子代理的派发节点（见第 6 节）。

### 4.3 提问的文字

照 Qwen Code 自己的显示规则（说明 3.4）：

1. `systemPayload` 是对象、`displayText` 是字符串，并且（`hookContext` 是字符串，或最后一段是完整的钩子上下文段）：显示 `displayText`。空字符串也算数，不退回到别的规则。
2. 没有 `systemPayload`、有多段且最后一段是完整的钩子上下文段（`<qwen:user-prompt-submit-context>` 包起来的）：显示去掉最后一段的各段。
3. 其余：照原样显示各文本段。

显示出来的文字为空、又没有图片的提问仍是一条提问（Qwen Code 认为空的 `displayText` 有意义）。

### 4.4 系统记录

| `subtype` | 处理 |
|---|---|
| `chat_compression` | 系统节点“上下文已压缩”，带压缩前后的 token 数；`compressedHistory` 不进节点详情。之前的记录继续显示 |
| `slash_command`，`phase: 'invocation'`，没有 `hiddenInvocation` | 系统节点，文字是 `rawCommand` |
| `custom_title` | 标题（见第 7 节） |
| `turn_result` | 一轮的结果（见第 8 节） |
| `agent_bootstrap`、`agent_launch_prompt`、`agent_retry`、`agent_session_ready` | 不显示（子代理文件里的） |
| 说明 2.3 列出的其余 `subtype`（`rewind`、`slash_command` 的结果、`at_command`、`ui_telemetry`、各种 `session_*`、快照、目标模式、`managed_session_*` 等） | 不显示，不计入未识别 |
| 没有列出的 `subtype` | 跳过，计入未识别（`unknownTypeName`，形如 `system/<subtype>`） |

`user`、`assistant`、`tool_result` 上没有列出的 `subtype` 同样跳过并计入未识别。

### 4.5 用量

照 Qwen Code 自己的算法（说明 3.3），换算到本项目的口径（上一批设计 10.2）：

- 缓存读取 = `cachedContentTokenCount`。
- 输入 = max(0, `promptTokenCount` − `cachedContentTokenCount`)。缓存写入没有存盘，无法单列。
- 输出：设 `derived = totalTokenCount − promptTokenCount`。`totalTokenCount > 0` 且 `candidates ≤ derived ≤ candidates + thoughts` 时取 `derived`；否则认证方式是 OpenAI 兼容、OpenAI Responses 或 Qwen OAuth 时取 `candidates`，其余取 `candidates + thoughts`。
- 认证方式不在回复记录上：取当前分支上此前最近的 `session_model` 记录或提问记录的 `executionContext.authType`；都没有时按“其余”处理。子代理线程只用它自己当前分支上找到的认证方式（同样取 `session_model` 记录或提问记录的 `executionContext.authType`），不借用主线的：借用会让结果取决于文件读到的先后。说明 5.2 列出的子代理记录都不带认证方式，所以实际上按“其余”处理。
- 一条回复记录是一次模型回复，用量记在它的第一个显示节点上；不需要去重键。`ui_telemetry` 里重复的数字不计。
- `/branch` 复制出来的会话带着原会话的用量，跨会话相加时会重复。手册注明。

## 5. 当前分支

依据：说明第 4 节。记录用 `parentUuid` 连成一棵树，系统记录也在链上。回退不删除任何行，只是让之后的记录接到更早的位置上。

- 当前分支 = 从文件里最后一条“对话记录”沿 `parentUuid` 走到头所经过的记录。`session_artifact_event`、`session_artifact_snapshot`、`session_sources_snapshot` 和 `managed_session_*` 不算对话记录，既不当叶子也不参与连接。
- 只显示当前分支上的记录；不在分支上的节点移除（现有的 `node_removed`）。分支上的用量随节点走（上一批设计 10.4）。
- 走到一个文件里没有的父记录时停下（Qwen Code 称为历史缺口），更早的记录不显示。计数。
- 环：停下，计数。
- 标题不受分支限制（见第 7 节）。
- 增量：新记录接在当前末尾时只追加；否则重新求分支，移除不再在分支上的节点。逐行读、一次读完、重建三者结果相同。
- 子代理文件同样处理（恢复运行时会留下死分支）。

## 6. 子代理

依据：说明第 5 节。

- 归属看路径：`subagents/<会话 id>/agent-*.jsonl` 是该会话的子代理线程。线程的 id 取记录里的 `agentId`（文件名是它的有损形式）；读到记录之前用文件名里的。
- 连到派发节点：说明文件的 `toolUseId` 等于 `agent` 调用的 `functionCall.id`。`parentAgentId` 为 null 时在主线里找，否则在那个子代理的线程里找（嵌套）。
- 没有说明文件时：`agentId` 以 `-<调用 id>` 结尾，按这个后缀去对还没有连上线程的 `agent` 调用。对不上时线程挂在会话下，不连线。
- 有有效说明文件、但它的 `toolUseId` 对不上任何调用时，线程不连线：后缀规则只用于没有有效说明文件的线程。
- 说明文件先到或后到、线程先到或后到，结果相同。
- 线程里的 `agent_bootstrap`（分叉式子代理继承来的整段上下文）不显示。
- 子代理的回复分成多条记录（一条带文字和用量，之后每个工具调用各一条）：各自成节点，用量只出现一次，不需要合并。
- 模型取说明文件的 `model`；节点的标题取 `agentType`，没有时取记录的 `agentName`，再没有取调用参数的 `subagent_type`。
- 后台子代理完成时主线里的通知记录照 4.1 显示为系统节点。
- 子代理线程里带 `externalInputKind`（`message` 或 `notification`）的 `user` 记录是送进运行中子代理的消息（说明 5.2），显示为系统节点，标题分别是 Message、Notification，不是提问。

`parent_session` 记录标的是“子会话”（另一个完整的会话文件），不是子代理；子会话显示为独立的会话。

## 7. 标题、工作目录、时间

- 标题按这个次序取第一个有的：文件里**物理位置上**最后一条 `custom_title` 记录（不管是否在当前分支上）；标题文件，仅当它的 `source` 是 `manual` 或 `auto`；第一条无 `subtype` 的提问的显示文字（空的跳到下一条）。
- 工作目录：第一条记录的 `cwd`；之后的记录不同时更新。
- 开始时间是第一条记录的时间；最近活动是读到的记录里最晚的时间。

## 8. 会话状态与通知

只看主线的当前分支：

- 最后一条“状态记录”是提问（无 `subtype`、`mid_turn_user_message`、`realtime_message` 的用户记录）：运行中。
- 是 `turn_result`：空闲。`state` 为 `error` 时在这一轮里加一个“Turn failed”系统节点（带 `error` 的文字），为 `cancelled` 时加“Interrupted”；它们随分支移除和恢复。于是“跑完了”“出错中断”通知都有效。
- 文件里从来没有 `turn_result`（较早的版本不写）：有提问就一直是运行中，与上一批的 WorkBuddy 相同。手册注明。
- 文件被重写后按新内容重新推导。
- 已被丢弃的分支如果重新回到当前分支上（Qwen Code 的任何操作都不会这样做），它的结果会再通知一次；这一点接受，与 WorkBuddy / CodeBuddy 相同。

## 9. 各功能里的表现

- 按文件视图：没有逐个核对过 Qwen Code 各工具的参数名。按保守的对照表实现（`file_path`、`absolute_path`、`path` 依次尝试；写入类工具按名字里的 `write`、`edit`、`replace` 判断），手册标明未经核对。
- 异常检测：有用量，参与“消耗异常高”。
- 导出、遮蔽、检索：照常。
- 诊断页的 `sources` 增加 `qwen`：目录、是否存在、是否在读、会话数、`unsupportedSessions`、`duplicateSessions`（3.5）。

## 10. 对现有部分的改动

- `Origin`、`ORIGINS`、`KEY_PREFIXES`、配置（`qwenDir`）、来源的启动与诊断、规整器的登记。
- 新的文件来源和新的规整器。规整器的结构照 Gemini 的（线程是一串有序的消息，节点是消息的函数，每次输出差异），因为它已经能处理“节点会消失”和“早先的节点被后来的记录更新”这两件 Qwen Code 需要的事。Gemini 规整器里与内容格式有关的小函数（取文本段、取工具输出、工具摘要等）可以导出共用，但不改变它们的行为，也不改变 Gemini 的输出。
- 文件来源的接口如需支持“一个键对应两个可能的路径”，以不改变现有来源行为的方式加。
- 网页：名称、颜色、筛选；诊断页多显示一项状态。
- 发布包的描述和关键词；README、手册。

## 11. 测试

所有测试只用临时目录和按说明自造的数据；不读写真实的工具目录；假密钥在运行时拼接。

| 要证明的事 | 做法 |
|---|---|
| 文件的识别 | 主线、归档、标题、子代理、说明文件各一例；名字不合规的不读；被忽略的旁文件不读也不报错 |
| 归档 | 归档、取消归档前后会话相同，不重读、不重复、不标为已删除；两处同时存在时读 `chats/` 的 |
| 重写 | 删除消息组式的整文件替换后，被删的内容消失，其余不变；读不了的文件不是重写 |
| 记录映射 | 4.1、4.4 表里的每一行；片段合并；无效行；未识别的 `subtype` 计数 |
| 提问的文字 | 4.3 的三条规则各一例，含空的 `displayText` |
| 工具配对 | 并行调用、没有 id 的结果、配不上的结果、没有结果的调用、三种状态、子代理文件里的简略结果 |
| 用量 | 说明 3.3 表里的三种上游各一例；`derived` 落在区间内外；认证方式的三个来处；片段上的用量不重复计 |
| 当前分支 | 回退、改写重发、恢复工具回答、压缩、标题锚点形成的侧叶、历史缺口、环；逐行、一次读完、重建三者相同；与按 Qwen Code 的规则手算的一致 |
| 子代理 | 说明文件先到或后到；没有说明文件按后缀连线；嵌套；对不上时不连线；`agent_bootstrap` 不显示；恢复后的死分支 |
| 标题 | 三个来处的优先次序；不在当前分支上的标题记录仍然生效 |
| 状态与通知 | 运行中、三种 `turn_result`、回退后的状态、没有 `turn_result` 的文件；“跑完了”“出错中断”各触发一次 |
| 托管会话 | 不显示，计数；它的子代理文件也不读 |
| 项目 | 工作目录在 `.qwen/worktrees/` 下时归到仓库；与同目录的 Claude Code 会话是同一个项目；Windows 上小写的项目名不影响 |
| 在各功能里 | 项目列表、检索、统计、按文件视图、异常、导出、遮蔽（沿用 `more-sources-cn-features.test.ts` 的做法） |
| 目录不存在 | 不启动，不创建，不监听 |
| 现有来源不变 | 另检出 `main`，在相同的自造输入上对比现有十种来源的全部输出 |
| 资源 | 几万行的会话、很长的单行（压缩历史、继承的上下文）下的内存和耗时有界；大量回退时分支重算不是平方级。限时测试放在 `timing` 项目，沿用 `AGENT_CANVAS_TIMING_SCALE` |

Linux 和 Windows 的 CI 都运行。与路径排序有关的行为要在两种路径分隔符下都确定（上一批在这里出过一次只在 Linux 上暴露的问题）。

### 11.1 真实机器

升级真实数据库前先备份；升级后只看数量：现有来源的原始记录数不变，没有重建，`qwen` 在目录不存在时显示“不存在”。

## 12. 文档与发布

- `docs/formats/qwen-code.md` 入库。
- 手册新增一节：读哪里、显示什么、不显示什么、限制，标明未经真实数据核对；环境变量表增加一项。
- README 的来源列表更新。
- 作为 0.3.0 发布，走打标签自动发版。

## 13. 只有真实数据才能确定的问题

完整清单在格式说明末尾。影响最大的几条：

- 主线里的 `functionCall.id` 是否对每种上游都有，是否在一个会话里唯一。
- `usageMetadata` 是否每条回复都有，`totalTokenCount` 与各分项的关系（决定输出怎么算）。
- 真实的用户记录有几段，`systemPayload` 缺失得多不多。
- 按“最后一条对话记录”求分支在真实的回退会话上是否符合预期，标题锚点会不会遮住有效记录。
- `ui_telemetry` 每轮有多少条（影响存储量）。
- 托管会话有多常见。
- Windows 上记录里的 `cwd` 长什么样。
