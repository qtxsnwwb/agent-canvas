# On-disk format: Doubao Work / 豆包工作 (re-verified against raw text)

Date: 2026-11-17. Public sources only: no installation, no real session file was seen.

## How to read the marks

| Mark | Meaning |
|---|---|
| `[3P path:lines @sha]` | Third-party source text read raw (`raw.githubusercontent.com`, line numbers from the raw file) at the pinned commit |
| `[DOC url]` | Official ByteDance documentation. **Read through a summarising fetcher, not raw HTML** (the pages are JS-rendered); quotes are as returned by it |
| `[INF]` | My inference; not stated by any source |

Pinned commits:

| Short | Repository @ commit | What it is |
|---|---|---|
| LS | `alibaba/loongsuite-pilot` @ `5de65501092685dc2a697ee73a81f8b5c4f86fc7` | Telemetry collector with a `doubao-work` input; the only code found that parses `trajectory.jsonl` |
| DC | `Fullstop000/doubao-cli` @ `62dd0ac1a0d1435f3978ce78c33b0202c3e6c8bf` | macOS CLI that drives the app over CDP; reads `Local State`, IndexedDB cache, `Sessions` |
| WK | `iAmCorey/Wake` issue #86 (opened 2026-11-10, open, 0 comments); repo head `3aabdc1d5ff903b4ef4de4e7fc21cfb39b52484c` | Feature request with a first-hand description. **The repo has no Doubao code** (no file matching `doubao` in the tree at that head) |

File shorthands: LS `native` = `src/inputs/doubao-work/doubao-work-native.ts`, likewise `content`, `reader`, `rounds`, `demand`, `execution`, `log`, `input`; LS `paths` = `src/utils/doubao-work-paths.ts`; LS `doc` = `docs/zh-CN/doubao-work.md`; LS `fixture` = `tests/helpers/doubao-work-fixture.ts`. BM `tt` = `src/services/traex-transcript.ts`, `tp` = `src/services/traex-paths.ts`, `ct` = `src/services/codex-transcript.ts`, `compat` = `docs/traex-rollout-compatibility.md`.

No other reader of Doubao Work files was found (two web searches; Wake has none). No official documentation of the session files exists.

---

# Part A — Doubao Work / 豆包工作


## A1. Paths

### Roots

| Variant | Windows | macOS | Namespace dir |
|---|---|---|---|
| Standalone DoubaoWork | `%LOCALAPPDATA%\DoubaoWork\User Data` | `~/Library/Application Support/DoubaoWork` | `.doubaowork` |
| Doubao app, work mode | `%LOCALAPPDATA%\Doubao\User Data` | `~/Library/Application Support/Doubao` | `.doubao` |

- All four roots and both namespaces `[3P paths:22-31 @LS]`. Windows uses `~/AppData/Local` when `LOCALAPPDATA` is unset `[3P paths:25 @LS]`. Any other platform: no path `[3P paths:26-27,32 @LS]`.
- macOS roots confirmed independently: `~/Library/Application Support/<DoubaoWork|Doubao>` `[3P src/app.mjs:8-9,22 @DC]`; `~/Library/Application Support/Doubao/<Profile>/.doubao/...` `[3P WK issue body]`.
- The namespace is `.` + URL scheme (`doubaowork` / `doubao`) `[3P src/app.mjs:8-9,63-66 @DC]`.
- Windows roots have one source only (LS; its doc says validated on real Windows clients on 2026-10-30 `[3P doc:88 @LS]`).
- LS log dir: `<root>/sdk_storage/log`; snapshot root: `<root>/coding/snapshot` `[3P paths:29-30 @LS]`.

### Tree (same under both variants; `<NS>` = namespace dir)

```
<root>/
├── Local State                                   JSON: profile.last_used, profile.info_cache{<dir>:{name}}
├── <Profile>/                                    "Default" or "Profile N"
│   └── <NS>/agent_mode/workspace/
│       ├── .skills/<name>/SKILL.md
│       └── .sessions/<conversationId>/
│           ├── board.md                          (WK only; unparsed)
│           ├── memory/MEMORY.md                  (WK only; unparsed; may be empty)
│           ├── attachments/                      (WK only)
│           └── agents/<agentId>/system/
│               ├── assignment.md
│               └── trajectory.jsonl
├── coding/snapshot/<accountId>/<conversationId>/<executionKey>/<agentId>.json
└── sdk_storage/log/saman_frontend_YYYY.MMDD.N.log   (macOS)  |  saman_YYYY.MMDD.N.log (Windows)
```

