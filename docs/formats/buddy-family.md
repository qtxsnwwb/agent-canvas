# WorkBuddy / CodeBuddy Code transcript format ("buddy" JSONL) — implementation notes

Research date 2026-11-17. Public sources only; **no real transcript file was seen**. Everything below was read as RAW text (curl of raw.githubusercontent.com / unpkg.com), except the three `[DOC]` pages, which went through a summarising fetcher that was asked for verbatim quotes.

## 0. Evidence and citation tags

| Tag | Source, pinned | What it is |
|---|---|---|
| `[PKG …]` | npm `@tencent-ai/codebuddy-code@2.185.0` (published 2026-11-17), files via `https://unpkg.com/@tencent-ai/codebuddy-code@2.185.0/<path>`. `d.ts` paths are relative to `dist-server/types/`; `JS@N` = character offset N in `dist-server/codebuddy.js` (minified, 12.5 MB; method names survive, so search the quoted name) | **The writer itself.** Ships TypeScript declarations with full doc comments for the session store, plus readable minified code. Depends on `@openai/agents-core@0.20.0`. LICENSE.txt is MIT-style text |
| `[AV …]` | `kenn-io/agentsview@ec0a8d9e5c42a10a66973029269600a83dbe56d9` | Go reader for WorkBuddy JSONL (`internal/parser/workbuddy.go`, `workbuddy_provider.go`). Its `codebuddy.go` is a different format (IDE extension, see 8.7) |
| `[DSH …]` | `Nwflower/dsh-chat-import@ba599183390164484d5f5894585ddb8f6abb2228` | JS converters: `lib/convert/buddy-family.mjs` (shared engine), `workbuddy.mjs`, `codebuddy.mjs`, discovery in `lib/discovery/claude.mjs`. WorkBuddy part tested by its author on 11 real sessions (CHANGELOG.md:88,103); the CodeBuddy part says its fixtures are synthetic, "induced from" package v2.179.3 (`test/codebuddy.test.mjs:1-3`) |
| `[TT …]` | `xiufengsun/TokenTracker@e2ff7493c600ec78ba1551490a053e5eedc4ae7a`, `src/lib/rollout.js` | Usage-only reader; comments say "verified against real ~/.workbuddy logs" (11306-11307) |
| `[TS …]` | `junhoyeo/tokscale@5569a0397b52c6c445e346814747a772fc3c0a11`, `crates/tokscale-core/src/sessions/{tencent_buddy,workbuddy,codebuddy}.rs` | Usage-only reader, one shared parser for both products |
| `[DOC url]` | official docs (summarised fetch, verbatim quotes requested) | |
| `[INF]` | my inference; says from what | |

Weight: `[PKG]` > parsers verified on real files (TT, DSH-WorkBuddy) > parsers with synthetic fixtures (AV, DSH-CodeBuddy, TS).

**Headline results**

1. One engine writes both products' files. The package contains the single hand-written path algorithm "for `<configDir>/projects/<name>/<conversationId>.jsonl`", used by "agent-cli (standalone product) / workbuddy-core / workbuddy-server / edge-sync extension / history-migration", and "the read side must be byte-identical to the write side" [PKG node/utils/compress-path.source.d.ts:1-17]; it also ships `dist/codebuddy-lite-wb.mjs` and refers to `apps/workbuddy-desktop` [PKG node/http/workbuddy-config-dir.d.ts:8-10]. TT: both WorkBuddy builds "write byte-identical JSONL" and CodeBuddy is the "same transcript format" [TT 11356-11362, 11122]. Differences are in *content conventions* (prompt wrapping), not in record shape — see section 8.
2. Lines are OpenAI Agents SDK items written verbatim, plus extension fields and custom "fact" records [PKG vendor/cbc-core/node/session/transcript-branch.d.ts:2-10; vendor/cbc-shared/node/agent/openai-agents-types.d.ts:99-124].
3. The file is an append-only journal with a `parentId` tree; rewind / edit-resend / content-filter / compaction never rewrite lines, they append and fork [PKG, section 7]. **A reader that wants "what the user sees now" must resolve the active branch**; none of the third-party parsers does.
4. Message flags (`isMeta`, `skipRun`, …) live in `providerData`, not at top level [PKG JS@6979239]. DSH's CodeBuddy converter reads them at top level and is wrong on this point (section 9, D1).

---

## 1. Paths, directory encoding, file naming, subagents, SQLite

### 1.1 Roots

