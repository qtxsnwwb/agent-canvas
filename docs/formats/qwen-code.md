# Qwen Code session files: format description for a reader

Date: 2026-11-17. Public sources only; nothing was installed and no real session file was seen.

**Pinned source:** `QwenLM/qwen-code` tag **`v0.27.4`** = commit `f35dde84157f992bc324c0a3f59b1119344a683d` (release commit dated 2026-11-15). Every file was read raw from `raw.githubusercontent.com/QwenLM/qwen-code/v0.27.4/<path>`. Older layouts were checked at tags `v0.3.0` and `v0.4.0`.

Marking:

- `[SRC path:lines]` — read in the product source at `v0.27.4` (another tag is named when used, e.g. `@v0.3.0`). Paths are relative to the repo root; `core/` abbreviates `packages/core/src/`, `cli/` abbreviates `packages/cli/src/`.
- `[DOC …]` — the product's documentation.
- `[INF]` — my inference; not stated by the source.
- `[LOCAL path:lines]` — this repository (`agent-canvas`).

All JSON examples are **constructed from the type definitions, not a real file**.

Section 7 compares the format with this repository's readers as they were on 2026-11-17, before the DeepSeek, Buddy and Doubao readers existed; its `[LOCAL]` line numbers are of that date.

---

## 1. Paths

### 1.1 Roots and overrides

There are two roots. Sessions live under the **runtime base**, not necessarily under the config directory.

| Root | Resolution order | Source |
|------|------------------|--------|
| Global dir (config) | `QWEN_HOME` (tilde expanded, relative resolved against the process cwd) → `<os.homedir()>/.qwen` → `<os.tmpdir()>/.qwen` when there is no home directory | [SRC core/config/storage.ts:193-203], [SRC core/utils/paths.ts:14] |
| Runtime base (sessions) | pinned async context (managed workspace runtime) → env `QWEN_RUNTIME_DIR` → per-call async context → `Storage.setRuntimeBaseDir()` value → global dir | [SRC core/config/storage.ts:165-191] |

- The `setRuntimeBaseDir()` value comes from the setting `advanced.runtimeOutputDir` (string, restart required). Its description: "Config files remain at ~/.qwen (or QWEN_HOME if set). Env var QWEN_RUNTIME_DIR takes priority." [SRC cli/config/settingsSchema.ts:3833-3893]
- A relative `runtimeOutputDir` is resolved against the directory the caller passes; the doc comment says callers pass the **project root** "so that relative values like `.qwen` resolve per-project". [SRC core/config/storage.ts:119-130] The call site was not read.
- The docs say the same: `QWEN_RUNTIME_DIR` "Overrides the runtime output directory (session records, logs, todos), taking precedence over `advanced.runtimeOutputDir`. When neither is configured, runtime data uses `QWEN_HOME` (or `~/.qwen`)." [DOC docs/users/configuration/settings.md:884-885 @v0.27.4]
- Consequence for a reader [INF]: the default is `~/.qwen/projects`, but a correct reader needs a configurable directory, and a user with a project-relative `runtimeOutputDir` has one `projects/` tree per repository.

### 1.2 Layout under the runtime base

```
<runtimeBase>/projects/<sanitizedCwd>/
    chats/<sessionId>.jsonl                 main transcript (ChatRecord lines)
    chats/<sessionId>.title.json            list-label sidecar
    chats/<sessionId>.runtime.json          live-process sidecar
    chats/<sessionId>.worktree.json         worktree sidecar
    chats/<sessionId>.pr.json               PR-binding sidecar
    chats/archive/<sessionId>.jsonl         archived sessions (same sidecars beside them)
    subagents/<sessionId>/agent-<id>.jsonl        subagent transcript
    subagents/<sessionId>/agent-<id>.meta.json    subagent sidecar
    subagents/<sessionId>/agent-<id>.jsonl.stream transient live text, deleted on close
    workflows/…                             workflow run snapshots / journals (not chats)
<runtimeBase>/tmp/<sha256(projectRoot)>/    tool-results, checkpoints, shell_history
<runtimeBase>/tmp/session-writer-locks/<encodeURIComponent(sessionId)>.lock
```

Sources: `projects` constant and `getProjectDir()` [SRC core/config/storage.ts:20, 619-623]; chats dir and file name [SRC core/services/chatRecordingService.ts:1476-1493]; archive dir, worktree / PR / title sidecar paths [SRC core/services/sessionService.ts:1006-1049]; runtime sidecar [SRC core/config/storage.ts:726-740]; subagent paths [SRC core/agents/agent-transcript.ts:7-21, 64-116]; temp dir [SRC core/config/storage.ts:625-634]; lock path [SRC core/services/session-writer-lease.ts:1709-1719].

- Main transcript file name is exactly `<sessionId>.jsonl`. The session service only accepts names matching `/^[0-9a-fA-F-]{32,36}\.jsonl$/`. [SRC core/services/sessionService.ts:518]
- The file is created empty (flag `wx`) before the first record. [SRC core/services/chatRecordingService.ts:1488-1503]
- There is **no index file** listing sessions; the CLI lists by scanning `chats/`. [INF from core/services/sessionService.ts:1006-1025, 2756 ff.]
- A session is considered to belong to a project by `sha256(record.cwd)` of its first record (or the repo root in front of `/.qwen/worktrees/`, or the `work_dir` of its `.runtime.json`), not by the directory name. [SRC core/services/sessionService.ts:1089-1118]

### 1.3 Project directory name

```ts
export function sanitizeCwd(cwd: string): string {
  // On Windows, normalize to lowercase for case-insensitive matching
  const normalizedCwd = os.platform() === 'win32' ? cwd.toLowerCase() : cwd;
  return normalizedCwd.replace(/[^a-zA-Z0-9]/g, '-');
}
```

[SRC core/utils/paths.ts:388-392]. The input is `config.getProjectRoot()` as given, not a realpath. [SRC core/config/storage.ts:619-623, 644-646]

- **Lossy**: every character outside `[A-Za-z0-9]` becomes `-`, so `/a/b-c`, `/a/b/c` and `/a/b_c` collide, and non-ASCII path segments collapse into runs of `-`. The original path cannot be recovered from the name. [INF from the regex]
- **Case**: preserved on macOS and Linux; lower-cased on Windows (`D:\Projects\Foo` → `d--projects-foo`).
- At `v0.4.0` the function did not lower-case: `return cwd.replace(/[^a-zA-Z0-9]/g, '-')`. [SRC packages/core/src/config/storage.ts:128-130 @v0.4.0] So a Windows machine can hold a mixed-case directory name created by an old version; on a case-insensitive volume it is the same directory as the lower-case one. [INF]
- The original, case-preserved working directory is on every record (`cwd`), so a reader should take the working directory from the records and treat the directory name as an opaque key. [SRC core/services/chatRecordingService.ts:1779, 1802]
- On macOS / Linux the name equals Claude Code's project-directory encoding of the same path (same regex as `encodeProjectId`). [LOCAL packages/server/src/sources/project-ids.ts:1-2]

### 1.4 Sidecars beside the chats

`<sessionId>.title.json` [SRC core/services/session-title-sidecar.ts:16-25, 57-62, 109-135]:

```json
{ "version": 1, "displayName": "Fix flaky upload test", "source": "prompt", "updatedAt": "2026-11-16T09:12:44.512Z" }
```

`source` is `manual` (rename), `auto` (generated title) or `prompt` (first prompt, truncated to 200 code points). Written atomically (temp + rename), best-effort.

`<sessionId>.runtime.json` (snake_case on disk): `schema_version`, `pid`, `proc_start`, `pid_ns`, `session_id`, `work_dir`, `hostname`, `started_at` (epoch **seconds**), `qwen_version`. [SRC core/utils/runtimeStatus.ts:47-82, 138-146] It describes a live process; it is not history.

