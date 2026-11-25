# 后台常驻服务

状态：设计中
日期：2026-11-25

## 1. 目的

现在服务只能在终端里用 `agent-canvas start` 跑：终端或启动它的程序一关、电脑一重启，服务就停了。停着的时候，没装 hooks 的来源还能事后从文件补导入，但待处理页、桌面通知、“今天的用量”提醒线都要服务一直开着才有用。用户刚遇到过：服务挂在一个对话的后台进程上，对话那边一停，服务就没了。

这一版让服务“装上就不用管”：登录后自动在后台启动，不弹窗口，意外退出会被拉起来；能查状态、停止、卸载。所有用户都能用：Windows、macOS、Linux 都支持（用户定）。

### 1.1 目标

- `agent-canvas service install`：登记“登录后自动启动”，并立刻在后台启动。
- `agent-canvas service uninstall`：停掉后台服务并删掉登记；数据和日志不动。
- `agent-canvas service status`：服务在不在跑（进程号、端口、版本、跑了多久）、自动启动装没装、日志在哪。
- `agent-canvas service stop` / `start` / `restart`：手动停、手动启动（不用等下次登录）、升级后重启。
- 服务意外退出（崩溃）时自动重新启动；用户主动停止时不重启。
- 后台运行时日志写进文件，有大小上限。

### 1.2 不做的

- 不做 Windows 系统服务（要管理员权限，跑在看不到桌面的会话里，桌面通知弹不出来）。
- 不在登录前、不为其他用户运行。
- 不做托盘图标，不做自动升级。
- 不改 `agent-canvas start` 在终端里的用法。

### 1.3 反目标

- 测试或开发时动到真实的自动启动登记（Windows 的注册表启动项、macOS 的 `~/Library/LaunchAgents`、Linux 的 `~/.config/systemd/user`）。
- 登录时闪出命令行窗口。
- 不经确认就写系统的自动启动登记。
- “停止”直接结束进程，导入写到一半被打断（应先让服务自己收尾）。
- 自动启动指向一个会消失的路径（`npx` 的下载缓存）。

## 2. 做法的选择

| 做法 | 说明 | 取舍 |
|---|---|---|
| **A. 用每个系统自带的登录启动机制（用户选定）** | Windows 用当前用户的注册表启动项，macOS 用 launchd 的用户代理，Linux 用 systemd 的用户服务；`service install` 生成配置并登记 | 都是系统原生的方式，不要管理员权限；要写三套；macOS 本机和 CI 都测不了真实登记 |
| B. agent-canvas 自己当守护进程 | `start --background` 脱离终端，自己重启 | 登录自启仍要靠 A 的机制；多一层自写的守护逻辑 |
| C. 借用 pm2 等进程管理工具 | 让用户另装 pm2 | 多一个大依赖；pm2 在 Windows 上的开机自启不可靠 |

## 3. 每个系统怎么做

### 3.1 Windows（决定）

- **登记位置**：当前用户的启动项 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，值名 `AgentCanvas`。不要管理员权限；会出现在任务管理器的“启动应用”里，用户在那里也能停用。用系统自带的 `reg.exe` 读写，不加依赖。
  - 没用计划任务：查到的资料对“非管理员能否建登录时运行的任务”说法不一，而启动项确定可以；启动项再配上下面的启动脚本，也能做到失败重启。
- **不弹窗口**：启动项运行 Windows 自带的 `wscript.exe //B //Nologo <启动脚本>`；启动脚本是一小段 JScript（不是 VBScript：VBScript 微软已宣布逐步移除），用 `WScript.Shell.Run(命令, 0, true)` 隐藏地运行 node 并等它结束。2026-11-25 在本机（Windows 11）实测：直接启动 node 会弹出 Windows Terminal 窗口；经 wscript 隐藏启动和经 `conhost --headless` 启动都没有窗口。选 wscript 是因为它有文档，而 `conhost --headless` 没有。
- **失败重启**：启动脚本里循环：node 以退出码 0 结束（用户停止、或已有一个服务在跑）就退出循环；否则等一段时间再启动，等待 5、10、20、40、60 秒，之后每次 60 秒；一次运行超过 10 分钟后，等待时间从 5 秒重新算。
- **启动脚本放在** `<数据目录>/service/launcher.js`，`install` 生成，`uninstall` 删除。
- 公司电脑可能用策略禁用了 Windows Script Host：`install` 先试运行一次 `wscript`，不能用就报错并说明，不登记。

