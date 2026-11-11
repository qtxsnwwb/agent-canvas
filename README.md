# claude-canvas

claude-canvas 是一个本地服务：它读取 Claude Code 的 transcript 文件并接收 hook 事件，在固定的本地网址上用网页展示每个 Claude Code 会话正在做什么。
当前里程碑（M1）提供按会话列出的实时节点列表；画布视图属于后续里程碑，目前还没有。

## 环境要求

- Node ≥ 22
- pnpm（可选：没有全局安装时用 `npx --yes pnpm@10` 代替 `pnpm`）

## 安装、构建、启动

已安装 pnpm：

```
pnpm install
pnpm build
pnpm start
```

未安装 pnpm：

```
npx --yes pnpm@10 install
npx --yes pnpm@10 build
npx --yes pnpm@10 start
```

启动后终端会打印：

```
claude-canvas listening on http://127.0.0.1:4317
```

在浏览器打开 <http://127.0.0.1:4317> 即可。按 Ctrl+C（SIGINT）停止服务。

换端口：`pnpm start --port 4400`（或直接 `node packages/server/dist/cli.js start --port 4400`），打印的地址会随之变化。

首次启动会导入 `~/.claude/projects` 下全部已有的 transcript；历史很多时需要一段时间，导入在后台进行，页面在此期间已可使用（`GET /api/diagnostics` 的 `importing` 为 `true`）。在一份真实数据上测得（340 MB、612 个文件）：导入约 2 分钟，导入完成后数据库约为 transcript 总量的 1.6 倍；导入期间 WAL 文件会临时增长到 transcript 总量的数倍，之后收缩到 64 MB 以内，请为数据目录预留空间。之后服务会持续监视 transcript 的变化。

同一个数据目录只能运行一个服务：启动时会创建锁文件 `<数据目录>/claude-canvas.lock`（记录 pid 和启动时间）。若已有服务在运行，第二次 `start` 会打印 `claude-canvas is already running with this data directory (pid N); lock file: …` 并以退出码 1 退出。上一次进程异常退出留下的锁会被自动接管。

升级 claude-canvas 后，如果推导规则的版本变了（或上次重建被中断），`start` 会在开始监听前自动重建派生数据，先打印 `claude-canvas rebuilding derived data (reason: …)`，再打印正常的监听地址。

## Hooks（可选）

不装 hooks 也能用：服务只靠 transcript 就能工作。区别是：

- 没有 hooks：无法显示“等待权限确认”，状态更新会稍慢（取决于 transcript 写入；文件监听之外，最近活跃会话的文件每 3 秒复查一次，整个目录每 60 秒完整扫描一次）。
- 有 hooks：状态接近实时。

`docs/hooks-snippet.json` 覆盖服务理解的全部 14 个事件：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PermissionDenied`、`PostToolUse`、`PostToolUseFailure`、`SubagentStart`、`SubagentStop`、`Notification`、`Stop`、`StopFailure`、`PostCompact`、`SessionEnd`。每个事件一条 HTTP hook，指向 `http://127.0.0.1:4317/hooks`，超时 2 秒，不设 `matcher`。

### 手动合并到 `~/.claude/settings.json`

1. 先备份：复制 `~/.claude/settings.json` 为 `settings.json.bak`。
2. 打开 `docs/hooks-snippet.json`，把其中 `hooks` 下的每个事件合并进 settings.json 顶层的 `"hooks"` 键：
   - settings.json 里没有 `hooks` 键：直接把整个 `hooks` 对象粘贴为顶层键。
   - 已有 `hooks` 键，但没有某个事件：加上该事件及其数组。
   - 某个事件已有数组：把本片段的那一项（`{ "hooks": [ { "type": "http", ... } ] }`）追加到现有数组里，不要替换原有条目。
3. 保存后，新开的 Claude Code 会话会使用这些 hooks。

### 移除

删除你合并进去的这些条目（url 为 `http://127.0.0.1:4317/hooks` 的那些），或用备份文件覆盖回去。

### 失败行为

claude-canvas 没有运行时，HTTP hook 连接失败会立刻报错，而 Claude Code 把它当作不阻塞的错误，继续正常工作，不受影响。超时设为 2 秒也是为了避免服务卡住时拖慢 Claude Code（HTTP hook 默认超时是 600 秒）。

### 改了端口

如果用 `--port` 改了端口，必须把 settings.json 里每条 hook 的 url 改成相同端口，例如 `http://127.0.0.1:4400/hooks`。

## 数据与环境变量

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `CLAUDE_CANVAS_PROJECTS_DIR` | `~/.claude/projects` | 读取 transcript 的目录 |
| `CLAUDE_CANVAS_DATA_DIR` | `~/.claude-canvas` | 数据目录，数据库文件为 `data.db` |

## rebuild

```
node packages/server/dist/cli.js rebuild
```

它根据数据库里保存的原始事件重新推导出图相关的表，进度打印到 stderr，成功时打印 `claude-canvas rebuild complete`。通常不需要手动运行：升级后 `start` 会按需自动重建。它与运行中的服务共用锁文件，服务在运行时会以“already running”报错退出，先停止服务再运行。

## 安全说明

- 只监听 `127.0.0.1`，不对局域网开放。
- 没有任何认证。为防止网页跨站访问，`Host` 或 `Origin` 不是回环地址的请求会被拒绝（`/hooks` 仍返回空的 200，但内容不会被采纳）。
- 数据库含有你的对话和工具输出的明文，请像对待对话记录本身一样对待数据目录（不要同步到云盘、不要分享）。
- 服务对 transcript 只读；使用默认数据目录（`~/.claude-canvas`）时，不会往 `~/.claude` 下写任何东西（若把 `CLAUDE_CANVAS_DATA_DIR` 设到 `~/.claude` 之下，数据库和锁文件当然会写在那里）。

## 状态与错误在哪里看

- 会话状态：运行中、等待输入、等待权限确认、空闲、已结束。一个“运行中”的会话超过 15 分钟没有任何活动时，页面显示为“长时间无活动”（例如 Claude Code 进程被杀、API 报错后没有后续记录）；它不计入项目的活跃会话数，一有新活动就恢复。
- 错误：读不了的文件、写库失败、hook 处理失败会写到服务的 stderr（每个文件每分钟最多一行，只含路径和错误信息，不含对话内容），并出现在 `GET /api/diagnostics` 的 `ingestFailures` 里。诊断接口还给出未识别的记录类型、最近一次收到 hook 的时间、各文件读取进度、`importing`、推导规则版本 `normalizerVersion` 和数据库标识 `dbEpoch`。

## 已知限制

- transcript 里的思考（thinking）文本经常是空的，所以可能只显示思考时长。
- transcript 格式不是稳定的契约：无法识别的记录类型会被计数，可在 `GET /api/diagnostics` 查看（目前还没有诊断页面）。
- 等待权限确认的工具会一直保持该状态，直到它的结果到达。
- Windows 是经过测试的平台。

## 开发

```
pnpm test        # vitest run
pnpm typecheck
pnpm --filter @claude-canvas/web dev   # web 开发服务器（vite），把 /api 和 /ws 代理到 127.0.0.1:4317，需先启动服务
```

没有 pnpm 时同样用 `npx --yes pnpm@10 <命令>`。