### 1.5 Older versions

| Version | Layout | Source |
|---------|--------|--------|
| ≤ `v0.3.0` (released 2025-11-28) | Gemini-CLI style: `~/.qwen/tmp/<sha256(projectRoot)>/chats/session-<YYYY-MM-DDTHH-MM>-<first 8 of sessionId>.json`, one whole-conversation JSON object `{sessionId, projectHash, startTime, lastUpdated, messages[]}`; messages `{id, timestamp, content, type: 'user' \| 'qwen', toolCalls?, thoughts?, tokens?, model?}`; `tokens = {input, output, cached, thoughts?, tool?, total}` | [SRC packages/core/src/services/chatRecordingService.ts:22-29, 34-86, 105, 142-156 @v0.3.0] |
| ≥ `v0.4.0` (released 2025-12-06) | `~/.qwen/projects/<sanitizedCwd>/chats/<sessionId>.jsonl`, `ChatRecord` lines with `uuid` / `parentUuid`; subtypes then were only `chat_compression`, `slash_command`, `ui_telemetry` | [SRC packages/core/src/services/chatRecordingService.ts:51-53, 176-198 @v0.4.0], [SRC packages/core/src/config/storage.ts:70-74 @v0.4.0] |

The switch is between those two consecutive stable tags (there is no `v0.3.x` tag other than `v0.3.0`). Release dates are from the GitHub release API. The legacy message type is `qwen`, not `gemini` — the existing legacy Gemini reader would reject it as an unknown type. [LOCAL packages/server/src/normalize/gemini.ts:25]

---

## 2. The `ChatRecord` line

One JSON object per line, appended with `fs.promises.appendFile(…, { flush: true })` (fsync per record). [SRC core/utils/jsonl-utils.ts:347-367] The interface is at [SRC core/services/chatRecordingService.ts:417-630].

### 2.1 Fields

| Field | Type | Notes |
|-------|------|-------|
| `uuid` | string | Fresh `randomUUID()` per record written by the recorder [SRC …chatRecordingService.ts:1789] |
| `parentUuid` | string \| null | The recorder's tail at creation time; null for the first record [1790] |
| `sessionId` | string | Equals the file name stem; the reader refuses a file with mixed session ids [SRC core/utils/transcript-records.ts:574-580] |
| `timestamp` | string | ISO 8601, `new Date().toISOString()` [1792] |
| `type` | `'user' \| 'assistant' \| 'tool_result' \| 'system'` | [433] |
| `subtype` | string, optional | See 2.3 [435-480] |
| `provenance` | `'real_user' \| 'assistant_output' \| 'tool_result' \| 'execution_output' \| 'goal_control' \| 'goal_runtime' \| 'system' \| 'external_agent' \| 'mod_prompt'`, optional | Default by type: user→`real_user`, assistant→`assistant_output`, tool_result→`tool_result`, system→`system` [306-317, 1794-1801] |
| `cwd` | string | `config.getProjectRoot()` at write time [1779, 1802] |
| `version` | string | CLI version or `"unknown"` [1803] |
| `gitBranch` | string, optional | [1804] |
| `promptId` | string, optional | Identity of the user turn [522] |
| `daemonPromptId` | string, optional | [419] |
| `message` | `Content` (`@google/genai`): `{ role, parts[] }` | See 2.2 [526-532] |
| `usageMetadata` | `GenerateContentResponseUsageMetadata` | Assistant records only, see 3.3 [537, 3206-3207] |
| `model` | string | Assistant records [539, 3196] |
| `contextWindowSize` | number, optional | Assistant records [549, 3213-3215] |
| `executionContext` | `{ modelId, authType?, approvalMode }` | **User** records (plain and `mid_turn_user_message`) [543-547, 2707-2713, 2738, 2828] |
| `toolCallResult` | `Partial<ToolCallResponseInfo> & { status? }` | `tool_result` records, see 3.1 [554] |
| `systemPayload` | union keyed by `subtype`; also carries the prompt payload on user records | [561-590] |
| `goalContext`, `backgroundTurn`, `deliveredTurn`, `clientInitiatedSkills`, `externalInputKind`, `externalRecordKey` | optional | Goal / background / daemon bookkeeping [482-514, 541, 605-611] |
| `agentId`, `agentName`, `agentColor`, `isSidechain`, `agentRunId`, `agentRound` | optional | Set on every record of a subagent file [592-603]; see 5 |
| `forkedFrom` | `{ sessionId, messageUuid }` | On every record of a `/branch` copy [613-629] |

### 2.2 `message` (Gemini `Content`)

- `role`: `"user"` for user and tool_result records (`createUserContent`), `"model"` for assistant records (`createModelContent`). [SRC …chatRecordingService.ts:2741, 3203, 3458]
- `parts[]` items seen in the source:
  - `{ "text": string }` — visible text.
  - `{ "text": string, "thought": true, "thoughtSignature"?: string }` — thinking. [SRC core/core/llm-chat.ts:429-441, 500-502], [SRC core/agents/agent-transcript.ts:788-792]
  - `{ "functionCall": { "id", "name", "args" } }` — tool call (assistant). [SRC core/agents/agent-transcript.ts:871-877], [SRC …chatRecordingService.ts:2393-2395]
  - `{ "functionResponse": { "id", "name", "response": { "output": … } | { "error": … }, "parts"?: [...] } }` — tool result. [SRC core/core/coreToolScheduler.ts:1177-1180, 1256-1260, 7585-7588]
  - `{ "inlineData": { "mimeType", "data" } }` and other non-text parts (images) — kept on user prompts and assistant turns. [SRC core/utils/transcript-records.ts:250-254], [SRC core/core/llm-chat.ts:7979-7985]
- The full `Part` shape is the SDK's (`fileData`, `executableCode`, `codeExecutionResult`, …); which of those Qwen Code ever emits was not traced. [INF]
- A third-party reader reports `message` occasionally being a plain string; the product's own validator treats a non-object `message` as malformed and ignores it. [SRC core/utils/transcript-records.ts:405-415]; the third-party claim is from the earlier notes (grade B).

### 2.3 Record kinds

Known subtypes: [SRC …chatRecordingService.ts:435-480] and the reader's list, which adds `managed_session_snapshot_base_v1` [SRC core/utils/transcript-records.ts:107-164]. An unknown subtype is a diagnostic, not a parse failure. [SRC core/utils/transcript-records.ts:390-403]

**Conversation-bearing records**

| `type` | `subtype` | Carries | Show as |
|--------|-----------|---------|---------|
| `user` | — | A user turn. `message.parts` is the model-bound request; `systemPayload` = `UserPromptRecordPayload { displayText, hookContext, mod?, asUser?, inputAnnotations?, attachmentReferences?, resourceLinks? }`; `executionContext`; `promptId` [650-669, 2725-2766] | prompt |
| `user` | `mid_turn_user_message` | Text typed while tools were running; `systemPayload { displayText, attachmentReferences? }` [2819-2841] | prompt (same turn) [INF] |
| `user` | `notification` | Injected notice (e.g. background task finished); `provenance: 'system'`; `systemPayload { displayText, backgroundTask? { taskId, status, kind: 'agent'\|'monitor'\|'shell'\|'workflow'\|'peer', toolUseId?, … } }` [632-648, 3084-3106] | system, not a prompt |
| `user` | `cron` | Scheduled prompt; same shape as notification [2843-2859] | system or prompt [INF] |
| `user` | `goal_runtime` | Goal runtime message, `provenance: 'goal_runtime'` [2782-2798] | system |
| `user` | `agent_mention`, `agent_message` | Multi-agent session records; "never a real user prompt, a turn boundary, a title source" [476-480] | system |
| `user` / `assistant` | `realtime_message` | Voice conversation entries, one text part each; assistant ones carry `model` [3224-3243] | prompt / text |
| `assistant` | — | One accepted model response: `message.parts` (thought, text, functionCall, inline data), `model`, `usageMetadata`, `contextWindowSize` [3186-3222] | thinking / text / tool nodes |
| `tool_result` | — | One tool's result: `message.parts` = functionResponse part(s); `toolCallResult` [3353-3466] | completes the tool node |
| `tool_result` | `code_mode_tool_result`, `tool_loop_end` | Nested (code-mode) tool results / loop end [319-321, 3453] | hide or attach [INF] |