### 3.2 macOS

- 用户代理 `~/Library/LaunchAgents/io.github.qtxsnwwb.agent-canvas.plist`（标签同名）。`RunAtLoad` 为真；`KeepAlive` 为 `{ SuccessfulExit: false }`（退出码非 0 才重启）；`ThrottleInterval` 10 秒。
- 登记和取消用 `launchctl bootstrap gui/<uid> <plist>` / `launchctl bootout gui/<uid>/<标签>`。
- 用户代理跑在用户的图形会话里，桌面通知（`osascript`）能弹。

### 3.3 Linux

- systemd 用户服务 `~/.config/systemd/user/agent-canvas.service`：`Restart=on-failure`，`RestartSec=5`，`WantedBy=default.target`。
- 登记：`systemctl --user daemon-reload` 后 `systemctl --user enable --now agent-canvas.service`；取消：`disable --now` 后删文件再 `daemon-reload`。
- 不开 linger：只在用户登录期间运行，和“登录后启动”一致。
- 没有 systemd 用户实例（WSL、容器、不用 systemd 的发行版）：`install` 报错说明，不写任何文件。
- 桌面通知（`notify-send`）要会话的显示和 D-Bus 环境；主流桌面会把它们导入 systemd 用户环境，没有导入时通知弹不出来，手册写明。

### 3.4 三个系统共同的

- **启动命令**：node 的绝对路径（`process.execPath`）+ 这份 `cli.js` 的绝对路径 + `start --port <端口> --log-file <日志路径> --service`。用绝对路径是因为登录启动时的 PATH 和终端里不一样（macOS 的 launchd 只有最基本的 PATH）。
- **环境变量**（决定）：`install` 时把当前设置了的**决定读哪些目录的变量**写进配置（Windows 写进启动脚本，macOS 写进 plist 的 `EnvironmentVariables`，Linux 写进 unit 的 `Environment=`），让后台服务和你在终端里启动的看同样的目录。只记这一份名单，就是 `config.ts` 读的那些：
  - 本工具的：`AGENT_CANVAS_DATA_DIR`、`AGENT_CANVAS_PROJECTS_DIR`、`AGENT_CANVAS_CODEX_DIR`、`AGENT_CANVAS_CURSOR_DB`、`AGENT_CANVAS_GEMINI_DIR`、`AGENT_CANVAS_GROK_DIR`、`AGENT_CANVAS_COPILOT_DIR`、`AGENT_CANVAS_DSH_DIR`、`AGENT_CANVAS_WORKBUDDY_DIR`、`AGENT_CANVAS_CODEBUDDY_DIR`、`AGENT_CANVAS_DOUBAO_DIR`、`AGENT_CANVAS_QWEN_DIR`；
  - 各工具自己的：`GEMINI_CLI_HOME`、`GROK_HOME`、`COPILOT_HOME`、`DSH_HOME`、`WORKBUDDY_CONFIG_DIR`、`CODEBUDDY_CONFIG_DIR`、`QWEN_RUNTIME_DIR`、`QWEN_HOME`（这些常写在 shell 的配置文件里，launchd 和 systemd 启动的进程看不到）。
  - 名单之外的 `AGENT_CANVAS_*`（测试和调优用的开关，例如 `AGENT_CANVAS_TIMING_SCALE`）不记，免得开发时的临时设置变成永久的。名单放在一处，和 `config.ts` 共用，测试保证 `config.ts` 读的每个目录变量都在名单里。
  - `install` 打印的内容里列出记下的变量。
- **不允许从 `npx` 缓存安装**：和 Codex hooks 一样，`cli.js` 在 `npx` 的下载缓存里时，`install` 报错，说明要先全局安装（`npm install -g @qtxsnwwb/agent-canvas`）；从源码目录运行可以。
- **先说明、再确认**：`install` / `uninstall` 先打印要写或删的东西（文件路径和内容、注册表项、要运行的命令），问“继续吗”，`--yes` 跳过，和 `hooks install` 一致。
- **重复安装**：已经装过时，`install` 按当前的路径、端口、变量重写登记（例如换了端口、换了安装位置），说明这是更新。