| Product / edition | Root | Evidence |
|---|---|---|
| CodeBuddy Code CLI | `~/.codebuddy/projects/` | [PKG vendor/cbc-core/node/session/session-store.d.ts:260-264]; [DOC https://www.workbuddy.ai/docs/cli/codebuddy-dir] "projects/ # Per-project session and sub-agent runtime data"; [DSH lib/discovery/claude.mjs:487-493]; [TT 10591-10596] |
| WorkBuddy, China build | `~/.workbuddy/projects/` | [AV internal/parser/types.go:890-897]; [DSH lib/discovery/claude.mjs:470-477]; [TT 11356-11365]; [TS workbuddy.rs:3] |
| WorkBuddy, international build ("WorkBuddy AI") | `~/.workbuddy-ai/projects/` | [TT 11356-11365] ("international build"); [DSH lib/discovery/claude.mjs:472-474, CHANGELOG.md:88,103] ("Desktop 5.9.x renamed the data root; `~/.workbuddy` then holds only `logs/`") |

- Home-relative on every OS; no reader uses `AppData`/`Library` for transcripts. Windows = `%USERPROFILE%\.workbuddy\projects\…` [INF from all readers resolving against the home dir; PKG `resolveCliHomeDir` uses `os.homedir()` JS@"resolveCliHomeDir"].
- **Scan both WorkBuddy roots.** TT says the split is by edition, DSH says by version (5.9.x). Unresolved (section 9, D9).
- AV scans only `.workbuddy/projects` [AV types.go:894] and has **no** reader for `~/.codebuddy/projects`.

### 1.2 Override variables

| Variable | Owner | Effect | Evidence |
|---|---|---|---|
| `CODEBUDDY_CONFIG_DIR` | product | replaces `~/.codebuddy` as the whole config+data root (so transcripts are in `$CODEBUDDY_CONFIG_DIR/projects`) | [PKG JS "resolveCliHomeDir": `dataLayout.configDir.userDirName` → `~/<userDirName>`; else `CODEBUDDY_CONFIG_DIR` if non-blank; else `~/.codebuddy`]; [DOC https://www.workbuddy.ai/docs/cli/env-vars] "Custom location for CodeBuddy Code to store configuration and data files" |
| product config `dataLayout.configDir.userDirName` | product (customised builds) | `~/<userDirName>` and it **wins over** `CODEBUDDY_CONFIG_DIR`; must start with `.` | [PKG same function; node/utils/path-utils.d.ts:24-27] |
| `WORKBUDDY_CONFIG_DIR` | product (WorkBuddy) | WorkBuddy user config dir, default `~/.workbuddy`; "used by test suites, enterprise deployments, isolation" | [PKG node/http/workbuddy-config-dir.d.ts:1-14]; JS `wb_net_cli_fetch_configDir()` = `WORKBUDDY_CONFIG_DIR || CODEBUDDY_CONFIG_DIR || ~/.workbuddy` |
| `CODEBUDDY_PROJECT_CONFIG_DIR` | product | renames the *project-level* `.codebuddy` dir; not transcripts | [PKG node/utils/path-utils.d.ts:125-139] |
| `--no-session-persistence` / `options.sessionPersistence === false` | product | nothing is written | [PKG JS "isSessionPersistenceDisabled"] |
| `WORKBUDDY_PROJECTS_DIR`, `CODEBUDDY_DIR` | agentsview's own | | [AV types.go:892,901] |
| `WORKBUDDY_HOME`, `WORKBUDDY_AI_HOME`, `CODEBUDDY_HOME` | TokenTracker's own | | [TT 11363-11366, 10624] |

How WorkBuddy Desktop points the embedded engine at `~/.workbuddy` / `~/.workbuddy-ai` (env var vs product config) is not visible in the package [INF: one of the two mechanisms above; `.workbuddy-ai` does not occur in `dist-server/codebuddy.js`].

### 1.3 Project directory name — exact rule

```js
// [PKG dist-server/codebuddy.js, functions normalizeWorkspacePathBase / compressWorkspacePathName / djb2Base36; doc: node/utils/compress-path.source.d.ts:30-59]
base = dir.replace(/[/\\:]/g, "-").replace(/^-+/, "").replace(/-+$/, "").replace(/-+/g, "-")
name = byteLength(base, "utf8") <= 255 ? base
     : truncateOnCodePoint(base, 180 bytes) + "-" + djb2Base36(base)
// djb2Base36: c = 5381; for each UTF-8 byte b: c = (33 * c) ^ b;  return (c >>> 0).toString(36)
```

- Input is `realpathSync(cwd)`, falling back to `path.resolve(cwd)` [PKG JS "canonicalizeCwd"].
- Only `/`, `\`, `:` are replaced. Dots, spaces, underscores and non-ASCII characters are kept; runs of `-` collapse; leading/trailing `-` are removed. Official example, with the account name in it replaced by a placeholder: `/Users/<user>/my-project` → `Users-<user>-my-project` [PKG compress-path.source.d.ts:54].
- **Not Claude Code's rule.** Claude Code turns every non-alphanumeric character into `-` without collapsing and keeps the leading `-` (`/Users/a/my.proj` → `-Users-a-my-proj`); here the same path gives `Users-a-my.proj`. `D:\Projects\X` → `D-Projects-X` [INF applying the code; drive-letter case follows the cwd string — TS's fixture uses `c-Users-alice-repo`, TS codebuddy.rs:27].
- Not reversible (a `-` in a folder name is indistinguishable). Every reader takes `cwd` from the records and uses the directory name only as a label [DSH lib/discovery/claude.mjs:358-371; AV workbuddy.go:61-69; TT 11567-11600].
- Same rule for WorkBuddy [PKG compress-path.source.d.ts:7-13 names workbuddy-core/workbuddy-server as consumers; "legacy" read-side fallback by prefix exists in workbuddy-core, line 46-48]. Third-party readers call it `<project-hash>` without checking [DSH workbuddy.mjs:3].

### 1.4 Files in a project directory

```
<root>/projects/<projectName>/
  <sessionId>.jsonl                               main transcript; sessionId is a UUID
  <sessionId>.meta.json                           legacy sidecar (retired, see below)
  <sessionId>/subagents/<storeId>.jsonl           subagent transcript; storeId starts with "agent-"
  <sessionId>/subagents/<storeId>.meta.json       legacy subagent sidecar
  <sessionId>/…/tool-results/…                    externalised large tool outputs (exact layout not read)
```

- Paths: [PKG session-store.d.ts:259-275; JS "getSessionFilePath": `if (parentSessionId && id.startsWith("agent-")) join(dir, parentSessionId, "subagents", id + ".jsonl") else join(dir, id + ".jsonl")`].
- The whole-file `.meta.json` overwrite is **retired**; its content is now an in-transcript `session-meta` line [PKG session-store.d.ts:301-308]. Old sessions may still have the sidecar ("legacy identity sidecars", session-store.d.ts:420-423). DSH still describes the sidecar as current [DSH codebuddy.mjs:9] (D8).
- AV accepts `<proj>/<uuid>.jsonl` and `<proj>/<uuid>/subagents/<anything>.jsonl`, nothing deeper [AV workbuddy_provider.go:51-67]. DSH skips any file whose stem starts with `agent-` [DSH lib/discovery/claude.mjs:414-415]. TT recurses and counts subagent files [TT 11313-11319].
- Session id = file stem. `sessionId` on lines normally equals it for main sessions; **in a subagent file the lines carry the subagent's runtime UUID, which differs from the file stem** [PKG JS@7284025 (`c.sessionId !== storeId` used to recover the runtime id); session creation `{id: uuid, storeId: taskId}` JS@1734530]. Use the stem as the key.

### 1.5 Subagent ↔ parent linkage

| Link | Where | Evidence |
|---|---|---|
| directory | `<parentSessionId>/subagents/<storeId>.jsonl` | 1.4 |
| parent → child | on the parent's **`function_call_result`** of the Agent tool: `providerData.toolResult.subAgent = { sessionId, afterId, lastId, descriptor }`; `subAgent.sessionId` equals the child's `storeId` (file stem); the record's own `callId` is the spawning call | [PKG JS "subAgentMetaOf"; `resolveResumedParentToolCallId` JS@1708100: `matches(toolResult.subAgent, item.callId)` with `subAgent.sessionId === child.storeId ?? child.id`] |
| descriptor | `{ version: 1, sessionId (= storeId), rootSessionId, parentSessionId, parentToolCallId, conversationRequestId, rootRequestId, role (agent type), agentNickname?, description, mode: "background" | "attached", createdAt }` | [PKG JS "getSubagentDescriptor" @1728635] |
| nested subagents | `descriptor.parentSessionId` is the parent *subagent's* storeId when nested; `rootSessionId` is the top session | same |
| child → parent | child session meta has `parentSessionId`, `parentToolCallId`, `subagentRootSessionId`, `parentSubagentId`, `taskId`, `agentName` — but these are runtime-only ("Role / locks / parentSessionId stay runtime-only") and are **not** in the persisted `session-meta` whitelist; legacy `.meta.json` may hold them | [PKG JS@1734530; session-store.d.ts:59-73] |
| item flag | `_fromSubAgent?: boolean` exists on items | [PKG openai-agents-types.d.ts:108] (meaning not read) |

No third-party parser reads any of this: AV links by directory only [AV workbuddy.go:189-200]; DSH ignores subagent files. Whether the on-disk `providerData.toolResult.subAgent` is always present (old versions, WorkBuddy "teams") is open.

### 1.6 SQLite `workbuddy.db`

- `<root>/workbuddy.db` (i.e. `~/.workbuddy/workbuddy.db`) [TT 11690-11692; TS workbuddy.rs:3-5].
- Tables/columns a reader actually queries: `session_usage(session_id, used, size, updated_at, credit_json)` LEFT JOIN `sessions(id, model, cwd)` [TS workbuddy.rs:44-57 (query), 137-150 (test schema); TT 12084-12096]. `used`/`size` are context-window occupancy and `credit_json` is credits — **not token usage** [TT 11472-11477].
- `sessions.title`, `status`, `created_at`, `updated_at`, `user_id` and a `workspaces` table are reported only by user articles (earlier notes, strength C); no parser reads them.
- **A transcript reader does not need the database**: cwd, model, timestamps and usage are in the JSONL; titles are `ai-title` / `custom-title` / `topic` lines or the first prompt (2.6). TS calls the db a fallback for "older installs" [TS workbuddy.rs:3-5]. The only thing it might add is a title for sessions whose JSONL has none (open question 6).
- CodeBuddy Code has no such database in any source [INF from absence].

---

## 2. Line envelope (common fields)

Written key order: `id, parentId, logicalParentId, timestamp, type, role`, then everything else [PKG JS "transformItemForSaveAsync" tail: `{id, parentId, logicalParentId, timestamp, type, role, ...rest}`]. `JSON.stringify` drops undefined keys.

| Field | Type | Meaning | Evidence |
|---|---|---|---|
| `id` | string (UUID; UUIDv7 for `session-meta`) | entry identity; minted if missing. **Not always unique**: with Chat-Completions-shaped providers an assistant `message` and a `function_call` of the same response can share one `id`; the reader treats adjacent same-id lines as one tree node | [PKG vendor/cbc-core/node/utils/entry-uuid.d.ts:1; history-utils.d.ts:40-42; JS "getActiveHistory"] |
| `parentId` | string, absent on a segment root | previous conversation entry on the same branch (tree link) | [PKG transcript-branch.d.ts:3-10; JS class with `priority=ParentIdLinkage`: `parentId = item.parentId ?? session.lastMessageId`] |
| `logicalParentId` | string | only on compaction-boundary user messages: `parentId` is removed and the old tip is kept here | [PKG same class: `isReplayRecoverableCompactMessage(i) ? (i.parentId = undefined, i.logicalParentId = c) : i.parentId = c`] |
| `timestamp` | **number, epoch milliseconds** (`Date.now()`) | write/creation time | [PKG openai-agents-types.d.ts:106; JS transform: `N.timestamp || (N.timestamp = Date.now())`]; [AV workbuddy.go:202-207] accepts numbers only, `time.UnixMilli`; [DSH lib/convert/core.mjs:29-40] numbers < 1e11 are treated as seconds, strings via `Date.parse` (defensive) |
| `type` | string | record type, section 3 | |
| `role` | `"user" | "assistant" | "system"` | only on `message` | |
| `sessionId` | string | runtime session id, set when missing (`i.sessionId || (i.sessionId = session.id)`) on non-custom items; custom items carry it only if their creator sets it (`custom-title`, `ai-title`, `session-meta`) | [PKG JS class with `priority=Default` @7435351; openai-agents-types.d.ts:125-150] |
| `cwd` | string | working directory at write time; added to every line **except** types `summary` and `topic` | [PKG JS transform: `N.cwd || ["summary","topic"].includes(N.type) || (N.cwd = cwd?.trim() || getWorkDir())`] |
| `status` | `"in_progress" | "completed" | "incomplete"` | SDK item status (messages, calls, results) | [PKG vendor/cbc-core/node/utils/input-item-utils.d.ts:2] |
| `providerData` | object | see below | |
| `message` | `{ usage: {…} }` | save-time mirror of `providerData.usage` in snake_case, added when `providerData.usage` exists and type is `message` or `function_call` (section 6) | [PKG JS transform + "normalizeUsageFormat"; session-store.d.ts:182-186]; [TS tencent_buddy.rs:50,56-59] |
| `_meta` | object | per-request W3C trace carrier, optional | [PKG JS transform; session-store.d.ts:192-196] |
| `_fromSubAgent`, `_detachedUsageOnly` | boolean | optional | [PKG openai-agents-types.d.ts:108-109] |

There is **no** git branch, CLI version, `isSidechain`, `uuid`/`parentUuid`, or `userType` on lines — none appears in the writer's types or in any parser [PKG openai-agents-types.d.ts:102-110; INF from absence]. (`uuid` exists only in the store's wire envelope `{type, uuid, timestamp(ISO), payload}`; the local JSONL stores the payload itself, "the persisted item itself, verbatim" [PKG transcript-branch.d.ts:2, JS "toEnvelope"]. TT's fallback to `entry.uuid` is dead code for these files [TT 11143-11152].)

### `providerData` keys (as written by the engine)

| Key | On | Meaning | Evidence |
|---|---|---|---|
| `messageId` | every model output item: `reasoning`, assistant `message`, `function_call`, and also `function_call_result` | **id of the model response (one LLM round-trip)**; shared by all items of that response | [PKG JS "handleStreamRunResult" @7195900-7197900] |
| `conversationRequestId` | same items; user messages | **id of the user request (turn)** | same; [PKG custom-input-item-types.d.ts:60] |
| `model` | same items | model that answered (`c.model || telemetry.modelId`) | same |
| `requestModelId`, `requestModelName` | same items | model that was requested; `readExecutedModelId` prefers `requestModelId ?? model` | [PKG JS "readExecutedModelId" @7018900] |
| `traceId`, `stepSeq` | same items | tracing | same |
| `agent` | all non-custom items | agent / speaker name; `"compact"` marks the compaction agent | [PKG JS @7435351; history-utils.d.ts:206] |
| `usage` | output items | SDK `Usage` (camelCase: `inputTokens`, `outputTokens`, `totalTokens`, `inputTokensDetails`, `outputTokensDetails`) | [PKG JS "getLatestUsageSnapshot", "getCacheReadTokens"] |
| `rawUsage` | the **last** item of a model response (`_isLastResponseItem: true`), later merged with gateway usage; also `model-usage` records | provider's raw usage object (+ `credit`) | [PKG JS @7197300-7197800, "mergeGatewayRawUsage"] |
| `skipRun` | any | item does not trigger a model run / is a UI placeholder | [PKG JS "isSkipRunItem"] |
| `isMeta`, `startsNewUserRequest`, `isAdditionalData`, `isCompactInternal`, `isCompacted`, `isSummary`, `compactType`, `compactionId`, `queueHold`, `acpPromptMode`, `teammateMessage.from`, `clientMeta` | user messages | section 4 | [PKG JS @6979239-6980400] |
| `error`, `hookStatus`, `contentFilterNotice`, `strippedUserMessageId`, `providerRefusal`, `isSessionSeparator`, `discard`, `isPartialAborted`, `manual`, `codebuddyArgumentsTruncated` | assistant messages / calls | error placeholders, hook messages, etc. | [PKG input-item-utils.d.ts:7, 110-135; history-utils.d.ts:432-438, 476-481]; `isPartialAborted`/`discard` also [DSH workbuddy.mjs:68] |
| `toolResult` | `function_call_result` | UI copy of the result: `content`, `renderer`, `error`, `rawResponse`, `replPresentation`, `subAgent`, `title` | [PKG session-store.d.ts:227-236; history-utils.d.ts:514-516]; [DSH workbuddy.mjs:40-56] |

---

## 3. Record types

Complete `type` vocabulary known to the writer:

- SDK items: `message`, `reasoning`, `function_call`, `function_call_result`, plus SDK types that may appear but no parser handles: `hosted_tool_call`, `computer_call`, `computer_call_result`, `unknown`; the writer also tests for a legacy spelling `function_call_output` [PKG openai-agents-types.d.ts:111-124; JS transform `"function_call_output"===N.type||"function_call_result"===N.type`].
- Custom ("fact") types — `CUSTOM_INPUT_ITEM_TYPES`, literal array in the bundle: `custom-title, ai-title, file-history-snapshot, summary, topic, goal-result, goal-progress, goal-state, turn-metrics, resend-fork-notice, acp-terminal-state, request-recovery, model-usage, credit-usage, context-usage, checkpoint-restore` — plus `session-meta` [PKG JS: `eE=["custom-title",…]`, `oE=new Set([...CUSTOM_INPUT_ITEM_TYPES,"session-meta"])`]. Facts never advance the branch tip, are never sent to the model, and are skipped by the parent walk [PKG transcript-branch.d.ts:11-12; custom-input-item-types.d.ts:174-177].

All JSON examples below are **constructed from parser / writer code, not a real file**.

### 3.1 `message`, role `user`

`content`: array of parts, or a plain string (SDK allows both; the engine's own helper writes an array) [PKG JS "createUserMessage": `content: Array.isArray(i) ? i : [{type:"input_text", text:i}]`; DSH buddy-family.mjs:46-60; AV workbuddy.go:220-237].

Parts:

| Part | Fields | Evidence |
|---|---|---|
| text | `{type:"input_text", text}` | all |
| image, persisted | the `input_image` part is replaced on save by `{…restOfPartWithoutImageAndType, type:"image_blob_ref", blob_id, mime, size, source, blob_path, original_filename}` (bytes live in `<root>/blobs/<id[0:2]>/<id>.<ext>`) | [PKG JS "replaceImageDataWithBlobRef"/"toLegacyUserImageRef"; blob object @2393095; "getBlobPath"]; [DSH workbuddy.mjs:29-30] skips `image_blob_ref` |
| image, raw | `{type:"input_image", image: "data:…" | …}` can remain if not a data URI | [PKG same]; [DSH codebuddy.mjs:26-27] |
| file | `input_file` (SDK) | [PKG session-store.d.ts:216-217] |

```json
{"id":"0192f3a0-1111-7000-8000-000000000001","timestamp":1790000000000,"type":"message","role":"user","content":[{"type":"input_text","text":"<system-reminder data-role=\"user-context\">\n<user_info>…</user_info>\n</system-reminder>\n<user_query>fix the failing test</user_query>"}],"providerData":{"agent":"cli","conversationRequestId":"…"},"sessionId":"3f0c…","cwd":"D:\\work\\repo"}
```

### 3.2 `message`, role `assistant`

`content`: array of `{type:"output_text", text}` (others possible per SDK: `refusal`, `audio`, `image`); string tolerated by readers. `status` usually `"completed"` [PKG JS "createAssistantMessage"; AV workbuddy.go:227; DSH workbuddy.mjs:31-38].

Not only the final answer: the model's narration before a tool call is a separate `message` with `status:"completed"` ("tool-call carrier") [PKG history-utils.d.ts:395-404]. Synthetic assistant messages also exist: `"Interrupted by user"` (`skipRun:true`), API-error placeholders (`skipRun:true` + `providerData.error`), hook messages (`hookStatus`), content-filter notice (`contentFilterNotice:true`) [PKG history-utils.d.ts:378-380, 432-438; input-item-utils.d.ts:110-135].

```json
{"id":"…a1","parentId":"…fr1","timestamp":1790000005000,"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Fixed: the fixture path was wrong."}],"providerData":{"conversationRequestId":"…","messageId":"resp_02","model":"glm-5.2","requestModelId":"glm-5.2","agent":"cli","_isLastResponseItem":true,"usage":{"inputTokens":24486,"outputTokens":3,"totalTokens":24489},"rawUsage":{"prompt_tokens":24486,"completion_tokens":3,"total_tokens":24489,"prompt_tokens_details":{"cached_tokens":14720}}},"sessionId":"3f0c…","cwd":"D:\\work\\repo","message":{"usage":{"input_tokens":24486,"output_tokens":3,"total_tokens":24489,"cache_read_input_tokens":14720}}}
```

### 3.3 `message`, role `system`

Exists. `/clear` writes a session separator: `role:"system"` with `providerData.isSessionSeparator === true` (old data: id starting `session-separator-` or `clear-`); everything before it is no longer sent to the model [PKG history-utils.d.ts:137-149; JS "isSessionSeparatorItem"]. All parsers ignore non-user/assistant roles [AV workbuddy.go:209-218; DSH buddy-family.mjs:175].

### 3.4 `reasoning`

SDK `ReasoningItem`: `content` = summary parts `{type:"input_text", text}` (may be empty), `rawContent` = `{type:"reasoning_text", text}` parts, `providerData` like other output items. The engine itself replays thinking from **`rawContent[].text` where `type === "reasoning_text"`** and emits nothing if `rawContent` is empty [PKG JS@3741118 and @5568309: `c = i.rawContent; … joinProtectedTextBlocks(c, "reasoning_text", "")`]. Empty-reasoning records exist ("content[] empty, the model has not really thought yet") [PKG history-utils.d.ts:208]. It is a separate line written before the message/call of the same response and shares their `providerData.messageId` [PKG JS@7195900].

- DSH WorkBuddy reads `rawContent[]`/`reasoning_text` [DSH workbuddy.mjs:69-77]; DSH CodeBuddy reads `content` (string or array `.text`) [DSH codebuddy.mjs:145-156]; AV drops reasoning [AV workbuddy.go:80-153].
- Recommended: `rawContent[].text` joined; fall back to `content[].text`.

```json
{"id":"…r1","parentId":"…u1","timestamp":1790000001000,"type":"reasoning","content":[],"rawContent":[{"type":"reasoning_text","text":"The test reads fixtures/a.json …"}],"providerData":{"conversationRequestId":"…","messageId":"resp_01","model":"glm-5.2","agent":"cli"},"sessionId":"3f0c…","cwd":"D:\\work\\repo"}
```

### 3.5 `function_call`

Fields: `name` (string), `callId` (string), `arguments` (**JSON string** in the SDK and in the engine's own constructor: `arguments: typeof n === "object" ? JSON.stringify(n) : String(n)`), `status`, `providerData` [PKG JS "createToolCallItem"]. Both content parsers also accept an object [AV workbuddy.go:239-244; DSH buddy-family.mjs:62-72] — defensive, not evidenced.

- The string may be **unparseable**: a call cut off at the output-token limit is kept with `providerData.codebuddyArgumentsTruncated === true` and is never run [PKG input-item-utils.d.ts:3-7, 138-142].
- `callId` is **not globally unique in a file**: "the model can reuse an already-seen callId in a later reply; the two calls are independent instances" — the engine pairs by position [PKG history-utils.d.ts:447-448]. A failed step can also be re-sent with the same callId [DSH lib/convert/ir.mjs:133-141].
- Drafts with `providerData.isPartialAborted` or `providerData.discard` have no result [DSH workbuddy.mjs:67-68, codebuddy.mjs:171-172].
- Engine-made calls: `providerData.manual === true` [PKG JS "createToolCallItem"].

```json
{"id":"…fc1","parentId":"…r1","timestamp":1790000002000,"type":"function_call","name":"Bash","callId":"call_abc","arguments":"{\"command\":\"npm test\"}","status":"completed","providerData":{"conversationRequestId":"…","messageId":"resp_01","model":"glm-5.2","requestModelId":"glm-5.2","agent":"cli","_isLastResponseItem":true,"rawUsage":{"prompt_tokens":140732,"completion_tokens":635,"total_tokens":141367,"prompt_cache_hit_tokens":76032}},"sessionId":"3f0c…","cwd":"D:\\work\\repo"}
```

### 3.6 `function_call_result`

Fields: `name`, `callId`, `status`, `output`, `providerData` [PKG JS "createToolCallResultItem": `{id, name, callId, status, type:"function_call_result", providerData:{skipRun, error}, output:{type:"text", text}}`].

`output` shapes [PKG session-store.d.ts:213-217]:
1. string;
2. `{type:"text", text}` — the engine's default;
3. array of `{type:"input_text", text}` / `{type:"input_image", …}` / `input_file` parts.

Large outputs (default > 50 KB; `CODEBUDDY_TOOL_RESULT_THRESHOLD_KB`) are replaced in place by a placeholder text — the transcript then holds only a preview [PKG session-store.d.ts:186, 209-226; JS "externalize"]:

```
<persisted-output>
Output too large (123.4KB). Full output saved to: <absolute path>