**System records** (`type: "system"`, payload in `systemPayload` unless noted)

| `subtype` | Payload | Meaning |
|-----------|---------|---------|
| `chat_compression` | `{ info: { originalTokenCount, newTokenCount, compressionStatus, triggerReason?, …IsEstimated?, warning? }, compressedHistory: Content[], contextPrefixLength?, summaryPrefixLength?, promptIds?, directoryContextIndices?, completedToolCallIds? }` [722-739, 3745-3795], [SRC core/core/turn.ts:562-580] | Compaction checkpoint (auto, `/compress`, `/compress-fast`) |
| `rewind` | `{ truncatedCount }` [973-976, 3925-3930] | Marker appended at the re-rooted position |
| `slash_command` | `{ phase: 'invocation' \| 'result', rawCommand, sentToModel?, hiddenInvocation?, outputHistoryItems? }` [745-762, 3690-3703] | Slash command and its UI output |
| `at_command` | `{ filesRead: string[], status: 'success' \| 'error', message?, userText? }` [767-776] | `@file` expansion |
| `ui_telemetry` | `{ uiEvent }` (API response / request / tool / hook lifecycle events) [954-960, 3800-3836] | UI metrics replay; the events carry their own token counts |
| `custom_title` | `{ customTitle, titleSource?: 'manual' \| 'auto' }` [786-800] | Title; re-appended, see 6 |
| `session_model` | `{ modelId, authType, baseUrl?, isRuntime? }` [820-825] | Last-wins model binding |
| `session_approval_mode` | `{ mode, prePlanMode?, planExecutionMode? }` [843-847] | Last-wins |
| `session_workflow_mode` | `{ enabled }` [827-829] | Last-wins |
| `session_source` | `{ sourceType, sourceId? }` [814-817] | Which integration created the session |
| `parent_session` | `{ parentSessionId }` [808-811] | Sub-session spawned by another session (`create_sub_session`) — not a subagent |
| `session_execution_engine` | engine marker | Legacy vs managed |
| `turn_result` | `{ promptId, state: 'completed' \| 'cancelled' \| 'error', stopReason?, error?, startedAt?, cancelledAt?, endedAt (epoch ms), promptText?, resultText?, … }` [1085-1104] | Settled outcome of a prompt |
| `turn_attempt` | — | Attempt marker |
| `file_history_snapshot` | `{ snapshots[] }` [982-984] | File checkpoints for rewind |
| `attribution_snapshot` | `{ snapshot }` [966-968] | AI-contribution tracking |
| `user_text_elements` | `{ content, textElements[] }` [986-989] | UI annotation of the typed text |
| `memory_catalog_snapshot` | (uses `message: { role: 'user', parts: [snapshot] }`, no payload) [3727-3738] | Memory catalog injected |
| `omni_recall` | opaque | Recalled memory injected into the request [3712-3725] |
| `background_task_completed` | `NotificationRecordPayload` [2862-2866] | Background task ended |
| `branch_checkpoint` | v1 payload | `/branch` point |
| `goal_state`, `goal_turn_end` | goal payloads; `goal_turn_end` = `{ toolCallId }` [741-743] | Goal mode |
| `agent_bootstrap` | `{ kind: 'fork', history: Content[], systemInstruction?, tools? }` [678-697] | Subagent files only: inherited context of a fork |
| `agent_launch_prompt` | `{ displayText }` | Subagent files only |
| `agent_retry` | `{ attempt }` [704-707] | Subagent files only |
| `agent_session_ready` | `{ callId, subagentSessionReady }` [699-702] | Subagent files only |
| `session_artifact_event`, `session_artifact_snapshot`, `session_sources_snapshot` | artifact / sources payloads | **Not conversation records**: skipped for leaf selection and chain walking [SRC core/utils/transcript-records.ts:107-122, 284-306] |
| `managed_session_header_v1`, `_event_v1`, `_commit_v1`, `_snapshot_base_v1` | wrapper records | Managed sessions, see 4.6. Also not conversation records |

There is **no summary record** distinct from `custom_title` and `chat_compression`. [INF from the subtype list]

### 2.4 Examples (constructed from the type definitions, not a real file)

User prompt:

```json
{"uuid":"8f0c…01","parentUuid":null,"sessionId":"3b1e…aa","timestamp":"2026-11-16T09:12:44.101Z","type":"user","provenance":"real_user","cwd":"/home/u/app","version":"0.27.4","gitBranch":"main","executionContext":{"modelId":"qwen3-coder-plus","authType":"qwen-oauth","approvalMode":"default"},"message":{"role":"user","parts":[{"text":"fix the flaky upload test\n\n--- Content from referenced files ---\n…"},{"text":"<qwen:user-prompt-submit-context>\n…\n</qwen:user-prompt-submit-context>"}]},"systemPayload":{"displayText":"fix the flaky upload test @test/upload.test.ts","hookContext":"…"},"promptId":"3b1e…aa########0"}
```

Assistant response (thinking, text and a tool call in one record):

```json
{"uuid":"8f0c…02","parentUuid":"8f0c…01","sessionId":"3b1e…aa","timestamp":"2026-11-16T09:12:51.730Z","type":"assistant","provenance":"assistant_output","cwd":"/home/u/app","version":"0.27.4","gitBranch":"main","model":"qwen3-coder-plus","message":{"role":"model","parts":[{"text":"The test races the temp dir cleanup…","thought":true},{"text":"I'll look at the test first."},{"functionCall":{"id":"call_a1","name":"read_file","args":{"file_path":"/home/u/app/test/upload.test.ts"}}}]},"usageMetadata":{"promptTokenCount":18230,"candidatesTokenCount":212,"thoughtsTokenCount":96,"cachedContentTokenCount":17408,"totalTokenCount":18442},"contextWindowSize":1000000}
```

Tool result:

```json
{"uuid":"8f0c…03","parentUuid":"8f0c…02","sessionId":"3b1e…aa","timestamp":"2026-11-16T09:12:52.004Z","type":"tool_result","provenance":"tool_result","cwd":"/home/u/app","version":"0.27.4","message":{"role":"user","parts":[{"functionResponse":{"id":"call_a1","name":"read_file","response":{"output":"import { test } from 'vitest'…"}}}]},"toolCallResult":{"callId":"call_a1","status":"success","resultDisplay":"Read 84 lines"}}
```

Compression checkpoint:

```json
{"uuid":"8f0c…20","parentUuid":"8f0c…1f","sessionId":"3b1e…aa","timestamp":"2026-11-16T10:02:11.000Z","type":"system","subtype":"chat_compression","provenance":"system","cwd":"/home/u/app","version":"0.27.4","systemPayload":{"info":{"originalTokenCount":182000,"newTokenCount":21000,"compressionStatus":1},"compressedHistory":[{"role":"user","parts":[{"text":"<summary>…</summary>"}]},{"role":"model","parts":[{"text":"Got it."}]}],"contextPrefixLength":0,"summaryPrefixLength":2}}
```

Rewind marker (note the parent: the record before the turn rewound to, not the previous line):

```json
{"uuid":"8f0c…30","parentUuid":"8f0c…03","sessionId":"3b1e…aa","timestamp":"2026-11-16T10:20:00.000Z","type":"system","subtype":"rewind","provenance":"system","cwd":"/home/u/app","version":"0.27.4","systemPayload":{"truncatedCount":6}}
```