## 4. 命令

```
agent-canvas service install [--port <n>] [--yes]
agent-canvas service uninstall [--yes]
agent-canvas service status
agent-canvas service start
agent-canvas service stop
agent-canvas service restart
```

- **install**：检查（不在 npx 缓存、系统机制可用、端口合法）→ 打印 → 确认 → 写配置、登记 → 立刻启动（Windows 直接运行一次启动项的命令；macOS 的 `bootstrap` 和 Linux 的 `enable --now` 本身就会启动）。已经有服务在跑（锁被占着，例如终端里开着一个）时：照常登记，但不启动，提示“已有服务在运行（进程号 N）；先停掉它，再运行 `agent-canvas service start`”。
- **uninstall**：打印 → 确认 → 停掉后台服务（见“停止”）→ 取消登记、删配置和启动脚本。数据库、日志、设置都不动。没装过时说“没有装”，退出码 0。
- **status**：一行一项，人能读：
  ```
  服务：正在运行（进程号 18244，端口 4317，版本 0.5.0，已运行 2 小时 3 分）
  自动启动：已安装（Windows 启动项）
  日志：C:\Users\…\.agent-canvas\logs\service.log
  ```
  服务没跑时写“没有运行”；自动启动没装写“没有安装”。Windows 上启动项在任务管理器里被停用时写“已安装，但在任务管理器里被停用”（读 `StartupApproved\Run`）。退出码：在跑 0，没跑 3（与常见服务工具一致）。
- **start**：自动启动装了：通过系统机制启动（Windows 运行启动项命令，macOS `launchctl kickstart`，Linux `systemctl --user start`）。没装：提示先 `install`，或在终端用 `agent-canvas start`。已经在跑：说明并退出码 0。
- **stop**：让正在运行的服务（不管是后台的还是终端里的）正常收尾后退出，见第 5 节。服务退出码为 0，所以三个系统都不会把它拉起来；下次登录照常启动。
  - **也取消待定的重启**（决定）：服务刚崩溃、系统正在等着重启它时（Windows 启动脚本在等待，systemd 在 `RestartSec` 里，launchd 在节流间隔里），那一刻没有进程，但几秒后它又会回来。所以装了自动启动时，`stop` 同时让系统那一侧停下：Linux `systemctl --user stop agent-canvas.service`；macOS `launchctl kill SIGTERM gui/<uid>/<标签>` 后再 `bootout`（下次登录时 launchd 会从 `~/Library/LaunchAgents` 重新加载）；Windows 在 `<数据目录>/service/` 下放一个“已停止”标记，启动脚本每次重启前先看，有标记就退出循环，`start` 和下次登录（启动项命令先删标记）会清掉它。这样一直崩溃的服务（例如端口被占、数据库打不开）也能用 `stop` 停住。
  - 没在跑、也没有待定的重启时说明，退出码 0。
- **restart**：`stop` 再 `start`；升级后用（全局安装升级后路径不变，从源码运行时重新构建后）。

## 5. 停止和状态的实现

- **服务登记清单**（决定）：`install` 在一个固定的、不随数据目录变的位置写一份清单 `service.json`：Windows `%APPDATA%\agent-canvas\`，macOS `~/Library/Application Support/agent-canvas/`，Linux `$XDG_CONFIG_HOME/agent-canvas/`（默认 `~/.config/agent-canvas/`）。清单记数据目录、端口、记下的变量、node 和 `cli.js` 的路径、登记的位置。`status` / `start` / `stop` / `restart` / `uninstall` 有清单时按清单里的数据目录和端口办，没有清单时按当前 shell 的设置（例如只在终端里开了服务时）。这样在设了 `AGENT_CANVAS_DATA_DIR` 的 shell 里装，在普通 shell 里查，也查的是同一个服务；不用为三个系统各写一个读回登记的解析器。`uninstall` 删清单。
- **锁文件记更多**：`agent-canvas.lock` 现在记进程号和启动时间，改为再记端口、版本、是哪个命令拿的锁（`start`、`rebuild`、`compact`）、是否后台模式（`--service`）。旧格式照常读（当作 `start`）。
- **停止请求**：服务启动时在数据目录生成一个随机密钥文件 `control.key`（每次启动换新）。macOS、Linux 上文件权限设为只有当前用户可读写（0600）；Windows 上沿用数据目录继承的权限（决定：默认数据目录在用户自己的主目录下，别的普通用户读不到；不调 `icacls`。这把钥匙只能用来停服务，泄露的后果是服务被同机的人停掉，手册写明数据目录不要放在共享位置）。`service stop` 读锁文件里的端口和这个密钥，向 `http://127.0.0.1:<端口>/api/control/stop` 发 POST，请求头带密钥。服务验证密钥（常量时间比较）后回应，然后走和 Ctrl+C 一样的收尾流程，退出码 0。
  - 带 `Origin` 头的请求一律拒绝（网页发不了这个请求；网页也读不到密钥文件）。
  - 等服务退出最多 30 秒（锁被释放）。超时后：报告“服务没有在 30 秒内退出”，退出码 1，不强制结束（决定：强制结束可能打断写入；用户可以自己结束进程）。