Preview (first N bytes):
…
</persisted-output>
```

Images inside results are replaced by `image_blob_ref` objects (also inside JSON-in-string outputs) [PKG JS "replaceImageInFunctionCallOutput"].

Error signals:
- `status`: `"completed"` or `"incomplete"`. The engine sets `"incomplete"` when an error object is given, or when the output text is JSON with `isError === true` or a top-level `error` string / `error.message` [PKG JS "detectStatusFromOutput"].
- `providerData.error`, `providerData.toolResult.error`; "successful" = `status === "completed" && !providerData.toolResult?.error` [PKG JS "isSuccessfulFunctionCallResultItem"].
- `providerData.skipRun === true`: placeholder / refusal result, not a real tool output [PKG history-utils.d.ts:452-453].
- Parsers: DSH **drops** any result whose `status` is set and not `completed` [DSH buddy-family.mjs:212-213] — which makes its own `resultIsError` (`status !== "completed"` or `output.isError === true`, DSH codebuddy.mjs:137-143) unreachable for status; AV ignores status and errors [AV workbuddy.go:134-152].

Text extraction: AV — `output.text` if object, else raw JSON, else string [AV workbuddy.go:246-261]. DSH WorkBuddy — `output` then `providerData.toolResult`, each: string | `.text` | `.content` | `.output` [DSH workbuddy.mjs:43-56]. DSH CodeBuddy — string | array of `.text`/strings | object `.text`/`.content`/`.output` [DSH codebuddy.mjs:118-135].

```json
{"id":"…fr1","parentId":"…fc1","timestamp":1790000004000,"type":"function_call_result","name":"Bash","callId":"call_abc","status":"completed","output":{"type":"text","text":"1 failed, 12 passed"},"providerData":{"conversationRequestId":"…","messageId":"resp_01","model":"glm-5.2","agent":"cli","toolResult":{"title":"npm test","content":"…"}},"sessionId":"3f0c…","cwd":"D:\\work\\repo"}
```

### 3.7 Titles: `custom-title`, `ai-title`, `topic`

| type | fields | Evidence |
|---|---|---|
| `custom-title` | `customTitle: string`, `sessionId`, `id?` — written by rename; may be empty | [PKG openai-agents-types.d.ts:125-131; JS "rename"] |
| `ai-title` | `aiTitle: string`, `sessionId`, `id?` — generated | [PKG openai-agents-types.d.ts:144-150] |
| `topic` | `topic: string`, `id?` (no `cwd`, no `sessionId`) — older generated title | [PKG openai-agents-types.d.ts:138-143] |

Precedence used by the engine: latest non-empty `custom-title` > latest `ai-title` > (if none) `topic` [PKG session-store.d.ts:42-56]. Titles are written once, usually near the file head; for long sessions the same facts are repeated inside `session-meta.meta["codebuddy.ai/sessionTitle"]` [PKG same].

Parsers: AV — `ai-title` only, last one wins [AV workbuddy.go:81-84]; DSH CodeBuddy — `custom-title` (last wins, appended at the tail) > `ai-title` > first prompt [DSH codebuddy.mjs:105-114, lib/discovery/claude.mjs:373-391]; DSH WorkBuddy — no title records, first prompt only [DSH workbuddy.mjs:58-63].

```json
{"type":"ai-title","id":"…","aiTitle":"Fix failing fixture test","sessionId":"3f0c…","timestamp":1790000006000,"cwd":"D:\\work\\repo"}
{"type":"custom-title","id":"…","customTitle":"fixture bug","sessionId":"3f0c…","timestamp":1790000100000,"cwd":"D:\\work\\repo"}
```

### 3.8 `session-meta`

Two variants, both off-tree (no `parentId`), latest wins per key [PKG session-store.d.ts:297-311; JS "metaSnapshotLine", "persistContextWindow"]:

```json
{"type":"session-meta","id":"<uuidv7>","sessionId":"3f0c…","timestamp":1790000000000,"meta":{"codebuddy.ai/mainAgent":"…","codebuddy.ai/hostKind":"…","codebuddy.ai/sessionTitle":[…]}}
{"type":"session-meta","id":"<uuidv7>","sessionId":"3f0c…","storeId":"agent-…","timestamp":1790000000000,"contextWindow":{…,"messageId":"…"}}
```

- `meta` keys are a whitelist: `codebuddy.ai/mainAgent, codebuddy.ai/hostKind, codebuddy.ai/toolMode, codebuddy.ai/toolModeSource, codebuddy.ai/codeMode, multitaskMode, delegateMode, codebuddy.ai/a2aContexts, codebuddy.ai/agentRuntime, codebuddy.ai/sessionTitle, codebuddy.ai/privateDataSticky, activeGoal` [PKG session-store.d.ts:74]. `meta: {}` is a tombstone [session-store.d.ts:95-100]. Old lines may lack `id` [session-store.d.ts:104-109].
- First line of a new session; re-appended every 200 history lines [session-store.d.ts:21-38]. Not a title/cwd carrier except `codebuddy.ai/sessionTitle`. No `cwd` key is added by `metaSnapshotLine`.
- `codebuddy.ai/hostKind` may distinguish hosts (CLI vs desktop) — value set not read.

### 3.9 `file-history-snapshot`

`{type, messageId?, parentId?, timestamp, isSnapshotUpdate: boolean, snapshot: {messageId, trackedFileBackups: {<path>: {backupFileName?: "hash@vN", version, backupTime, existedAtTrack?}}, updatedFilePaths?: string[]}, id?, providerData?}`; `parentId` = the user message id (updateSnapshot) or the tool `callId` (trackFile). A newer **delta** form exists with `snapshotBaseHash` / `snapshotHash` [PKG custom-input-item-types.d.ts:193-260; vendor/cbc-core/node/session/file-history-snapshot-codec.d.ts:5-9]. Backups live in `<root>/file-history/<sessionId>/` [PKG JS "getHomeFileHistoryDir"]. Skip for display. Its legacy `id` "can collide with a user entry" [PKG transcript-branch.d.ts:15-17] — do not index it by `id`.

```json
{"type":"file-history-snapshot","messageId":"…u1","parentId":"call_abc","timestamp":1790000002500,"isSnapshotUpdate":true,"snapshot":{"messageId":"…u1","trackedFileBackups":{"src/a.ts":{"backupFileName":"9f2c@v1","version":1,"backupTime":1790000002400,"existedAtTrack":true}},"updatedFilePaths":["src/a.ts"]},"cwd":"D:\\work\\repo"}
```

### 3.10 Metering / runtime facts (skip for the graph, except where noted)

| type | fields | Evidence |
|---|---|---|
| `model-usage` | `id, parentId?, timestamp, providerData:{messageId, rawUsage, usage?, model?, requestModelId?, conversationRequestId?, agent?}` — "a completed model response whose usage has no committed output item" (also late billing). **Counts toward usage** | [PKG custom-input-item-types.d.ts:69-84; JS@7200894, "toLateBillingUsageItem"] |
| `credit-usage` | `providerData:{conversationRequestId, credit, source:"team_member"|"generation_tool", stageId, messageId?}` — credits, not tokens | [PKG custom-input-item-types.d.ts:49-68] |
| `context-usage` | `contextTokens, usageByCategory:{systemPrompt, conversation, tools, mcp, skills, version:1}`, `parentId?` — context-window snapshot at turn end | [PKG custom-input-item-types.d.ts:85-115] |
| `turn-metrics` | `durationMs, tokenDelta, source?:"turn"|"background-task", taskStatus?` — one per finished turn (interactive TUI only for the background-task variant) | [PKG openai-agents-types.d.ts:171-179; JS "appendCompletionMetrics"]; [TS tencent_buddy.rs:46-49, 236-240] |
| `acp-terminal-state` | `parentId, requestId, rootRequestId, attempt?, stopReason, cost?:{amount (cumulative), currency}, error?:{code, message, …}` — durable end-of-turn marker | [PKG custom-input-item-types.d.ts:116-162] |
| `request-recovery` | `parentId, requestId, userMessageId, attempt` | [PKG custom-input-item-types.d.ts:37-48] |
| `resend-fork-notice` | `parentId?, editedUserItemId?, providerData:{skipRun:true, resendFork…}` — rewind/edit tombstone, section 7 | [PKG custom-input-item-types.d.ts:163-192; JS "createResendForkNoticeItem"] |
| `checkpoint-restore` | `operationId` | [PKG custom-input-item-types.d.ts:29-36] |
| `summary` | `summary: string` (no `cwd`) | [PKG openai-agents-types.d.ts:132-137] |
| `goal-state` / `goal-result` / `goal-progress` | goal feature | [PKG custom-input-item-types.d.ts:2-20; openai-agents-types.d.ts:151-170] |

DSH counts all of these as `droppedMetaItems` [DSH buddy-family.mjs:228-233; list in codebuddy.mjs:20-22]; AV ignores every type it does not name [AV workbuddy.go:80-153].

---

## 4. User prompt: what the human typed, and which user messages are not human

### 4.1 Wrapper format (engine protocol, both products)

The prompt text sent by a client is `hidden context blocks + <user_query>…</user_query>` [PKG JS "wrapHiddenContextXml", "wrapUserQueryXml" (@11444291)]:

```
<system-reminder data-role="user-context">
…
</system-reminder>
<user_query>the text the human typed</user_query>
```

Known `data-role` values: `user-context` (first message: `user_info`, `identity_context`, `project_context`; later turns a short form with `current_time` + `special_instructions`), `current-context`, `additional-data` (`current_time`, `attached_files`, `tdrive_attachments`), `error-recovery`, `message-queue`, `command-caveat`, `compact-summary` [PKG history-utils.d.ts:6-14, 303-309, 359-366; input-item-utils.d.ts:86-88, 147; JS "LOCAL_COMMAND_TIP"].

The engine's own extraction, used when it replays a transcript to a UI [PKG JS "stripPromptContextXml" (@11444291) and the user branch of the replay converter (@3733300-3738900)]:

```js
stripSystemReminderXml(t) = t.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>\s*/g, "")
stripUserQueryXml(t)      = t.replace(/<user_query>([\s\S]*?)<\/user_query>/g, "$1")
human(t)                  = stripUserQueryXml(stripSystemReminderXml(t)).trim()
```

Applied **per text part** (each `input_text` separately), and a part is skipped entirely when `isSystemInternalMessage(part)`:

```js
// [PKG JS "isSystemInternalMessage" @7044311]
trimStart(part).startsWith("<system-reminder") && !part.includes("<user_query>")
|| part === '<system-reminder data-role="command-caveat">Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</system-reminder>'
|| /<command_name>\s*\/clear\s*<\/command_name>/.test(part)
```

Further rules in the same code path:
- Local-command echo parts are not prompts: a part containing bash-input / memory-input / `<command_name>` / `<command-message>` / `<command-args>` tags is shown as a slash/bash command (`parseInput`); a part containing `<local-command-stdout>` / bash stdout / stderr tags is command **output**, shown as an agent-side code block (`parseOutput`) [PKG JS @7044714, @7045552].
- `<image_local_path>` markup is stripped / skipped; a `<channel …>…</channel>` envelope carries a chat-channel message (its content replaces the text) [PKG JS @3737562, regexes `rF`/`om`].
- Other envelopes that mark non-human text: `<cb_summary>`, `<conversation_history_summary>`, `<task-notification>`, `<monitor-event>`, `<teammate-message …>`, `<turn_aborted>` [PKG JS @7059206; input-item-utils.d.ts:276-277].

Third-party rules:
- DSH WorkBuddy: join the `.text` of **all** parts with `\n`; take the **first** `<user_query>([\s\S]*?)</user_query>` if non-empty; else remove `/<system-reminder[\s\S]*?<\/system-reminder>/gi`, replace remaining tags with a space, collapse whitespace; non-array content → `''` (no turn) [DSH workbuddy.mjs:19-26; lib/convert/inject.mjs:84-86; lib/convert/util.mjs:48-63].
- DSH CodeBuddy: no unwrapping at all — "user prompts are not wrapped" [DSH codebuddy.mjs:15, 49-65].
- AV WorkBuddy: no unwrapping; first user message, raw, truncated to 300 chars, is the preview [AV workbuddy.go:90-96]. (AV's IDE-format parser does have `(?s)<user_query>(.*?)</user_query>` [AV internal/parser/codebuddy.go:17].)

Recommended: per part, apply the engine rule; if a `<user_query>` is present anywhere, concatenate all `<user_query>` bodies (engine keeps all, DSH keeps the first — differs only if a message has several). Works for both products, wrapped or not [INF].

### 4.2 Structural flags — user-role messages that are not a human prompt

All under **`providerData`** [PKG JS @6979239-6980400]:

```js
isRealUserMessageItem(i) = type=="message" && role=="user"
   && !providerData.skipRun
   && providerData.isCompactInternal !== true
   && !isCompactUserMessage(i)        // isCompacted | isSummary | compactType (string) | agent=="compact" | content has <cb_summary / <conversation_history_summary / data-role="compact-summary"
   && !isSystemTeammateMessage(i)     // typeof providerData.teammateMessage?.from == "string" | content has <teammate-message