- Session path segments: `<Profile>/<NS>/agent_mode/workspace/.sessions/<conversationId>/agents/<agentId>/system/{trajectory.jsonl,assignment.md}` `[3P reader:78,87-92,179 @LS; native:28,84,94,114 @LS]`; same tree described by `[3P WK issue body]`.
- `.skills/<name>/SKILL.md` under the same workspace `[3P demand:38 @LS]`.
- `system` is a literal in LS; WK wrote `<sysDir>` — WK implies the name may vary, LS assumes it does not.
- Log file names `[3P doc:79-80 @LS; log:65 @LS]`.

### Profiles

- LS: directory entries of `<root>` named exactly `Default` or matching `^Profile \d+$`; more than 16 → give up; any that is not a real directory (or is a symlink) → give up `[3P reader:175-176 @LS; native:22-27 @LS]`.
- LS looks a conversation up in every profile and uses it only when **exactly one** profile has it; the same id in two profiles is skipped as ambiguous `[3P reader:177-183 @LS; native:39 @LS; doc:46 @LS]`.
- DC: reads `<root>/Local State`, `profile.info_cache` keys are the profile directories, `profile.last_used` the active one; fallback `Default` `[3P src/storage.mjs:13-30 @DC; src/app.mjs:52-61 @DC]`.
- WK: "`Default`, `Profile 1/2/4/6`, … — must glob" `[3P WK issue body]`.

### Identity

| Thing | Identity | Evidence |
|---|---|---|
| Conversation | Name of the directory under `.sessions`. LS accepts `^[a-zA-Z0-9_-]{1,128}$` for the directory, but its snapshot code requires `^\d{1,30}$`; DC treats ids as `\d{12,24}` | `[3P native:10,20 @LS; execution:36,52 @LS; src/storage.mjs:107 @DC]` |
| Agent | Name of the directory under `agents/`, `^[a-zA-Z0-9_-]{1,128}$`; at most 64 per conversation | `[3P native:10,88-89 @LS; reader:81-82 @LS]` |
| Main agent | The one agent directory matching `^m_[a-zA-Z0-9]+$`. WK: the `- Role: main` line of `assignment.md` | `[3P native:63-64 @LS; reader:83-84 @LS; WK]` |
| Other agent kinds | Fixture ids use `o_…` (organizer) and `s_…` (leaf); the snapshot's `agentType` is one of `sub_agent`, `organizer`, `main_agent`. The prefix→kind mapping is not stated anywhere | `[3P fixture:56-59 @LS; execution:21,41 @LS]` `[INF]` |

### Sibling files as the readers parse them

**`assignment.md`** — Markdown, "append-only, native per-agent task file" `[3P content:54-55 @LS]`.
- Section header regex: `^## \[([^\]\r\n]+)\] 需求\r?\n` (multiline, global) `[3P content:56 @LS; reader:334 @LS]`.
- Time: `Date.parse(<bracket text>)`; must be a safe integer, otherwise the section is dropped `[3P content:58-60 @LS; reader:343,353 @LS]`. LS tests write it with `Date.toISOString()` (`2026-…T…Z`) `[3P tests/unit/inputs/doubao-work-content.test.ts:9 @LS]`; the real format is not shown anywhere.
- Body: text from the end of the header line to the next header, trimmed; dropped if empty or over 64 KiB `[3P content:27-30,59 @LS; reader:354-355 @LS]`.
- Everything before the first header ("the file's administrative header") is ignored `[3P content:54-55 @LS; reader:344 @LS]`. This is presumably where `- Role: main` lives `[INF]`.
- A body may start with one or more complete `<system-reminder>…</system-reminder>` blocks; a section made only of such blocks is a notification, not a demand `[3P demand:6-25 @LS; content:98-105 @LS]`.