Title, slash command, at-command, UI telemetry, notification:

```json
{"uuid":"8f0c…40","parentUuid":"8f0c…3f","sessionId":"3b1e…aa","timestamp":"…","type":"system","subtype":"custom_title","cwd":"/home/u/app","version":"0.27.4","systemPayload":{"customTitle":"Fix flaky upload test","titleSource":"auto"}}
{"uuid":"8f0c…41","parentUuid":"8f0c…40","sessionId":"3b1e…aa","timestamp":"…","type":"system","subtype":"slash_command","cwd":"/home/u/app","version":"0.27.4","systemPayload":{"phase":"result","rawCommand":"/about","outputHistoryItems":[{"type":"about"}]}}
{"uuid":"8f0c…42","parentUuid":"8f0c…41","sessionId":"3b1e…aa","timestamp":"…","type":"system","subtype":"at_command","cwd":"/home/u/app","version":"0.27.4","systemPayload":{"filesRead":["test/upload.test.ts"],"status":"success","userText":"@test/upload.test.ts"}}
{"uuid":"8f0c…43","parentUuid":"8f0c…42","sessionId":"3b1e…aa","timestamp":"…","type":"system","subtype":"ui_telemetry","cwd":"/home/u/app","version":"0.27.4","systemPayload":{"uiEvent":{"event.name":"qwen-code.api_response","model":"qwen3-coder-plus","input_token_count":18230,"output_token_count":212}}}
{"uuid":"8f0c…44","parentUuid":"8f0c…43","sessionId":"3b1e…aa","timestamp":"…","type":"user","subtype":"notification","provenance":"system","cwd":"/home/u/app","version":"0.27.4","message":{"role":"user","parts":[{"text":"<task-notification>…</task-notification>"}]},"systemPayload":{"displayText":"Background agent finished","backgroundTask":{"taskId":"Explore-call_b7","status":"completed","kind":"agent","toolUseId":"call_b7"}}}
```

The `uiEvent` field names in the telemetry example are illustrative only (I did not read the event type definitions). [INF]

---

## 3. Linking and interpretation

### 3.1 Tool call ↔ result

- Call: a `functionCall` part inside an **assistant** record, with `id`, `name`, `args`.
- Result: a separate **`tool_result`** record whose `message.parts` holds a `functionResponse` part with the same `id` and the model-facing tool `name`; `toolCallResult.callId` repeats the id. [SRC core/core/coreToolScheduler.ts:8307-8343, 1256-1260]
- **Join on `functionResponse.id` (= `toolCallResult.callId`) → `functionCall.id`.** The product does the same when it tracks which calls are still open. [SRC …chatRecordingService.ts:1874-1879, 2393-2395, 3629-3636]
- One record is written per completed call (loop over `completedCalls`), so parallel calls of one assistant record produce several consecutive `tool_result` records. [SRC core/core/coreToolScheduler.ts:8307-8343]
- `toolCallResult` fields written by the scheduler: `callId`, `status`, `executionStatus`, `resultDisplay`, `artifacts`, `visionBridgeNotice?`, `error`, `errorType`. `persistedOutputFiles` and `boundaryArtifact` are deleted before recording. [SRC core/core/coreToolScheduler.ts:8317-8329], [SRC …chatRecordingService.ts:3399-3405] There is **no tool name** in `toolCallResult`; take it from the `functionResponse` or the call.
- `status` is the scheduler's `Status`: `validating | scheduled | error | success | executing | cancelled | awaiting_approval`; a recorded result is normally `success`, `error` or `cancelled`. [SRC core/core/coreToolScheduler.ts:628-732]
- `error` is an `Error` object, which `JSON.stringify` writes as `{}`; the error text is in `functionResponse.response.error`. [INF from core/core/turn.ts:261-266 and JSON semantics]
- `resultDisplay` is a string or a structured object. File diffs are truncated for the saved session (50 000 chars per diff, 16 000 per file content, 100 000 aggregate). [SRC …chatRecordingService.ts:131-133, 196-281] For the `agent` tool it is `{ type: 'task_execution', … }` with `toolCalls` emptied. [SRC …chatRecordingService.ts:3406-3418]
- A call with no result record (interrupted) stays open; the tool node should stay "running" until the session is known to be idle. [INF]

### 3.2 Thinking

Parts with `thought: true` inside the assistant record's `message.parts`, text in `text`. [SRC core/core/llm-chat.ts:429-441, 500-502] They normally precede the visible text of the same response, but a reader should keep part order as stored. [INF] A part can also carry `thoughtSignature` without `thought: true`; the product treats that as non-visible too. [SRC core/core/llm-chat.ts:7598-7608] There is no separate thinking record and no thinking duration.

### 3.3 Usage, and one response over several records

Field names on `usageMetadata` (those the product validates): `promptTokenCount`, `candidatesTokenCount`, `cachedContentTokenCount`, `thoughtsTokenCount`, `totalTokenCount`. [SRC core/core/llm-chat.ts:7390-7424] The SDK type also allows `toolUsePromptTokenCount` and per-modality detail arrays. [INF]

Semantics, per provider adapter:

| Provider path | `promptTokenCount` | `cachedContentTokenCount` | `candidatesTokenCount` | `thoughtsTokenCount` |
|---------------|--------------------|---------------------------|------------------------|----------------------|
| OpenAI-compatible, Qwen OAuth | `prompt_tokens` (includes cached) | `prompt_tokens_details.cached_tokens` or top-level `cached_tokens` | `completion_tokens` (**includes** reasoning) | `completion_tokens_details.reasoning_tokens`, or an estimate from the text when absent |
| Anthropic protocol | `input + cache_read + cache_creation` (or `input` alone when it looks OpenAI-style) | `cache_read_input_tokens` | `output_tokens` | not set |
| Gemini | prompt incl. cached | cached | output **excluding** thoughts | thoughts, separate |

Sources: [SRC core/core/openaiContentGenerator/converter.ts:1545-1588, 2161-2205], [SRC core/core/anthropicContentGenerator/usage.ts:44-66], [SRC core/telemetry/gen-ai-usage.ts:33-45].

Mapping to `{input, cachedInput, output}`:

- `cachedInput = cachedContentTokenCount`
- `input = max(0, promptTokenCount − cachedContentTokenCount)` — cached is a subset of prompt in all three paths. [INF from the table]
- `output`: follow the product's own rule [SRC core/telemetry/gen-ai-usage.ts:52-66]: let `derived = totalTokenCount − promptTokenCount`; if `totalTokenCount > 0` and `candidates ≤ derived ≤ candidates + thoughts`, use `derived`; otherwise `candidates` when the auth type is `openai`, OpenAI Responses or Qwen OAuth, else `candidates + thoughts`.
- The auth type is **not on the assistant record**. It is on the preceding user record (`executionContext.authType`) and in `session_model` payloads. [SRC …chatRecordingService.ts:543-547, 820-825]
- `thoughtsTokenCount` may be an estimate, not a provider number. [SRC core/core/openaiContentGenerator/converter.ts:1561-1571]
- Cache-creation tokens are not persisted (kept only in an in-memory WeakMap). [SRC core/telemetry/gen-ai-usage.ts:15-31]

De-duplication:

- **Main file**: the recorder writes exactly one assistant record per accepted model response, after the stream is consolidated, with the response's usage. A partial response whose stream failed is written only if the retry did not replace it. [SRC core/core/llm-chat.ts:7989-8025, 6106-6127] So **one assistant record = one API response; sum `usageMetadata` over the live-branch assistant records, no de-duplication key is needed.** [INF]
- **Same-`uuid` fragments**: the reader groups lines with the same `uuid`, concatenates their `message.parts`, takes the **last** `usageMetadata`, the first `toolCallResult` and `model`, and the latest timestamp. [SRC core/utils/transcript-records.ts:513-549, 607-632] The `v0.27.4` writer never repeats a uuid, so this covers older or foreign writers. A reader should do the same: key by `uuid`, never add usage twice for one uuid.
- **Subagent files**: one model round is split over several records — one assistant record with the round's thought + text and `usageMetadata`, `agentRunId`, `agentRound`; then one assistant record **per tool call** holding only the `functionCall` part and no usage. [SRC core/agents/agent-transcript.ts:787-802, 865-880] Usage appears once per round, so summing is still correct; to regroup a round, attach the following functionCall-only records to the preceding record that has `agentRound`. [INF]
- `ui_telemetry` records repeat token counts per API response. Do not add them to the usage total. [INF]
- A `/branch` copy repeats the source's assistant records (same uuids, same usage) in a new session file. [SRC core/services/sessionService.ts:4584-4625] Per-session totals are right; a cross-session total double-counts unless records with `forkedFrom` are excluded. [INF]

### 3.4 Typed text vs injected context

On a plain `user` record:

- `message.parts` is what was sent to the model: the expanded request (file contents from `@` references, context blocks, reminders) and, last, an optional hook-context part wrapped in `<qwen:user-prompt-submit-context>\n…\n</qwen:user-prompt-submit-context>`. [SRC core/core/client.ts:4590-4603, 4910-4924], [SRC core/utils/transcript-records.ts:45-48, 196-220]
- `systemPayload.displayText` is the text the user submitted (pre-hook projection); `systemPayload.hookContext` duplicates the hook context. [SRC …chatRecordingService.ts:650-669]

The product's display rule [SRC core/utils/transcript-records.ts:222-261]:

1. If `systemPayload` is an object and (`hookContext` is a string **or** the last part is a complete hook-context part) and `displayText` is a string → show `displayText` (an empty string is meaningful and must not fall back) plus the non-text parts (images).
2. Else if there is no `systemPayload` and the last of several parts is a complete hook-context part → show the parts without that last one.
3. Else show the parts as they are (old records).

Also not typed by the user: `provenance: 'mod_prompt'` (a Mod submitted it; `systemPayload.mod` names it), and every `user` record with a `subtype` other than `mid_turn_user_message` / `realtime_message`. [SRC …chatRecordingService.ts:332-339, 2735-2737, 476-480] The product's first-prompt label uses only records with `type === 'user' && subtype === undefined`. [SRC core/services/sessionService.ts:2474-2493]

ACP clients omit the payload when there is nothing to project, so a missing `systemPayload` on a new record is normal. [SRC …chatRecordingService.ts:651-655]

---

## 4. The tree

### 4.1 `parentUuid`

Every record's `parentUuid` is the recorder's in-memory tail (`lastRecordUuid`) at creation; after a normal append the record becomes the tail. [SRC …chatRecordingService.ts:1776-1806, 1964-1992] Unlike Claude Code, **system records are in the chain too** — a rewind marker, a telemetry event or a title record can be the parent of a prompt.

Some records are appended **without** becoming the tail (`updateActiveTail: false`): periodic `custom_title` and `session_source` re-anchors (every 32 KiB of other writes) and artifact / sources snapshots. [SRC …chatRecordingService.ts:140, 2204-2253, 4577-4609] The next record then has the same parent as the anchor, so the anchor becomes a one-record side leaf. A rename done by the session service appends a `custom_title` whose parent is the file's last uuid. [SRC core/services/sessionService.ts:4456-4467]

### 4.2 How the CLI rebuilds the conversation (resume)

`loadSession` reads all lines, then `prepareTranscriptRecords`: [SRC core/services/sessionService.ts:3596-3685, 3257-3269], [SRC core/utils/transcript-records.ts:460-511, 551-666]

1. Validate each line (object; string `uuid`; `parentUuid` string or null; string `sessionId`; `type` one of the four). Invalid lines are skipped with a diagnostic.
2. **Leaf = the last record in physical file order that is a conversation record**, i.e. not `session_artifact_event`, `session_artifact_snapshot`, `session_sources_snapshot` or a `managed_session_*` record. There is no stored leaf pointer and no timestamp comparison.
3. Index conversation records by `uuid` (first occurrence decides the parent; later same-uuid lines are fragments).
4. Walk `parentUuid` from the leaf until null, a cycle, or a parent that is not in the file (recorded as a "history gap"; the walk stops and **earlier records are not reconnected**, because a missing parent cannot be told apart from a lost rewind). [SRC core/utils/conversation-chain.ts:15-37]
5. Reverse; aggregate fragments per uuid.

The result is the live branch. On resume the recorder continues in the **same file** with `lastRecordUuid` = the last record of that chain. [SRC …chatRecordingService.ts:1598-1606, 3980-3996]

### 4.3 What each operation appends

| Operation | Appended | Source |
|-----------|----------|--------|
| `/rewind` (also edit-and-resend, which is a rewind followed by a new prompt [INF]) | The tail is set back to the record that preceded the target user turn; then a `rewind` system record (child of that record), then re-appended `session_model`, `session_approval_mode`, `session_workflow_mode` and surviving `file_history_snapshot` records. Everything after the target point becomes a dead branch. | [SRC …chatRecordingService.ts:3858-3971] |
| Restore of a tool answer | A `rewind` record whose parent is the assistant record holding the call, a new `tool_result` for the original call id, then re-appended metadata records | [SRC …chatRecordingService.ts:3605-3676] |
| Compression (auto, `/compress`, `/compress-fast`) | One `chat_compression` record on the normal chain. The earlier records stay, and stay on the live branch: "keeps the UI history immutable". | [SRC …chatRecordingService.ts:3740-3795] |
| `/clear` | Nothing in the old file (apart from a possible final `custom_title`). A new session id is started, so later records go to a **new file**. | [SRC cli/ui/commands/clearCommand.ts:102, 117-122], [SRC …chatRecordingService.ts:4361-4410] |
| `/branch` (fork) | A new file `<newSessionId>.jsonl` with only the live branch copied: same `uuid` per record, `sessionId` rewritten, `parentUuid` rebuilt in write order, `forkedFrom { sessionId, messageUuid }` on every record; `parent_session`, `session_source`, `turn_result`, sources snapshots dropped. | [SRC core/services/sessionService.ts:4517-4530, 4584-4625], [SRC …chatRecordingService.ts:613-629] |
| `/rename`, auto title | `custom_title` record + `.title.json` | [SRC …chatRecordingService.ts:4071-4147] |
| Session end | `custom_title` re-appended if content followed the last one | [SRC …chatRecordingService.ts:4361-4410] |

### 4.4 Is anything rewritten in place?

**Not by the operations above** — they only append. But "nothing is ever rewritten" is false in three cases:

1. **Message-group deletion** (available when the session has a writer lease — the ACP / daemon surfaces): the transcript is read, the selected groups are removed, the remaining records get their `parentUuid` repaired, and the whole file is **replaced** (temp file + rename, guarded by a SHA-256 of the old content). [SRC …chatRecordingService.ts:2347-2414], [SRC core/services/session-writer-lease.ts:2650-2705], [SRC core/utils/message-group-deletion.ts:424-597]
2. **Archive / unarchive** moves the file between `chats/` and `chats/archive/` together with its sidecars. [SRC core/services/sessionService.ts:1010-1049, 4021 ff.]
3. **Session removal** deletes the file, sidecars and subagent state. [SRC core/services/sessionService.ts:1832-1880]

A tailing reader must therefore handle "file got shorter or its content before my offset changed" by re-reading the session from the start, and handle a key moving to `archive/`. [INF]

A missing transcript is recreated empty by the next append, so a file can also start in the middle of a conversation (first record has a non-null `parentUuid`). [SRC …chatRecordingService.ts:1518-1522]

### 4.5 Deciding the live branch — rule for a reader