isExternalUserPromptItem(i):          // "a new request really sent from outside the session"
   n = providerData.startsNewUserRequest
   base = (n === true ? isLiveStreamUserMessageItem(i) : isRealUserMessageItem(i))
   if (!base || providerData.agent == "compact" || providerData.isAdditionalData) return false
   if (n !== undefined) return n === true
   return providerData.isMeta !== true
isInternalContinuationItem(i) = user && providerData.isMeta === true && providerData.startsNewUserRequest === false
```

| Marker | What the message is | Human? |
|---|---|---|
| `skipRun: true` | placeholder that triggers no model run (the engine's `createUserMessage` defaults to it): interruption notes, local-command records, `<turn_aborted>` | no |
| `isMeta: true` | not displayed as normal user input: error-recovery reminders, notification injections, cron triggers, team takeovers | no (but may start a turn, e.g. cron) |
| `isMeta && startsNewUserRequest === false` | runtime continuation (`<system-reminder data-role="error-recovery">`, `"Please continue."`) | no; **same turn continues** |
| `startsNewUserRequest === false` without `isMeta` | **queued real user message injected mid-turn** ("they really are user questions") | **yes**, but it does not start a new request [PKG input-item-utils.d.ts:196-203] |
| `isAdditionalData: true` | attached context | no |
| `isCompactInternal`, `isCompacted`, `isSummary`, `compactType`, `agent:"compact"` | compaction trigger / summary / continue prompt | no |
| `teammateMessage.from` or `<teammate-message` | background-task / team notification | no |
| `queueHold: true` | Tab-queued real prompt | yes |

Tool results are **not** user messages in this format (they are `function_call_result` lines) — unlike Claude Code. AV nevertheless maps each result to a synthetic user-role message in its own model [AV workbuddy.go:141-152]; that is AV's output shape, not the file's.

---

## 5. Turn structure and call/result pairing

**Explicit ids exist** [PKG JS "handleStreamRunResult"]:
- `providerData.conversationRequestId` — one per user request (turn); stamped on every model output item of the turn (including `function_call_result`) and on the triggering user message; also in `credit-usage`, and as `requestId`/`rootRequestId` in `acp-terminal-state`.
- `providerData.messageId` — one per model response (step) within the turn.
- Turn end markers: `turn-metrics` (duration) and `acp-terminal-state` (`stopReason`, error) — both optional/host-dependent.

No third-party parser uses `conversationRequestId`; they derive turns:
- DSH: a turn opens at each user message whose extracted prompt is non-empty; `reasoning` is buffered and prepended to the next step; an assistant `message` opens a new step; a `function_call` attaches to the **current** step or opens one [DSH buddy-family.mjs:119-136, 161-208].
- TS: a user message resets the turn; `turn-metrics` closes it [TS tencent_buddy.rs:236-245].
- AV: flat message list, no turns [AV workbuddy.go:85-153].

Recommended: open a turn at each user message accepted by 4.2 (treat `startsNewUserRequest === false` real prompts as an extra prompt node inside the running turn); cross-check with `conversationRequestId` when present; group steps by `messageId` [INF]. Whether old files / WorkBuddy files always carry `conversationRequestId` is open.

**Pairing**
- Key is `callId` on both records; `name` is repeated on the result [PKG JS "createToolCallResultItem"].
- Order: parallel calls of one response are consecutive, their results follow the group (results may arrive out of order relative to calls) [PKG history-utils.d.ts:468-474; DSH buddy-family.mjs:22].
- Engine: pairs **by position**, not by global callId, because callIds can repeat; an unpaired call or result is dropped from *model input* only — it stays in the file [PKG history-utils.d.ts:441-455]. Missing results are filled with placeholders at request time, not on disk [history-utils.d.ts:463-482]. A lost tail is possible: a failed append batch is abandoned after retries [PKG session-store.d.ts:487-497].
- DSH: map `callId → step` (last declaration wins); result with no known call → dropped and counted (`droppedOrphanResults`); call without `callId` → skipped; aborted/discarded drafts skipped; a step that is only tool calls, has no results, and is re-sent identically (same id, name, arguments) by the next step → dropped [DSH buddy-family.mjs:102-103, 186-226; lib/convert/ir.mjs:133-167].
- AV: no pairing in the parser — emits calls and results independently, skipping records with empty `name`/`callId` [AV workbuddy.go:113-152].

Recommended: pair each result with the nearest preceding unpaired call of the same `callId` on the active branch; keep orphan calls as "no result" tool nodes; drop or flag orphan results [INF].

---

## 6. Token usage

### 6.1 Where

| Location | Shape | Written when | Evidence |
|---|---|---|---|
| `providerData.usage` | SDK camelCase: `inputTokens, outputTokens, totalTokens, inputTokensDetails (object or array, with cached_tokens), outputTokensDetails` | on output items / `model-usage` | [PKG JS "getLatestUsageSnapshot", "getCacheReadTokens"; custom-input-item-types.d.ts:82] |
| `providerData.rawUsage` | provider raw, usually OpenAI-style: `prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details.cached_tokens, completion_tokens_details.reasoning_tokens`, or `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `prompt_cache_write_tokens` (DeepSeek-style), or `cache_read_input_tokens` / `cache_creation_input_tokens` (Anthropic-style mirror); plus `credit` | on the last item of each response; on `model-usage` | [PKG JS@7197300, @2827481]; [TT 10603-10610, 11321-11328] |
| top-level `message.usage` | snake_case: `input_tokens, output_tokens, total_tokens`, and `cache_read_input_tokens` / `cache_creation_input_tokens` only when > 0 | save-time copy of `providerData.usage`, on `message` and `function_call` | [PKG JS "normalizeUsageFormat"]; [TS codebuddy.rs:33 fixture] |