**`coding/snapshot/<accountId>/<conversationId>/<executionKey>/<agentId>.json`** — JSON object `[3P execution:51-103 @LS; doc:34 @LS]`.
- `<accountId>`: `^\d{1,30}$`, at most 8; `<executionKey>`: UUID; file name = `<agentId>.json` `[3P execution:9,61-62,73,80 @LS]`.
- Only the `execution` object is read `[3P execution:30-46 @LS]`:

  | Field | Type / check |
  |---|---|
  | `executionKey` | UUID string; must equal the directory name |
  | `conversationId` | digits string; must equal the directory name |
  | `queryMessageId` | UUID string |
  | `agentId` | id string; must equal the file name |
  | `agentType` | `"sub_agent"` \| `"organizer"` \| `"main_agent"` |
  | `sandboxId` | id string |
  | `startedAtMs`, `endedAtMs` | integers, epoch ms, 2020 ≤ t < 2100, end > start |

- Meaning of the two times: local sandbox acquired → sandbox released after file capture; not model time, not a tool interval `[3P execution:27-29 @LS; doc:34 @LS]`.
- Written **only for executions that changed tracked files**; pure Read/Bash, cloud-only or never-materialised sub-agents have none `[3P execution:48 @LS; doc:42 @LS]`.
- The file also holds business file contents that LS deliberately ignores `[3P execution:29 @LS; doc:46 @LS]`. LS's test fixture writes siblings `execution.userId`, `files: [{path}]`, `fileContents` `[3P tests/unit/inputs/doubao-work-execution.test.ts:25 @LS]` — synthetic, but it suggests a `files[].path` list exists `[INF]`.

**`sdk_storage/log/*.log`** — text, one event per line `[3P log:63-81,86-182 @LS; fixture:11-49 @LS]`.
- Line head: `[<pid>:<tid>:MMDD/HHMMSS.<ffffff|fff>:<INFO|WARNING|ERROR>:<FRONTEND|CONSOLE>(0)]`, **local wall time without a year**; the year comes from the file name `[3P log:63-81 @LS]`.
- Request events: `[office-api-logger]` lines containing `{"version":1,"type":"event","eventName":…,"meta":{…}}` with `eventName` in `on_message_session_start`, `on_message_sending_start`, `on_message_sending_end`, `general_agent_message_id_mapping`, `on_message_session_end`, `flow_message_time`; `meta.conversation_id`, `meta.chat_session_id`, `meta.query_send_timestamp` (epoch), `meta.send_local_message_id` `[3P log:9,143-182 @LS; fixture:14-23 @LS]`.
- Local tool events: `[agent-task]` lines with `{"event":"toolcall","data":{name, sandbox_id, status:"received", tcid, agent_id}}` and a settled counterpart (`phase:"execution_settled"`, `toolCallID`, a status) `[3P log:123-138 @LS; fixture:40-43 @LS]`. `tcid` equals the trajectory's `tool_calls[].id` `[3P content:138-149 @LS]`.
- On Windows the logged tool name is `Bash` where the trajectory says `PowerShell` `[3P content:135-136 @LS; doc:56 @LS]`.
- A log-only Bash call with id `present-files-path-inspection-<UUID>` accompanies `present_files` and has no trajectory row `[3P log:15 @LS; doc:26 @LS]`.

**`board.md`, `memory/MEMORY.md`, `attachments/`** — named only by WK. No parser, no format.

**Other stores (DC only; not a transcript):** `<Profile>/IndexedDB/chrome_<scheme>-chat_0.indexeddb.leveldb/*.{log,ldb}` scanned byte-wise for `conversation_id` + `name` (title, ≤240 chars) `[3P src/storage.mjs:5-7,71-161 @DC]`; `<Profile>/Sessions/{Session,Tabs}_*` scanned for `<scheme>://<scheme>-chat/chat/<id>` (current conversation) `[3P src/storage.mjs:163-193 @DC]`.

## A2. `trajectory.jsonl` rows

UTF-8, one JSON object per line, `\n` terminated; empty lines skipped `[3P native:69-72,109-110 @LS; reader:258-268 @LS]`. A row that is not a JSON object invalidates the file for LS `[3P native:73 @LS; reader:279 @LS]`.

Fields the reader touches — **nothing else is read, so nothing else is known**:

| Field | On rows | Type as checked | Evidence |
|---|---|---|---|
| `role` | all | `"user"` \| `"assistant"` \| `"tool"`. Any other value: the row is silently dropped from the visible history (not an error) | `[3P rounds:178 @LS]`; WK: "roles only user/assistant/tool … no system records" |
| `content` | all | **string**. Every read is guarded by `typeof … === 'string'`; a non-string is treated as "no text". No code handles an array of parts | `[3P content:27-30,50,91,93 @LS; rounds:181,184 @LS; reader:288 @LS]` |
| `tool_calls` | assistant | array (optional; may be absent or empty). Several entries = one parallel batch | `[3P content:69-86 @LS; doc:14 @LS]` |
| `tool_calls[].id` | | string, `^[a-zA-Z0-9_-]{1,128}$`; unique within the conversation (a repeat invalidates content) | `[3P content:70-74 @LS; reader:115 @LS]` |
| `tool_calls[].function.name` | | string, `^[a-zA-Z0-9_.:-]{1,256}$` | `[3P content:74-75 @LS]` |
| `tool_calls[].function.arguments` | | **object or JSON string**; both accepted, a string is `JSON.parse`d; only a non-array object is kept | `[3P content:76-83 @LS; rounds:188-193 @LS]`. WK: "already an object". LS tests use both forms `[3P tests/unit/inputs/doubao-work-content.test.ts:11,85 @LS]` |
| `tool_call_id` | tool | string; pairs with an earlier `tool_calls[].id` of the same agent; one result per call | `[3P content:87-91 @LS]` |

Not read by any reader, so presence is unknown: `name` on tool rows, `tool_calls[].type`, `tool_calls[].index`, any reasoning field (`reasoning_content` or similar), any row id, timestamp or metadata.

Reasoning: WK says "no thinking blocks" `[3P WK]`; LS says cloud reasoning is not supplied `[3P doc:28 @LS]`.

Observed ordering rules:
- Results of a parallel batch may come in any order `[3P tests/unit/inputs/doubao-work-content.test.ts:61-66 @LS]`.
- An assistant row with text **and** `tool_calls` exists (intermediate plan) `[3P same test:11 @LS]`.
- An agent's final answer = last assistant row without `tool_calls` `[3P content:49-51 @LS]`.
- Adjacent identical final assistant rows occur and are collapsed to one `[3P rounds:95-97,117-120 @LS; doc:48 @LS]`.

Tool names seen in LS code/tests/docs: `Read`, `Write`, `Edit`, `Bash`, `PowerShell`, `Wait`, `create_agent`, `present_files` `[3P doc:21,26,42,56 @LS; fixture:41,52 @LS]`. A `Wait` result is a JSON string with `started_at`, `ended_at` (parseable dates) and `actual_waited_seconds` (number) `[3P src/flushers/doubao-work-round-converter.ts:152-162 @LS]`.

Examples — **constructed from reader code, not a real file**:

```json
{"role":"user","content":"Summarise the three reports in this folder"}
{"role":"assistant","content":"I will read the files first.","tool_calls":[{"id":"call_a1","function":{"name":"Read","arguments":{"file_path":"report-1.md"}}},{"id":"call_a2","function":{"name":"Read","arguments":"{\"file_path\":\"report-2.md\"}"}}]}
{"role":"tool","tool_call_id":"call_a2","content":"…file text…"}
{"role":"tool","tool_call_id":"call_a1","content":"…file text…"}
{"role":"assistant","tool_calls":[{"id":"call_w1","function":{"name":"Wait","arguments":{"seconds":30}}}]}
{"role":"tool","tool_call_id":"call_w1","content":"{\"started_at\":\"2026-11-17T02:00:00Z\",\"ended_at\":\"2026-11-17T02:00:30Z\",\"actual_waited_seconds\":30}"}
{"role":"assistant","content":"Here is the summary: …"}
```

(The `Wait` argument name `seconds` and the `file_path` argument are invented; only the result keys are from code.)

## A3. Title, prompt, time, folder, model, tokens