Whole-file rule (exactly the product's): take the last physical conversation record and walk `parentUuid` to the root; those records, in root→leaf order, are live. Everything else is dead (rewound turns, side leaves).

Incremental rule for a tailing reader (mirrors `updateActiveBranch` [SRC …chatRecordingService.ts:1858-1880]):

- Keep the live chain as an ordered list and a `uuid → record` map of everything read.
- New record with `parentUuid ===` current tail uuid → push.
- Otherwise find the parent in the live chain: truncate the chain after it (those records are now dead: remove their nodes) and push. Parent null → the chain restarts. Parent known but not on the live chain, or unknown → recompute the chain by walking from the new record through the map. [INF for the last case]
- Skip the three non-conversation subtypes and managed records entirely; ignore lines that fail validation.
- A same-`uuid` line merges into the existing record.

Two things must **not** be limited to the live branch [INF, from 4.1 and 6]:

- Session-level metadata (`custom_title`, `session_source`, `parent_session`): take the last one in physical order. Title anchors are side leaves and are off the live chain as soon as another record follows. The product itself finds the title by scanning the file tail for the last `"subtype":"custom_title"` line, regardless of branch. [SRC core/utils/sessionStorageUtils.ts:770-786]
- Whether to **show** dead branches is a product decision. Qwen Code hides them. The Claude path in this tool shows every record (see 7).

### 4.6 Managed sessions

A "Managed" session routes every record through a separate writer; the file at the normal transcript path then holds wrapper records (`managed_session_header_v1`, `_event_v1`, `_commit_v1`) from which reader-facing `ChatRecord`s are *projected*. The recorder refuses to write plain records into such a file, and the legacy session service refuses to fork it. Detection: a first record with subtype `managed_session_header_v1` (or a `session_execution_engine` owner record before it). [SRC …chatRecordingService.ts:377-398, 1504-1509, 1925-1934], [SRC core/services/sessionService.ts:134-140, 4531-4536], [SRC core/utils/sessionStorageUtils.ts:834-965] The wrapper format was not traced; a first version of the reader should detect such files and report them as unsupported rather than show an empty session. [INF]

---

## 5. Subagents

### 5.1 What the parent session records

- The call: a `functionCall` part named **`agent`** (display name `Agent`; the legacy name `task` is an alias). [SRC core/tools/tool-names.ts:33, 127, 194, 242]
- `args` (`AgentParams`): `description`, `prompt`, `subagent_type?`, `model?`, `run_in_background?`, `name?`, `isolation?: 'worktree'`, `working_dir?`, `fork_turns?`, `fork_tools?`, `fork_profile?`, `todo_id?`, `plan_mode_required?`, `read_only?`. `subagent_type: "fork"` is a fork of the parent context. [SRC core/tools/agent/agent.ts:274-330]
- The result: a `tool_result` record with `toolCallResult.resultDisplay` = `AgentResultDisplay`: `{ type: 'task_execution', subagentName, subagentColor?, taskDescription, taskPrompt, executionMode?: 'foreground' | 'background', subagentSessionReady?, status: 'running' | 'completed' | 'failed' | 'cancelled' | 'background', terminateReason?, result?, executionSummary?, skills?, tokenCount?, toolCalls: [] }`. The nested `toolCalls` list is always emptied before recording. [SRC core/tools/tools.ts:776-809], [SRC …chatRecordingService.ts:3406-3418]
- **No field of the parent's records carries the agent id.** The link goes the other way (5.3). [INF from the two types above]
- A background agent's completion arrives later as a `user` / `notification` record with `systemPayload.backgroundTask { taskId, status, kind: 'agent', toolUseId }` (the notification text names the transcript path as `<output-file>`). [SRC …chatRecordingService.ts:632-648], [SRC core/agents/agent-transcript.ts:13-16, 77-80]

### 5.2 The subagent files

Written for **both** foreground and background launches. [SRC core/tools/agent/agent.ts:3924-3939, 4069-4087, 4881-4894, 5003-5042]

- Agent id: `` `${subagentConfig.name}-${callId ?? randomUUID().slice(0, 8)}` `` — the resolved subagent name, a hyphen, and the **parent tool call id**. [SRC core/tools/agent/agent.ts:3741-3747]
- Paths: `<projectDir>/subagents/<sanitize(sessionId)>/agent-<sanitize(agentId)>.jsonl` and `.meta.json`, where `sanitize` replaces every character outside `[a-zA-Z0-9_-]` with `_`. [SRC core/agents/agent-transcript.ts:64-116] The file name is therefore lossy with respect to the agent id; the exact id is in the records and the sidecar.
- `.meta.json` (`AgentMeta`): `agentId`, `agentType`, `description`, `parentSessionId`, `toolUseId?`, `parentAgentId` (null at top level; the launching agent's id for nested agents), `createdAt`, `status?: 'running' | 'completed' | 'failed' | 'cancelled' | 'paused'`, `isBackgrounded?`, `isolation?`, `lastUpdatedAt?`, `resolvedApprovalMode?`, `subagentName?`, `agentColor?`, `depth?`, `model?`, `lastError?`, `resumeCount?`, `stats?`, `recentActivities?`, and launch-policy fields. It is patched over the agent's life. [SRC core/agents/agent-transcript.ts:118-196, 416-491]
- The `.jsonl` holds `ChatRecord`-shaped lines with their own `parentUuid` chain. Every record has `sessionId` = **the parent session id**, `cwd`, `version`, `gitBranch`, `agentId`, `agentName`, `agentColor`, `isSidechain: true`. There is **no `model`** on these records (it is in the sidecar) and no `provenance`. [SRC core/agents/agent-transcript.ts:674-730]

Records in a subagent file, in order of appearance [SRC core/agents/agent-transcript.ts:787-956]:

| Record | Content |
|--------|---------|
| `system` / `agent_bootstrap` | Forks only: `{ kind: 'fork', history: Content[] }` (inherited parent context; can be large) |
| `user` | The launching prompt as one text part (first record of a non-fork) |
| `system` / `agent_launch_prompt` | Forks only: `{ displayText }` |
| `system` / `agent_retry` | `{ attempt }` when the transcript resumes after a failed attempt |
| `assistant` (round text) | `message.parts` = `[{text, thought: true}]?` + `[{text}]?`; `usageMetadata`; `agentRunId`; `agentRound` |
| `assistant` (tool call) | exactly one `functionCall { id, name, args }` part; no usage |
| `tool_result` | `message.parts` = the response parts; `toolCallResult = { callId, status?: 'error', durationMs? }` only — **no `status` on success, no `resultDisplay`** |
| `user` with `externalInputKind: 'message' \| 'notification'` | A message delivered to the running agent |
| `system` / `ui_telemetry` | tool lifecycle events (`event.name: 'tool_lifecycle'`) |
| `system` / `agent_session_ready` | `{ callId, subagentSessionReady }` for nested agent calls |

Example (constructed from the type definitions, not a real file):

```json
{"uuid":"c1…01","parentUuid":null,"sessionId":"3b1e…aa","timestamp":"…","type":"user","cwd":"/home/u/app","version":"0.27.4","agentId":"Explore-call_b7","agentName":"Explore","isSidechain":true,"message":{"role":"user","parts":[{"text":"Find every caller of uploadChunk"}]}}
{"uuid":"c1…02","parentUuid":"c1…01","sessionId":"3b1e…aa","timestamp":"…","type":"assistant","cwd":"/home/u/app","version":"0.27.4","agentId":"Explore-call_b7","agentName":"Explore","isSidechain":true,"message":{"role":"model","parts":[{"text":"Searching first.","thought":true},{"text":"Let me grep."}]},"usageMetadata":{"promptTokenCount":5120,"candidatesTokenCount":64,"totalTokenCount":5184},"agentRunId":"7d…","agentRound":1}
{"uuid":"c1…03","parentUuid":"c1…02","sessionId":"3b1e…aa","timestamp":"…","type":"assistant","cwd":"/home/u/app","version":"0.27.4","agentId":"Explore-call_b7","agentName":"Explore","isSidechain":true,"message":{"role":"model","parts":[{"functionCall":{"id":"call_c1","name":"grep_search","args":{"pattern":"uploadChunk"}}}]}}
{"uuid":"c1…04","parentUuid":"c1…03","sessionId":"3b1e…aa","timestamp":"…","type":"tool_result","cwd":"/home/u/app","version":"0.27.4","agentId":"Explore-call_b7","agentName":"Explore","isSidechain":true,"message":{"role":"user","parts":[{"functionResponse":{"id":"call_c1","name":"grep_search","response":{"output":"src/a.ts:12: uploadChunk("}}}]},"toolCallResult":{"callId":"call_c1","durationMs":41}}
```

Sidecar (constructed likewise):

```json
{"agentId":"Explore-call_b7","agentType":"Explore","description":"Find callers","parentSessionId":"3b1e…aa","toolUseId":"call_b7","parentAgentId":null,"createdAt":"2026-11-16T09:20:00.000Z","status":"completed","isBackgrounded":false,"lastUpdatedAt":"2026-11-16T09:21:12.000Z"}
```

A resumed subagent appends to the same file, starting from an explicit parent uuid so that a dangling tail of the interrupted run becomes a dead branch; apply the same live-branch rule as for the main file. [SRC core/agents/agent-transcript.ts:598-608, 679-684]

### 5.3 Linking

1. Session: the directory name `subagents/<sessionId>/` and every record's `sessionId` are the parent session id.
2. Dispatch node: `meta.toolUseId` equals the `id` of the `agent` functionCall — in the main file when `meta.parentAgentId` is null, in the file of agent `parentAgentId` otherwise. [SRC core/tools/agent/agent.ts:4074-4083, 5032-5038]
3. Without the sidecar (it is written best-effort, after the transcript writer attaches): the agent id ends with `-<callId>`, so match the records' `agentId` suffix against open `agent` call ids. [INF from agent.ts:3741-3747]
4. Agent name / type for the node title: `meta.agentType`, or `agentName` on the records, or `args.subagent_type`.

Not the same thing: `system` / `parent_session { parentSessionId }` marks a whole **sub-session** (a separate session file created by a `create_sub_session` caller), not a subagent thread. [SRC …chatRecordingService.ts:802-811]

---

## 6. Title, model, working directory

**Title.** The product's order when listing sessions [SRC core/services/sessionService.ts:1071-1087, 2474-2493], [SRC core/utils/sessionStorageUtils.ts:770-786]:

1. The last `custom_title` record in the transcript (`systemPayload.customTitle`; `titleSource` absent means `manual`).
2. Else the `.title.json` sidecar when its `source` is `manual` or `auto`.
3. Else the first prompt: the first record with `type === 'user'` and no `subtype`, using `systemPayload.displayText` when that key exists (an empty one skips to the next prompt), otherwise the first text part.

`custom_title` records repeat (re-anchors, session end), so a reader keeps the last value and must not render each one. Auto titles are generated after an assistant turn when a fast model is configured and no title exists. [SRC …chatRecordingService.ts:3245-3260]

**Model.** `model` on each assistant record is the model of that response — use it per node. `executionContext.modelId` on user records and `session_model` payloads give the session's selected model (last wins); after a rewind the current `session_model` is re-appended on the live branch. [SRC …chatRecordingService.ts:3196, 2707-2713, 3934-3943] Subagent records have no model; use `meta.model`.

**Working directory.** `cwd` on every record is the project root of the process that wrote it, not a shell's current directory. [SRC …chatRecordingService.ts:1779] It can differ between records of one file: a session resumed from a git worktree under `<repo>/.qwen/worktrees/` is accepted as the same project. [SRC core/services/sessionService.ts:1099-1106] There is no "directory changed" record; take the session's cwd from the first record and update from later records if a change should be shown. [INF] `gitBranch` is likewise per record.

**Timestamps.** Session start = first record's `timestamp` (the product does the same); the product's "last updated" is the file mtime, a reader can use the last record's timestamp. [SRC core/services/sessionService.ts:3645-3651]

---

## 7. Comparison with this tool's existing readers

Read: `packages/server/src/normalize/gemini.ts`, `gemini-reduce.ts`, `sources/gemini/source.ts`, `sources/gemini/project.ts`, `normalize/normalizer.ts`, `normalize/transcript.ts`, `sources/claude.ts`, `sources/transcript/paths.ts`, `sources/project-ids.ts`, `sources/dirs.ts`.

### 7.1 Which path is it closer to?

Neither fits whole. The **file and record structure is Claude-shaped; the payload is Gemini-API-shaped; the processing model it needs is the Gemini normaliser's.**

| Aspect | Qwen Code | Claude path | Gemini path |
|--------|-----------|-------------|-------------|
| Directory | `projects/<encoded cwd>/chats/<sid>.jsonl` | `projects/<encoded cwd>/<sid>.jsonl` — same encoding regex [LOCAL sources/project-ids.ts:1-2] | `tmp/<slug>/chats/session-*.jsonl`, session id from the first line [LOCAL sources/gemini/source.ts:60-72] |
| Session id | file name | file name [LOCAL sources/transcript/paths.ts:33-35] | first line |
| Record identity | `uuid` / `parentUuid` tree | same field names [LOCAL normalize/normalizer.ts:688, 707, 934-945] | message `id`, linear, mutation records [LOCAL normalize/gemini-reduce.ts:1-7] |
| Dead branches | hidden by the product | **not handled**: every record becomes a node hanging off `resolveParent()`; nothing is ever removed for a rewind (no leaf logic exists in `normalizer.ts`) | handled: `$rewindTo` → `removeMessages` → `node_removed` [LOCAL normalize/gemini-reduce.ts:65-70], [LOCAL normalize/gemini.ts:388-394, 459-466] |
| Message payload | `Content { role, parts[] }` with `text` / `thought` / `functionCall` / `functionResponse` | Anthropic blocks `text` / `thinking` / `tool_use` / `tool_result` | Gemini parts for `content`; but thoughts and tool calls are separate arrays (`thoughts[]`, `toolCalls[]` with inline `result`) [LOCAL normalize/gemini.ts:646-699] |
| Tool result | separate `tool_result` record, joined by call id | separate user record with `tool_result` blocks, joined by `tool_use_id` [LOCAL normalize/normalizer.ts:712-715] | inline on the call |
| Usage | `usageMetadata` (Gemini API names) on the assistant record | `message.usage` (Anthropic names), split responses share `message.id` | `tokens {input, output, cached, thoughts}` [LOCAL normalize/gemini.ts:84-89] |
| Subagents | `subagents/<sid>/agent-<id>.jsonl` + `.meta.json` with `toolUseId` | `<sid>/subagents/agent-<id>.jsonl` + `.meta.json` [LOCAL sources/transcript/paths.ts:9-10, 39-44] | `chats/<sid>/<agentId>.jsonl`, linked by `toolCalls[].agentId` [LOCAL normalize/gemini.ts:505-525] |
| Title | `custom_title` system record + sidecar | `custom-title` record / `custom-title.json` [LOCAL normalize/normalizer.ts:668-673] | `$set summary` |
| Hooks | not read by this tool | hook plane merged with transcript plane | none |

### 7.2 What can be reused

From the **Gemini** side (the better base for the normaliser):

- The whole "thread = ordered messages → nodes are a function of the messages → emit the difference" machinery: `Thread`, `dirtyFrom`, `walk`, `emitNode`, `removeMessage` / `removeNode`, edge bookkeeping, `commitSession`, `nodePatch`. [LOCAL normalize/gemini.ts:164-207, 459-497, 555-591, 707-811, 835-866] It already copes with messages that disappear (rewind) and messages that change later (a tool result arriving for an earlier call), which are the two things Qwen Code needs and the Claude normaliser cannot do.
- The op vocabulary `upsertMessage` / `removeMessages` / `replaceAll` / `setMeta` and `applyGeminiOps`. [LOCAL normalize/gemini-reduce.ts:19-25, 136-165] A Qwen reducer can emit the same ops: live-chain push → `upsertMessage`; chain truncation → `removeMessages`; file replaced → `replaceAll`.
- Part helpers: `partsOf`, `textOf` (already skips `thought: true` parts and renders `inlineData` / `fileData` as `[image]`), `hasFunctionResponse`, `outputOf` (already reads `functionResponse.response.output`, else `.error`), `KNOWN_PARTS`, `callStatus` (`success` / `error` / `cancelled` match Qwen's `Status`), `toolSummary`, `callPart`. [LOCAL normalize/gemini.ts:27-39, 66-122, 814-817] These are module-private today and would need exporting.
- The subagent link design (thread per agent id, `computeLinks`, dispatch node becomes `subagent` kind, child thread's first node hangs off it with a `spawn` edge). [LOCAL normalize/gemini.ts:501-553, 578-581] Only the link key changes (5.3).
- `ProjectIdResolver.forCwd` as used by `geminiProject` for lower-cased Windows paths. [LOCAL sources/gemini/project.ts:59-71]

From the **Claude** side:

- The path-classification approach and regexes (`agent-(.+)\.jsonl`, `agent-(.+)\.meta\.json`, everything told from the path synchronously), with the segments in a different order. [LOCAL sources/transcript/paths.ts:9-46] `ClaudeFileSource` is a 55-line template for the new source. [LOCAL sources/claude.ts:11-55]
- The agent-meta idea: a sidecar read as a `meta` raw event that links an agent thread to its dispatch tool node by tool-use id (`agentMetas`, `dispatchByAgent`, `registerAgentMeta`). [LOCAL normalize/normalizer.ts:88-91, 275-296] Qwen's `.meta.json` has the same role and the same key (`toolUseId`).
- The `passthrough` idea (a record that yields no node still forwards its parent). [LOCAL normalize/normalizer.ts:80-81, 934-945] In a linear live chain this is implicit, so it is only needed if dead branches are to be drawn as a tree.
- `encodeProjectId` for the project id from `cwd`. On macOS / Linux a Qwen session and a Claude session in the same directory get the same project id with no extra work.

Not reusable: `classifyRecord` / `messageUsage` / `applyAssistant` / `applyToolResults` (Anthropic block shapes and `message.id` logic), the hook plane, queue operations, async-launch handling. [LOCAL normalize/transcript.ts:36-62, 172-193]

Not reusable from Gemini: `reduceGemini` itself (the five record kinds do not occur), `build()` as written (it expects `type: 'gemini'`, `thoughts[]`, `toolCalls[]`, `tokens`), `usageOf` (right idea — `input − cached`, `output + thoughts` — but the output rule differs, see 3.3), `GeminiFileSource` (slug / `.project_root` / `projects.json` / first-line session id / legacy `.json`: none apply).

### 7.3 What is new

1. **Tree → live chain reducer** (4.5): leaf = last physical conversation record, incremental truncation, same-uuid fragment merge, non-conversation subtypes skipped, session metadata read off-chain.
2. **Joining results to calls across records**: a `tool_result` record updates a node built from an earlier assistant record (by call id). In the Gemini machinery this is "an earlier message changed", so the reducer should fold each `tool_result` into its owning assistant message (as a per-call result) and re-`upsert` that message, rather than treat the result as a message of its own.
3. **Prompt projection** (3.4): `displayText` rule, and classifying `user` records by `subtype` / `provenance` into prompt vs system notice.
4. **Usage rule** with the provider-dependent thoughts handling (3.3), needing the auth type from a different record.
5. **A wide system-record vocabulary**: decide per subtype between a node (`chat_compression` → system "compact"; `rewind`; `slash_command` result; maybe `notification`, `turn_result` errors), session metadata (`custom_title`, `session_model`), and silence (`ui_telemetry`, snapshots, mode records). Unknown subtypes should be reported like the other normalisers do, not dropped silently.
6. **Subagent files with a different record granularity** (one record per call, round usage on a separate record, sparse `toolCallResult`, no model) and a different link (`meta.toolUseId` / id suffix), plus the `agent_bootstrap` record that must not be rendered as conversation.
7. **A new file source**: root `<runtimeBase>/projects`, depth 3 (`<proj>/subagents/<sid>/agent-*.jsonl`, `<proj>/chats/archive/<sid>.jsonl`), files told from the path, sidecars (`.title.json`, `.meta.json`) as meta events, `.runtime.json` / `.worktree.json` / `.pr.json` / `.stream` ignored; plus a new origin and key prefix. [LOCAL sources/source.ts:37-44], [LOCAL sources/dirs.ts:21]
8. **File replacement and moves** (4.4): in-place rewrite by message-group deletion, archive moves.
9. **Uuid reuse across files** (`/branch` copies keep uuids): node ids must include the session id, as `geminiNodeId` already does. [LOCAL normalize/gemini.ts:61-64]
10. **Managed-session files** (4.6): detect and report.
11. Optional: the pre-`v0.4.0` `tmp/<hash>/chats/session-*.json` files (1.5), which are Gemini-legacy-shaped except for `type: 'qwen'`.

---

## Open questions that only a real file can settle

1. Whether `functionCall.id` is always present in main-file assistant records for every provider (the Gemini auth path may leave it out), and whether ids are unique within a session or can repeat across turns.
2. The real shape of `toolCallResult` after JSON serialisation: is `error` really `{}`, which `resultDisplay` object variants occur, how large they get.
3. Whether main-session files ever contain records with `agentId` / `isSidechain: true` (the type allows it; I found only the subagent writer setting them), and whether a foreground subagent's tool calls leave any trace in the parent file besides the `agent` call and its result.
4. The exact `parts` of a real user record: how many parts, where `@file` content and reminders sit, how often `systemPayload` is missing (ACP clients), and how IDE-context or system-reminder text is delimited.
5. Whether `usageMetadata` is present on every assistant record, which optional SDK fields appear, and how `totalTokenCount` relates to prompt + candidates + thoughts for the providers actually used (this decides the output rule in 3.3).
6. Whether the leaf rule gives the expected result on real rewound sessions — in particular that title / source re-anchor records never end up hiding live records — and how often "history gap" files occur.
7. What the `ui_telemetry` `uiEvent` objects look like and how many there are per turn (volume matters for ingestion).
8. The size of `chat_compression.compressedHistory` and `agent_bootstrap.history` lines (line-length limits in the reader).
9. Whether same-`uuid` fragment lines exist in files written by any still-used version, and whether uuids repeat across resumed sessions as one third-party reader claims.
10. The wrapper format of Managed sessions, how common they are, and whether the 1.x preview's `logs/sessions/<projectId>/<sessionId>/segments/<runId>.jsonl` (from its docs) replaces `chats/` there.
11. Whether Qwen Code Desktop and the IDE / ACP integrations use the default runtime base and the same layout, and what `sessionId` values they produce (the file-name pattern allows 32–36 hex-or-hyphen characters).
12. The sanitised subagent file name versus the raw `agentId` for real call ids (which characters get replaced), and whether `.meta.json` is always present next to a transcript.
13. On Windows: whether both a mixed-case (pre-lowercasing) and a lower-case project directory name are seen in practice, and what `cwd` looks like in the records (drive-letter case, separators).
14. For pre-`v0.4.0` installations: whether the old `tmp/<hash>/chats/session-*.json` files are still on disk after upgrading (no migration code was looked for).