Usage is on assistant `message` **and** `function_call` lines (a round-trip that ends in a tool call is logged on the call): "function_call records are ~93% of round-trips and ~14x the assistant-message token volume" [TT 11116-11121]; and on `model-usage` lines [PKG]. Because `messageId` is stamped on every item of a response and merged usage can be written to more than one of them, the same response's usage can appear on several lines.

### 6.2 De-duplication

**One usage per `providerData.messageId`.** [TT 11135-11154, 11756-11770; TS tencent_buddy.rs:316-331].
- TT: first record seen wins; key fallback `messageId → uuid → id → sessionId:timestamp`; considers **any** line with `providerData.rawUsage` (so it also covers `model-usage`, and `reasoning`/results if they ever carry it).
- TS: only `message`(assistant) and `function_call` with `status` absent or `completed`; key `messageId → traceId → id`, scoped by session; on a duplicate key **the larger total wins**.
- AV and DSH do **not** de-duplicate: AV attaches usage to every assistant message and every call and sums them [AV workbuddy.go:104-106, 131, 185]; DSH keeps one usage per step, message-level first, else the first call's [DSH buddy-family.mjs:138-148, 170-171, 193-194]. Both can double count when a response has a text message plus calls, or several calls.

Recommended: collect candidates from `message`(assistant), `function_call`, `model-usage` on **all** branches (abandoned branches were billed too — choose deliberately); group by `messageId` (fallback `id`); take the candidate with the largest total [INF combining TT/TS/PKG].