| Wanted | Where the readers get it | Status |
|---|---|---|
| **Title** | LS: nowhere. DC: IndexedDB cache `name`, or server API `conversation.name`; rename is limited to 20 characters `[3P src/storage.mjs:117-124 @DC; src/sessions.mjs:12-28 @DC; src/session-actions.mjs:14 @DC]`. WK: `board.md`, format unspecified | No file-based title rule is verified. Safe fallback: first demand text, truncated `[INF]` |
| **User's typed prompt** | The `## [time] 需求` sections of the **main agent's** `assignment.md` are the demands; `user` rows in the trajectory are the same demands in a slightly different rendering | See rules below |
| **Timestamps** | (1) `assignment.md` header time per demand; (2) snapshot `startedAtMs`/`endedAtMs` per local execution; (3) log lines per request and per local tool call (`tcid`); (4) `Wait` result | **Rows have no time.** LS explicitly refuses file mtime `[3P doc:22 @LS]` |
| **Working directory** | Not in any file a reader parses. DC sends the workspace folder in the request (`shared_folder_path`, `agent_workspace`) and projects bind folders server-side `[3P src/protocol.mjs:134-136 @DC; src/task-context.mjs:54-56,74 @DC]` | Absent. Candidates to inspect on a real file: tool `arguments` paths, snapshot `files[].path` `[INF]` |
| **Model** | Not stored. LS: model field in the stream is an internal enum (`38`) `[3P doc:117 @LS]`; DC reads `extra.model_item_key` / `reasoning_effort` from the server `[3P src/sessions.mjs:50-51 @DC]` | Absent |
| **Token usage** | "Nothing here supplies model names, model time, token usage" `[3P content:35-36 @LS]`; `context_window_usage` in the network stream is occupancy, not usage `[3P doc:117 @LS]` | **Confirmed absent** from local files |

Rules for the prompt:
- User rows delimit requests when an agent is reused across turns: a request's rows run from its user row to the next user row `[3P rounds:60-68 @LS]`.
- **The first demand may have no user row.** LS accepts "no matching user row" only when the demand is the first assignment and row 0 is not a user row, and then injects the assignment text as the user message `[3P rounds:64-65,102-107 @LS]`. A reader must therefore take the first prompt from `assignment.md` when the trajectory does not start with a user row.
- Assignment text vs user row differ in exactly two known ways: (a) leading `<system-reminder>` blocks exist in the assignment and are removed from the user row `[3P demand:3-20 @LS]`; (b) skill links are `[label](skill://<name>?…)` in one and `[label](<abs path>/.skills/<name>/SKILL.md)` in the other `[3P demand:33-38 @LS; doc:50 @LS]`. Which side holds which form is not stated.
- Injected rows to hide: no `system` rows are reported. The only injection evidenced is the `<system-reminder>` prefix (assignment side) and reminder-only assignment sections that share a timestamp with a real demand `[3P content:98-105 @LS; doc:52 @LS]`. LS notes the visible history "may lack system prompt, memory, compaction and hidden retries" `[3P doc:24 @LS]`.

## A4. Subagents

- Each agent has its own `agents/<agentId>/system/trajectory.jsonl` (and `assignment.md`) inside the same conversation directory `[3P native:93-94 @LS; reader:86-93 @LS]`.
- The parent's **call**: an assistant row whose `tool_calls[]` entry has `function.name === "create_agent"` and a valid string `id` `[3P native:46-48 @LS]`. Fixture argument: `{"subtask": "…"}` `[3P fixture:52 @LS]`.
- The parent's **result**: a `tool` row with that `tool_call_id` whose string `content` starts with `create_agent ok\n` `[3P native:49-50 @LS]`. Fields are read line by line with `^<name>: ([a-zA-Z0-9_-]+)$` (multiline) `[3P native:51 @LS]`:

  | Line | Rule |
  |---|---|
  | `agent_id: <child>` | required; id regex; must differ from the parent |
  | `parent_id: <x>` | must be the literal `main_agent` when the caller is the main agent, otherwise the caller's own agent id |
  | `thread_id: <digits>` | required; `^\d{1,30}$` (server thread id) |

  `[3P native:52-54 @LS]`. The fixture also has `agent_type: organizer` and `subtask: …` lines, which are not parsed `[3P fixture:53 @LS]`.
- Edge = `{child, parent: <caller agent id>, callId: tool_call_id, threadId}`; one edge per child; a conflicting second edge invalidates the graph `[3P native:55-57 @LS]`. Depth limit used: 8 `[3P native:153 @LS]`.
- Nesting is real: main → organizer → leaf in the fixture `[3P fixture:56-59 @LS]`.
- Constructed example (**from reader code, not a real file**), in `agents/m_ab12/system/trajectory.jsonl`:

  ```json
  {"role":"assistant","tool_calls":[{"id":"call_c1","function":{"name":"create_agent","arguments":{"subtask":"Collect the figures"}}}]}
  {"role":"tool","tool_call_id":"call_c1","content":"create_agent ok\nagent_id: o_cd34\nparent_id: main_agent\nthread_id: 7391000000000000001\nagent_type: organizer\nsubtask: Collect the figures"}
  ```

  The child's transcript is then `agents/o_cd34/system/trajectory.jsonl`.