- **后台模式的退出码**：`--service` 模式下启动时锁被占：
  - 占着锁的是另一个服务（`start`，或旧格式的锁）：记一行日志后以退出码 0 退出，避免系统反复重启它。
  - 占着锁的是 `rebuild` 或 `compact`（例如登录时正好在压缩数据库）：记一行日志后以非 0 退出，让系统稍后重试，维护做完后服务自己起来（决定）。
  - 其他启动失败（端口被占、数据库打不开）退出码非 0，会被重试。
- **SIGTERM**：服务也处理 SIGTERM，和 Ctrl+C 一样收尾（macOS 的 `launchctl bootout` 和 Linux 的 `systemctl stop` 发的是它）。

## 6. 日志

- 后台模式写 `<数据目录>/logs/service.log`（`--log-file` 指定路径）：原来打到终端上的每一行，前面加时间。
- 大小上限 5 MB：超过时把当前文件改名为 `service.log.1`（覆盖旧的），再写新文件。最多占 10 MB。
- 日志内容和终端输出一样，不加会话内容。
- 终端里的 `start` 不受影响（不加 `--log-file` 就照旧打到终端）。

## 7. 安全和测试的约束

- 所有测试不碰真实的自动启动登记：注册表、`~/Library/LaunchAgents`、`~/.config/systemd/user` 的路径和要运行的系统命令（`reg`、`launchctl`、`systemctl`、`wscript`）都通过参数注入；测试用临时目录和记录调用的假运行器，断言生成的文件内容和命令序列。
- 停止请求、密钥、锁文件、日志轮换、后台模式退出码：用临时数据目录、临时端口（不用 4317）的真实服务测试。
- Windows 启动脚本的重启循环：在 Windows CI 上用真实 `wscript` 跑一次，命令换成一个按设定退出码退出的小脚本，等待时间可以通过参数调小。
- 真实登记只在本机人工验证时做，而且要用户先同意：Windows 上在本机装一次、`status`、`stop`、`start`、注销重新登录看是否自动启动且不弹窗、`uninstall` 后确认启动项已删。macOS 没法测，Linux 只能在 CI 里测生成的内容（GitHub 的 Linux 机器上 systemd 用户实例不一定可用），手册如实写明。

## 8. 文档

手册新增“后台常驻”一节：
- 三个系统各自用什么机制、文件或注册表项在哪；
- 每个命令做什么、退出码；
- 停止为什么不会被自动拉起；
- 日志在哪、上限多少；
- 要全局安装或从源码运行，不能用 `npx`；
- 环境变量会被记下；换了的话要重新 `install`；
- 升级后 `service restart`；
- 哪些系统真实测过：Windows 测过；macOS 没测；Linux 只测了生成的配置。

README 的安装部分加一句，指向这一节。

## 9. 留给实现的

- 代码怎么拆分、各平台模块的接口。
- 启动脚本的具体写法（在上面的行为范围内）。
- `status` 里“已运行”的格式细节。
- 路径里有非 ASCII 字符（例如中文用户名）时启动脚本的编码、systemd 的 `TimeoutStopSec`、`process.execPath` 是否取真实路径、hooks 用的端口和服务端口不一致时是否提醒。