### 6.3 Mapping to `{input, cachedInput, output}`

Field aliases (union of all readers):

| Bucket | Keys, in the engine's own order where it has one |
|---|---|
| cache read | `cache_read_input_tokens`, `cacheReadInputTokens`, `inputTokensDetails[].cached_tokens`, `prompt_tokens_details.cached_tokens`, `prompt_cache_hit_tokens` — first **positive** [PKG JS "getCacheReadTokens"]; also `cacheTokens`/`cache_tokens` [DSH codebuddy.mjs:98; TS tencent_buddy.rs:98-101] |
| cache write | `cache_creation_input_tokens`, `cacheCreationInputTokens`, `prompt_cache_write_tokens` — first positive [PKG JS "getCacheCreationTokens"] |
| input (gross) | `input_tokens`, `inputTokens`, `prompt_tokens` (`promptTokens`) |
| output | `output_tokens`, `outputTokens`, `completion_tokens` (`completionTokens`) |
| reasoning | `completion_tokens_details.reasoning_tokens`, `reasoning_tokens`, `reasoningTokens`, `completion_thinking_tokens` — **included in** completion/output tokens [TT 11179-11183, 11327-11328] |

**Are cached tokens included in input? Yes for the OpenAI/DeepSeek-style shapes, which are what real files contain.**
- Engine: when `rawUsage` has any of `prompt_tokens`, `prompt_tokens_details`, `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, `inputTokensDetails`, then `input = max(0, usage.inputTokens − cacheRead − cacheCreation)`; otherwise `usage.inputTokens` is already exclusive [PKG JS "getCurrentContextUsage" @2827481].
- TT (real logs): `prompt_tokens` is the full prompt = cache reads + cache writes + new input; `input = prompt_tokens − cacheRead − cacheCreate`; `total_tokens === prompt_tokens + completion_tokens` [TT 11321-11343].
- TS: subtracts `cache_read` only when a reported total equals `input + output` (proves inclusion) [TS tencent_buddy.rs:157-190]; its fixture shows the save-time `message.usage` is inclusive too (`input_tokens 24486`, `cache_read_input_tokens 14720`, `total_tokens 24489`) [TS codebuddy.rs:33-43].
- AV: subtracts cache read only if the key `prompt_tokens` exists; with `inputTokens` + `cacheReadInputTokens` it does not [AV workbuddy.go:275-292].
- DSH: never subtracts [DSH codebuddy.mjs:82-103]. DSH's WorkBuddy profile defines **no** `usageOf`, so WorkBuddy usage is not read at all [DSH workbuddy.mjs:59-79; buddy-family.mjs:140-141].

Recommended mapping:
```
src        = providerData.rawUsage ?? providerData.usage ?? message.usage      // rawUsage is the provider's own numbers
cachedInput= firstPositive(cache-read aliases)
cacheWrite = firstPositive(cache-write aliases)
gross      = first present of input aliases
inclusive  = src has prompt_tokens | prompt_tokens_details | prompt_cache_hit_tokens | prompt_cache_miss_tokens | inputTokensDetails
             || (total_tokens present && total_tokens == gross + output)