- **Messages between agents**: no reader parses any. What is evidenced: a child's task arrives as a `## […] 需求` section of its own `assignment.md` (and a user row); later tasks to a reused agent append further sections and user rows `[3P content:54-61 @LS; doc:48 @LS]`; completion notifications arrive as reminder-only sections `[3P content:98-100 @LS]`. How a child's result returns to the parent (tool row of which call, or a new user row) is not shown `[INF]`.
- A child may have no local files at all (cloud-only or never materialised) `[3P doc:42 @LS]`.

## A5. Write behaviour

- **Append-only is the expected case, rewrite is allowed for.** LS treats growth as an append only when the file identity (`dev:ino:birthtime`) is unchanged, the size grew, and the first 64 and last 64 previously read bytes still match; anything else resets and re-reads `[3P reader:201-205,245-252,416-420 @LS; doc:65 @LS]`.
- Only complete lines are consumed; a trailing partial line waits `[3P reader:258-262,236 @LS]`. The one-shot reader rejects a file that does not end in `\n` `[3P native:110 @LS]`.
- LS has two modes: a one-shot whole-file read (file ≤ 2 MiB, ≤ 8 MiB per conversation) `[3P native:12-13,100-103 @LS]`, and an incremental tail with a byte offset and a 2 MiB per-agent content window `[3P reader:12,216-231,294-296 @LS]`.
- Final rows can land up to ~2 s after the client's end-of-request log event `[3P doc:56 @LS]`.
- **Retry / edit / stop: no source says what the app writes.** DC shows cancellation exists and that the server may still mark an aborted thread completed `[3P docs/subagent-e2e.md:10,36 @DC]` — nothing about the local file. LS mentions "hidden retries" and "compaction" as things the visible history may lack `[3P doc:24 @LS]`.
- **Row identity**: rows have no id. LS uses the **0-based row position within the agent's file** (`sourceIndex`), and derives a round id from `[agent, request time, position, row JSON]` `[3P reader:278 @LS; rounds:133 @LS]`. Tool calls have real ids (`tool_calls[].id`, unique per conversation). For de-duplication: key = conversation + agent + row position, tool nodes by call id; on a detected rewrite, drop and rebuild that agent `[INF]`.
- LS never enumerates history: it reads only conversations named in fresh log events `[3P doc:46 @LS; native:80-81 @LS]`. Enumerating `.sessions/*` (as WK proposes) is untested by any code.

## A6. Where the readers disagree, and what each skips

| Topic | LS | DC | WK |
|---|---|---|---|
| Platforms | macOS + Windows | macOS only (`/Applications/…`, `~/Library/…`) | macOS |
| Profile choice | regex `Default` / `Profile N`, must be unique for the conversation | `Local State` `last_used` | glob all |
| Main agent | `m_` directory-name prefix | — | `- Role: main` in `assignment.md` |
| `system` directory | literal | — | `<sysDir>` |
| `arguments` | object or string | — | object |
| Conversation id shape | any id chars (digits for snapshots) | 12–24 digits | "numeric" |
| Title | none | IndexedDB / server `name` | `board.md` |
| Reads `trajectory.jsonl` | yes | **no** (uses the workspace path only for skills and as a shared folder) | describes it |

Skipped: LS skips `board.md`, `MEMORY.md`, `attachments/`, IndexedDB, all history not named in new logs, and snapshot file bodies. DC skips the whole `.sessions` tree. WK is prose only.

## A7. Open questions that only a real file can settle

1. Extra row fields: `name`, ids, timestamps, a reasoning field, `tool_calls[].type`; whether `content` is ever an array or `null`.
2. `board.md` and `MEMORY.md` formats; whether `board.md` gives a usable title.
3. The text before the first `## […] 需求` header in `assignment.md` (role line, anything else), and the exact time format in the header.
4. Whether the first demand has a user row; which side (assignment or user row) carries the `skill://` form.
5. What retry, edit-and-resend, stop and long-history compaction do to `trajectory.jsonl` (append, truncate, rewrite).
6. How a child's result and inter-agent messages appear in the parent's file.
7. Whether any local file holds the workspace folder (snapshot `files[].path`, tool arguments, logs).
8. Windows: profile directory names, and whether `system` and the tree are identical.
9. Whether cloud-runtime conversations leave a `.sessions/<id>` tree.
10. Whether the app holds the files locked while running.

---