input      = inclusive ? max(0, gross − cachedInput − cacheWrite) : gross
output     = first present of output aliases        // includes reasoning
```
If the tool's `input` is meant to *include* cache, use `gross` (inclusive case) or `gross + cachedInput + cacheWrite` (exclusive case). Model for the session: `providerData.model`, else `providerData.requestModelId` [DSH codebuddy.mjs:67-74; TT 11788-11792]; WorkBuddy may log the router placeholder `"auto"` [TT 11345-11346].

---

## 7. Write behaviour

| Topic | What the writer does | Evidence |
|---|---|---|
| Append-only | Yes. Appends are `appendFile`-style, serialised per file by a lock. `save()` only materialises a missing/empty file; nothing rewrites existing lines. "history is append-only, forks via parentId … no need to rewrite the history file" | [PKG session-store.d.ts:254-257, 487-497; JS "save", "appendHistory"; input-item-utils.d.ts:116-118] |
| Rollback | A failed append batch is rolled back: `unlink` if this batch created the file, else `truncate` to the previous size. So the file can **shrink by a partial batch**, and after retries (50/100/200/400 ms) a batch can be abandoned — "the local copy is allowed to lose its tail" | [PKG session-store.d.ts:487-497; JS "transcriptRetryDelaysMs"] |
| Granularity | One line per completed item (message, reasoning, call, result), not token deltas. Repeated identical `file-history-snapshot`s are skipped. Extra `session-meta` every 200 lines | [PKG JS "handleStreamRunResult", "dropRepeatedSnapshots"; session-store.d.ts:21-38] |
| Active branch | **Yes — a `parentId` tree with one lane, `main`, whose tip is the active leaf.** Walk: from the tip follow `parentId` to the segment root; facts never advance the tip. The tip is not stored in the local file; it is recovered heuristically on load | [PKG vendor/cbc-core/node/session/session-store-contract.d.ts:27-76; transcript-branch.d.ts:11-33; local-jsonl-session-store.d.ts:46-47] |
| Rewind (`/rewind`, conversation revert) | Appends one `resend-fork-notice` with `parentId` = the new head (absent = empty conversation). Nothing is deleted | [PKG JS "rewindSession"; history-utils.d.ts:64-78, 110-121] |
| Edit / resend | Same tombstone, then the new user message is appended with the same parent as the edited one → sibling branch | [PKG custom-input-item-types.d.ts:163-178] |
| Content filter | The filtered turn is forked off: a notice assistant message (`providerData.contentFilterNotice`, `strippedUserMessageId`) is appended with `parentId` pointing before the filtered output | [PKG input-item-utils.d.ts:111-130] |
| Compaction | Appends: compact-agent messages (`providerData.agent:"compact"`, `isCompactInternal`) and a boundary **user** message carrying the summary (`isCompacted` / `isSummary` / `compactType`; text in `<cb_summary>` or `<conversation_history_summary><summary>…`). The boundary has **no `parentId`** and `logicalParentId` = previous tip — a new segment root. Old lines stay | [PKG JS ParentIdLinkage class; history-utils.d.ts:165-177, 245-253, 292-301] |
| `/clear` | Appends a `system` separator message (3.3); same file continues | [PKG history-utils.d.ts:137-149] |
| Resume | Same file, appended. Loading reads from the **end** with a cap (default 1000 items, `CODEBUDDY_SESSION_MAX_ITEMS`), plus a 256 KB head scan for `session-meta`/titles | [PKG session-store.d.ts:15-40, 116-123]; [DOC https://www.workbuddy.ai/docs/cli/env-vars] |
| Fork (`session/fork`) | New session file (new id) with cloned history and re-mapped ids, including cloned subagent files and tool-result files | [PKG session-store.d.ts:76-82, 525-579] |
| Delete | Root JSONL is renamed to a non-catalog tombstone name, subagent dirs removed, tombstone removed last | [PKG session-store.d.ts:413-427] |
| Hooks | `transcript_path` = the session JSONL path (`…/.codebuddy/projects/…/<uuid>.jsonl`); some events pass `""` | [DOC https://www.workbuddy.ai/docs/cli/hooks]; [PKG JS `transcript_path:""` for InstructionsLoaded / ConfigChange] |

**Active-branch algorithm** (port of the engine; cold load has no stored tip) [PKG JS "resolveTip", "getActiveHistory"; history-utils.d.ts:29-46, 110-131]:

```
lines   = all records except session-meta, file order
compact = any line has logicalParentId (string) and no parentId
tip:
  scan from the end for the last resend-fork-notice N
    - a non-custom line exists after N        → tip = id of the last non-custom line   (new branch continued)
    - only custom lines (or nothing) after N  → tip = N.parentId (absent → empty conversation)
  no N: if a contentFilterNotice exists → tip = id of the last non-custom line and walk;
        otherwise the engine replays the file **as is** (no walk) — safe default
walk (when a tip was chosen): E = tip; scan the file backwards; at a line with id == E, take it and every
  immediately preceding line with the same id; then
  E = line.parentId ?? ((compact || line is last in file || providerData.agent == "compact") ? line.logicalParentId : undefined)
  stop when E is undefined or not found; reverse.
custom lines: keep those whose parentId points at an active line (or handle by type).
```

The engine deliberately does **not** walk when there is no fork marker, because duplicate ids make a blind walk lose messages [PKG history-utils.d.ts:40-42]. For a display tool: no marker → show everything; marker → hide lines not on the walk (or show them as an abandoned branch).

Two further rules of **this project's reading** (Agent Canvas, `packages/server/src/normalize/buddy-branch.ts` and `buddy.ts`). They are choices made for display, not statements about what the product writes or does:

- **No `parentId` anywhere.** A file in which no line has a `parentId` is shown as it is, even when it holds a fork marker (`resend-fork-notice` or a content-filter notice): there is no tree to walk.
- **Dangling parent.** When the walk reaches a parent id that no earlier line of the file carries, branch selection is given up: every line of the thread is shown, as if there were no marker, and the case is counted once per thread as an unrecognised record of type `<origin>:dangling-parent` (`workbuddy:dangling-parent` or `codebuddy:dangling-parent` on the diagnostics page). The engine's own walk stops there and keeps the partial chain; showing everything instead is the safer default for a reader that cannot ask the engine.

---

## 8. Differences between the two products, and between versions

| # | Special case | Handled by |
|---|---|---|
| 8.1 | **Prompt wrapper.** DSH treats `<user_query>` wrapping as WorkBuddy-only and CodeBuddy as unwrapped. The wrapper is in the shared engine and is applied by any client that sends context (desktop, web UI, ACP hosts); a bare terminal prompt may be unwrapped. Treat as per-message, not per-product | [DSH workbuddy.mjs:6, 19-26 vs codebuddy.mjs:15-16]; [PKG JS "wrapUserQueryXml", "stripPromptContextXml"] |
| 8.2 | **Data root rename** `.workbuddy` → `.workbuddy-ai` (edition or version ≥ 5.9.x) | [DSH lib/discovery/claude.mjs:244-248, 358-363, 470-477; CHANGELOG.md:88,103]; [TT 11356-11366] |
| 8.3 | **Titles**: CodeBuddy has `custom-title`/`ai-title`; DSH says WorkBuddy has none; AV reads `ai-title` in WorkBuddy files | [DSH workbuddy.mjs:6, 62-63; codebuddy.mjs:105-114]; [AV workbuddy.go:81-84] |
| 8.4 | **Reasoning field**: `rawContent[]` (DSH WorkBuddy) vs `content` (DSH CodeBuddy) | [DSH workbuddy.mjs:69-77; codebuddy.mjs:145-156] — the SDK item has both; the engine reads `rawContent` (3.4) |
| 8.5 | **Result text**: WorkBuddy profile also looks in `providerData.toolResult`; CodeBuddy profile also accepts array output | [DSH workbuddy.mjs:43-56; codebuddy.mjs:118-135] |
| 8.6 | **Usage shape by upstream**: OpenAI-style vs DeepSeek-style vs Anthropic-style mirrors; "CodeBuddy's cache_creation is always 0; WorkBuddy writes cache heavily" → subtract cache writes too | [TT 11321-11343]; [AV workbuddy.go:267-292] (`usage` vs `rawUsage`, object-shaped output — added during PR review per earlier notes) |
| 8.7 | **CodeBuddy IDE extension is a different format**: `…/CodeBuddyExtension/Data/…/history/<ws_hash>/<session_id>/index.json` + `messages/*.json` (Windows `AppData/Local/…`, macOS `Library/Application Support/…`, Linux `.config/…`). AV's "codebuddy" agent is this, not the CLI | [AV internal/parser/codebuddy.go:19-34] |
| 8.8 | **Ephemeral cwd**: WorkBuddy creates a per-session folder like `WorkBuddy AI/2026-10-27-13-46-52`; DSH treats a timestamp-only last segment as "no usable cwd" | [DSH CHANGELOG.md:84,99] |
| 8.9 | **Model placeholder** `"auto"` in WorkBuddy logs | [TT 11345-11346] |
| 8.10 | **Version drift inside the writer**: `session-meta` lines without `id` (pre-#94203); `.meta.json` sidecar retired; `topic` → `ai-title`; delta `file-history-snapshot`; session separator without `isSessionSeparator`; `function_call_output` legacy type; old `acp-terminal-state` without `cost`/`attempt`; legacy "self-parent compact" records needing `recoverLegacySelfParentCompact`; dangling `parentId` on hook-blocked notices | [PKG session-store.d.ts:104-109, 301-308; file-history-snapshot-codec.d.ts:5-9; history-utils.d.ts:51, 80-95, 142-146; custom-input-item-types.d.ts:125-134] |
| 8.11 | **Other WorkBuddy stores**: `traces/**/trace_*.json` (aggregate usage), `workbuddy.db` | [TT 11347-11353, 11438-11458] |

WorkBuddy Desktop's embedded engine version is unknown; DSH derived the vocabulary from CLI v2.179.3 and matched it against real WorkBuddy transcripts [DSH buddy-family.mjs:15].

---

## 9. Where the sources disagree (least certain points)

| # | Point | Positions | My reading |
|---|---|---|---|
| D1 | Where `isMeta` / `skipRun` / `startsNewUserRequest` / `isAdditionalData` / `agent` live | DSH CodeBuddy: **top level** of the record [DSH codebuddy.mjs:49-55; fixtures test/codebuddy.test.mjs:98-105]. Writer: **`providerData.*`** [PKG JS@6979239] | PKG. DSH's fixtures are synthetic; its filter would never fire on real files. Read `providerData.x`, optionally also top-level `x` |
| D2 | `agent` value for compaction | DSH compares upper-cased to `COMPACT` [DSH codebuddy.mjs:54-55]; writer doc says `providerData.agent === 'compact'` [PKG history-utils.d.ts:206] | compare case-insensitively |
| D3 | Reasoning text field | `rawContent` vs `content` (8.4); DSH's CodeBuddy fixture even puts `reasoning_text` parts under `content` [DSH test/codebuddy.test.mjs `reasoningRec`] | `rawContent` first, then `content` |
| D4 | Usage source priority | AV: `usage` then `rawUsage`. DSH: `usage || rawUsage`. TS: `message.usage` → `providerData.usage` → `rawUsage`. TT: `rawUsage` only | unresolved which is "most correct"; they should agree numerically except for inclusive/exclusive input (D5) |
| D5 | Is input inclusive of cache | TT/PKG: inclusive for OpenAI/DeepSeek shapes, subtract read **and** write. TS: subtract read only, only when a total proves it. AV: subtract read only when `prompt_tokens` key exists. DSH: never | 6.3 rule |
| D6 | Usage de-duplication | TT/TS: by `messageId`. AV/DSH: none | de-duplicate |
| D7 | Which records carry usage | TT: any record with `rawUsage`. TS/AV: assistant `message` + `function_call`. Writer: also `model-usage` | include `model-usage` |
| D8 | Titles in WorkBuddy files; `.meta.json` sidecar | DSH: no title records; sidecar current. AV: `ai-title` honoured. PKG: title items exist in the shared engine; sidecar retired | read title lines in both products; ignore sidecar unless no title found |
| D9 | Why two WorkBuddy roots | TT: edition (CN vs international). DSH: version (5.9.x rename). tokscale README (earlier notes): "from 5.5 onward" | scan both |
| D10 | Results with `status !== "completed"` | DSH drops them (and so never shows a failed tool result); AV keeps everything; writer uses `incomplete` for errors | keep, mark as error |
| D11 | Orphans / duplicates | DSH drops orphan results and dead retry steps; AV keeps all; writer pairs by position because callIds repeat | section 5 |
| D12 | Subagent files | AV: child session linked by directory, any file name. DSH: skipped (`agent-*`). TT: counted for usage. Nobody reads `toolResult.subAgent` | use directory + `toolResult.subAgent.sessionId` |
| D13 | `timestamp` type | AV: number only (strings → zero time). DSH: number (seconds if < 1e11) or date string | number ms; accept strings defensively |
| D14 | `arguments` / `output` object forms | AV/DSH accept object `arguments`; SDK and writer produce strings. `output` array form: DSH CodeBuddy only | accept all |
| D15 | Session identity for subagent lines | TT/TS/DSH use the line's `sessionId` (a runtime UUID in subagent files); AV uses the path | use the path |
| D16 | Project dir name | DSH: "hash" for WorkBuddy, compressed path for CodeBuddy; PKG: same compressed-path rule for both | PKG |

---

## 10. Open questions that only a real file can settle

1. **Does a real WorkBuddy line look like 2.185.0's output?** Which engine version each WorkBuddy build (5.2 … 5.11, CN vs international) embeds, and whether older files lack `providerData.conversationRequestId` / `messageId`, `session-meta`, `message.usage`.
2. Exact content of `providerData.usage` on disk (does it carry `inputTokensDetails`, or keys like `cacheReadInputTokens` as AV's fixture assumes?), on which lines of a response `usage`/`rawUsage` actually appear, and whether `usage`, `rawUsage` and `message.usage` ever disagree. Whether `model-usage` lines occur in practice.
3. Whether WorkBuddy files contain `ai-title` / `custom-title` / `topic` lines (DSH says no, AV says yes), and whether `session-meta.meta["codebuddy.ai/sessionTitle"]` is populated.
4. Presence and exact shape of `providerData.toolResult.subAgent` on the parent's Agent-tool `function_call_result`; the Agent tool's `name` and `arguments` keys (`subagent_type`, `description`, `prompt`?); the `agent-…` storeId format; what subagent lines carry in `sessionId`; how agent teams (`teams/`) and background tasks appear.
5. What the first user message of a WorkBuddy session really contains (parts layout: one part or several; tags inside `user-context`; `Workspace Folder`), and whether CodeBuddy terminal prompts are wrapped in `<user_query>` in current versions.
6. `workbuddy.db`: full schema, whether `sessions.title` holds titles that the JSONL lacks, and whether session ids there equal the JSONL stems.
7. Whether `cwd` in WorkBuddy lines is the user's workspace or the per-session timestamp folder, and whether it changes within a file (worktrees, `CwdChanged`).
8. Windows specifics: drive-letter case and separators in `cwd` and in the project directory name; `blob_path` / `<persisted-output>` path forms.
9. Real distribution of duplicate `id`s (message + function_call sharing one id) and repeated `callId`s — this decides whether nodes can be keyed by `id`.
10. What a rewind / edit-resend / compaction looks like in an actual file (the `resend-fork-notice` and boundary-message fields as written), to validate the active-branch port in section 7.
11. Whether `reasoning.rawContent` is populated for all model providers (encrypted/absent reasoning), and what `content` holds then.
12. Which edition/version rule decides `~/.workbuddy` vs `~/.workbuddy-ai`, whether both can coexist, and which mechanism (env var vs product config) WorkBuddy uses to set the root; Linux build paths.
13. Retention: whether WorkBuddy applies the CLI's `cleanupPeriodDays` deletion to transcripts.
