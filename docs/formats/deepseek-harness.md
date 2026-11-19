# DeepSeek Harness (`dsh`) session files — on-disk format, verified against raw source

Date: 2026-11-17. Method: raw file text only (raw.githubusercontent.com and one streamed
source archive), no installation, no file from a real user machine (one real file was compared later, see "Checked against one real file").

**Pin:** `deepseek-ai/deepseek-harness` commit `39163dd30f703a79079e2d2446545cff3c453738`
(master head, 2026-11-13, "sync 0.2.2-rc.3 back to master"). The release tag
`dsh-v0.2.2-rc.3` is commit `38a6a5c965aa99ab525161efb7cc5cf1fe62fced`; all line numbers
below are at the first SHA. Base URL for every path:
`https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/39163dd30f703a79079e2d2446545cff3c453738/<path>`

Marks: **[SRC]** read in the pinned source (path:lines). **[DOC]** prose docs/READMEs in the
same pinned tree (official, but prose). **[FIX]** test fixtures committed in the pinned tree
(`snapshots/**/session.v4.jsonl`) — written by the product's writer, then *normalised*
(ids/cwd/system prompt tokenised, `seq` and `time` removed; `snapshots/AGENTS.md:7,11`), so
they prove payload shapes but not the exact envelope bytes. **[3P]** third-party. **[INF]** my
inference.

Short names used below:

- `jsonl/` = `packages/session/session-persistence-jsonl/src/`
- `core/` = `packages/core/session/src/`
- `llm/` = `packages/llm/llm/src/`
- `catalog.md` = `docs/persistence-catalog.md` (generated from source; embeds the declarations verbatim and names their source file:line)

---

## 0. Answers in one screen

| Question | Answer |
|---|---|
| Container | Plain concatenation of independent, standard, checksummed Zstandard frames. No magic, header or length prefix outside zstd. Frame 1 = the header line only; each later frame = one append batch of whole JSONL lines. [SRC] |
| Standard decoder? | Yes, frames are standard. `zstd -dc` works. For Node, do what the product does: find frame boundaries with a ~60-line header walk and decompress each frame with `zlib.zstdDecompressSync`. Whether Node's one-shot/stream API accepts several concatenated frames in one call is **not** shown by the source (the product never does that). [SRC]+[INF] |
| Tail from byte offset | Yes. Every frame is independently decodable, so "decoded up to byte N" works when N is the end of a complete frame. Must handle: file shrinking (truncate + rewrite of the tail) and a changed first frame. [SRC] |
| v4 rows | Plain JSON objects, one event per line, keys `type, seq, time, data` + optional `ignorable, sourceEventSeqs, surfaceOp`. Not positional. The only stored-vs-logical difference is `sourceEventSeqs` run-length pairs. [SRC] |
| Usage | `assistant/message.data.usage`: `inputTokens` = **uncached** input, `cacheReadTokens` = cached input, `outputTokens` = output (includes reasoning, [FIX]+[INF]). [SRC] |
| Subagent link | Parent `tool/result.data.meta = {kind:'activation', name}` → parent `subagent/catalog.data.name` → `childId` → child file `<root>/<projectKey(child header cwd)>/<encodeSegment(childId)>/session.v4.jsonl.zstd`; child header cwd is copied from the parent header, so same project directory. [SRC] |
| `DSH_SESSION_ROOT` | Refuted. The string does not occur anywhere in the pinned tree. [SRC, full-archive scan] |

---

## 1. Paths

### 1.1 Session root

- Harness home = explicit config, else env `DSH_HOME`, else `join(os.homedir(), '.dsh')`.
  [SRC] `packages/util/home-paths/src/index.ts:12,18,70-72,135-137`.
- Session root = `dshHomePath('sessions')` = `<home>/sessions`.
  [SRC] `packages/util/home-paths/src/index.ts:161-163`; `packages/bundle/base/cordis.patch.yml:138-141`
  (`name: '@deepseek-ai/dsh-session-persistence-jsonl'` / `config: root: !!js dshHomePath('sessions')`).
- The plugin itself has **no default root**; `root` is a required config field, resolved once with
  `path.resolve`. [SRC] `jsonl/index.ts:361,1866-1870`. So a user can move the root only by
  `DSH_HOME` or by overriding that plugin's `root` in their own Cordis config.
- **No session-root env var exists.** I streamed the whole source archive at the pin and listed
  every `DSH_[A-Z0-9_]+` token in `*.ts, *.tsx, *.js, *.mjs, *.cjs, *.yml, *.yaml, *.md`:
  452 distinct names, `DSH_SESSION_ROOT` is not among them. The session-related names are
  `DSH_SESSION_ID`, `DSH_SESSION_ID_KEY`, `DSH_SESSION_JSONL`, `DSH_SESSION_OPTIONAL`,
  `DSH_PTY_SESSION_ID`, `DSH_LOGICAL_SESSION_ACCESS`, `DSH_SNAPSHOT_SESSIONS_ROOT`,
  `DSH_CONFORMANCE_PERSISTENCE_ROOT` (the last two are test-harness names by their spelling;
  I did not open their use sites). [SRC scan] / [INF] for "test-only".
- Windows default therefore `C:\Users\<user>\.dsh\sessions\` [INF from `os.homedir()`].
  Desktop development builds use `apps/desktop/.desktop-build/development/home` instead.
  [DOC] `apps/desktop/README.md:202`.

### 1.2 Directory naming

```
<root>/
  <projectKey(header.cwd)>/        or  _no-cwd/   when the header has no cwd
    <encodeSegment(header.id)>/    one directory per session
      session.v4.jsonl.zstd        current generation
      session.v3.jsonl.zstd …      older generations, kept forever
      session.jsonl.zstd           generation 0 (no ".v0")
      session.lock                 POSIX only
```

[SRC] `jsonl/format.ts:254-269` (`projectDir`, `sessionDir`).

`projectKey(cwd)` — exact algorithm, [SRC] `jsonl/format.ts:225-245`:

```ts
// iterate UTF-16 code units of cwd (cwd must be non-empty)
//   '/', '\\', ':'            -> one '-' per run of these characters
//   [A-Za-z0-9._-] except '~' -> literal
//   anything else (incl. '~', space, non-ASCII) -> '~' + 4 upper-case hex digits of the code unit
// slug = result with leading '-' removed, or 'root' if that leaves ''
// return `--${slug.slice(0, 251)}--`
```

Examples [INF, computed by hand from the code]: `D:\Projects\Foo` → `--D-Projects-Foo--`;
`/home/u/my proj` → `--home-u-my~0020proj--`; `/` → `--root--`.
The mapping is lossy (separator runs collapse, 251-unit cut), so two different cwds can share a
directory; the true cwd is only in the header. Note `slice(0,251)` can cut a `~XXXX` escape in
half — do not try to decode the directory name.

`encodeSegment(id)` — [SRC] `jsonl/format.ts:199-214`: same per-code-unit escape
(`[A-Za-z0-9._-]` literal, everything else incl. `~` → `~XXXX`), no separator rule, no length
cut; `.` → `~002E`, `..` → `~002E~002E`. Injective, so it can be decoded back to the id, but
the header `id` is the authority.

The official reader checks that a file sits where its header says
(`generationLogPath(root, header.cwd, header.id, version)`), and treats the same id in two
project directories as an error. [SRC] `jsonl/index.ts:1631-1646,1659-1686`.

### 1.3 File names by format version

[SRC] `packages/session/session-format/src/filename.ts:5-17,26-32` and `jsonl/format.ts:42-77`:

- regex for the raw name: `^session(?:\.v([1-9][0-9]*))?\.jsonl$`; version 0 is `session.jsonl`,
  version N≥1 is `session.vN.jsonl`. `.v0`, upper case, leading zeros are not canonical.
- compression suffix appended after that: `.zstd` (default) or nothing (`compression: 'none'`).
- So: v0 `session.jsonl.zstd`, v1 `session.v1.jsonl.zstd`, v2 `session.v2.jsonl.zstd`,
  v3 `session.v3.jsonl.zstd`, v4 (current, `SESSION_FORMAT_VERSION = 4`, `core/types.ts:90`)
  `session.v4.jsonl.zstd`. The README layout block that calls v3 "current" is stale.
  [DOC] `packages/session/session-persistence-jsonl/README.md:59-71`.
- A root uses one encoding. If a session directory contains a canonical name with the *other*
  suffix the official backend throws. [SRC] `jsonl/index.ts:1607-1617,1806-1812`.
- **Authoritative file = numerically highest canonical generation in the directory.**
  [SRC] `jsonl/index.ts:1591-1628`.
- Pre-release flat layout (`<project>/<id>.jsonl[.zstd]` directly in the project directory) is
  refused by the official reader. [SRC] `jsonl/index.ts:1741-1749,1764-1777,1814-1819`.

### 1.4 What else sits beside the log

- `session.lock` — POSIX `flock` target, created on first write-open, never removed. Windows
  uses a named kernel semaphore and creates **no file**. Readers never touch it.
  [SRC] `jsonl/lease.ts:1-40`.
- Transient temp files: `<final name>.<12 hex>.tmp` during first materialisation
  (`jsonl/index.ts:1417-1427`), and `session.migration.<token><suffix>.tmp` during a format
  migration (`jsonl/generation.ts:728`). Ignore everything that does not match the canonical
  name. [SRC]
- No index file, no archive marker, no attachments inside the session directory. [SRC: nothing
  in `jsonl/` writes any; DOC: `format.ts:259-262` says the directory is "available for future
  session-local artifacts".]
- Archive / pin state: plugin storage, `workspace` domain, one global state with
  `archivedSessionIds` and `pinnedSessionIds` (arrays of session id strings, no timestamps).
  Lives under `<home>/storages` (`cordis.patch.yml:185`), not next to the log.
  [DOC] `packages/workspace/workspace/README.md:119`. Storage file format not read.
- Attachments: `<home>/attachments/v1/objects/<sha256-prefix>/<sha256>` (images),
  `<home>/attachments/v1/file-objects/<prefix>/<digest>` plus hard links
  `<home>/attachments/v1/files/<prefix>/<digest>/<name>` (generic files). Never deleted.
  [DOC] `packages/attachment/attachment-local/README.md:55,84,92`. (The earlier note's path
  lacked the `v1` segment.)

---

## 2. Container encoding

### 2.1 How bytes are produced

[SRC] `jsonl/zstd.ts:15-23,111-113`, `jsonl/index.ts:1429-1450,1469-1497`:

```ts
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
compressZstdFrame(input) = zstdCompress(input, CHECKSUM_OPTIONS)      // node:zlib one-shot, default level

// first write of a session
header     = JSON.stringify(headerLine) + '\n'
body       = events.map(e => JSON.stringify(encode(e))).join('\n') + '\n'
file bytes = concat(compressZstdFrame(header), compressZstdFrame(body))   // or header frame alone

// every later append
open(path, 'a'); write(compressZstdFrame(body)); fsync
```

Consequences:

- The file is `frame, frame, frame…` and nothing else. Each frame starts with the standard magic
  `28 B5 2F FD` and ends with the 4-byte content checksum. No dictionary, no skippable frames, no
  outer length prefix, no file-level magic. [SRC]; `tests/zstd.compat.spec.ts:9-37` asserts the
  magic of each frame.
- Frame 1 decodes to exactly one line (the header) — enforced on read
  (`jsonl/index.ts:79-83`). [SRC]
- Every later frame decodes to one or more **complete** lines ending in `\n`. A complete frame
  that ends in the middle of a line is treated as corruption (`jsonl/index.ts:1056-1059`). [SRC]
- One frame per append call. Live events are buffered for at most 200 ms
  (`LIVE_WRITE_BATCH_MAX_DELAY_MS`, `jsonl/storage.ts:36-37,269-282`) and a flush drains the
  buffer at once, so a frame holds anything from 1 to many events. [SRC]
- With `compression: 'none'` the same lines are written raw, file name without `.zstd`. [SRC]
  `jsonl/index.ts:1437,1440,1449`.

### 2.2 Decoding with a standard decoder

- The frames are standard Zstandard frames; the product's own fallback decoder is
  `zstdDecompressSync(source.subarray(start, end))` per frame.
  [SRC] `jsonl/zstd-public-decoder.ts:20-29`. Node ≥ 22.15 has this API.
- The product never hands several frames to one Node call: the fallback slices per frame, and the
  optimised path feeds one frame at a time into a single stream handle and throws
  "left trailing input" if a call does not consume exactly one frame
  (`jsonl/zstd-private-decoder.ts`, class at 63-…, check at ~156). [SRC]
  So the source gives **no evidence** on whether `zlib.zstdDecompressSync(wholeFile)` or
  `createZstdDecompress()` piped with the whole file returns all frames or stops after the
  first. [INF] The zstd format itself allows concatenation and the `zstd` CLI decodes it.
- Recommended reader: port `scanZstdFrames` (`jsonl/zstd.ts:48-104`, pure byte walk, no
  decompression) and decompress each `[start,end)` slice. The walk is:
  magic (4 bytes LE `0xFD2FB528`) → frame-header descriptor byte (reject if bits `0x18` set) →
  skip `(singleSegment?0:1) + dictIdBytes + contentSizeBytes` → blocks: 3-byte LE header,
  `last = bit0`, `type = bits1-2` (3 = reserved → corrupt), `size = header>>>3`, payload is 1
  byte for RLE (`type 1`) else `size` → after the last block skip 4 bytes if the checksum flag
  (`descriptor & 0x04`) is set. [SRC]

### 2.3 Partially written last frame

- `scanZstdFrames` returns `tornStart` = offset where an incomplete final frame begins when EOF
  falls anywhere inside it (even inside the 4 magic bytes). A non-magic value at a frame start is
  corruption, not a torn tail. [SRC] `jsonl/zstd.ts:52-98`.
- A one-shot decompress of the torn slice fails. The product salvages it with
  `zstdDecompress(slice, { finishFlush: ZSTD_e_flush })` and keeps only complete lines from the
  output; a decoder error there is swallowed (zero lines recovered).
  [SRC] `jsonl/zstd.ts:21-23,154-156`, `jsonl/index.ts:1070-1092`.
- Readers never repair. The next **writer** truncates the file at `tornStart`, appends one new
  frame holding the recovered events, then appends its new batch.
  [SRC] `jsonl/storage.ts:325-339`, `jsonl/index.ts:967-971,1509-1519`.
- A failed append (write or fsync error) is rolled back by truncating to the pre-append size, and
  the same events are appended again later. [SRC] `jsonl/index.ts:1464-1507`.
- For an external tailing reader the simple rule is: **ignore the torn frame, wait**. If you do
  salvage lines from it, expect the same `seq` values to arrive again in a later complete frame.

### 2.4 Offset-based tailing

Possible, with these rules [INF, each derived from the SRC facts above]:

1. Store `N` = end offset of the last *complete* frame you decoded, plus the file identity
   (size, and a hash or length of frame 1).
2. On change: if `size > N`, scan frames from `N`; decode complete ones; stop at `tornStart`.
   Frames are independent (each is its own one-shot compression), so no decoder state carries
   over.
3. If `size < N`, or the first frame changed, discard and re-read from byte 0. `size < N` can
   happen after an append rollback (a structurally complete frame can be removed if its `fsync`
   failed) — rare. A changed first frame happens only with third-party tools that rewrite the
   header frame (the earlier note cites `@he0119/dsh-session-manager` doing this to change
   `cwd`; [3P], not re-verified).
4. Key events by `seq` and let a later copy replace an earlier one; that makes rules 2-3 safe.
5. Watch the directory, not only the file: a format migration publishes a new, higher
   `session.vN` file and the old one stops growing (§6).

---

## 3. The v4 row codec

The v4 codec delegates framing to the v2 codec unchanged (v3 and v4 only add validation).
[SRC] `packages/session/session-format-v3-to-v4/src/codec.ts:23-54`,
`packages/session/session-format-v2-to-v3/src/codec.ts:15-76`,
`packages/session/session-format-v1-to-v2/src/codec.ts:19-39,132-232`.

- Writer: `JSON.stringify(encodeCurrentEvent(event))`, one event per line.
  [SRC] `jsonl/format.ts:313-324`.
- A row is a JSON **object**. Required keys `type` (string), `seq`, `time` (safe integer),
  `data`. Optional keys `ignorable` (only ever `true`), `sourceEventSeqs`, `surfaceOp`. Any other
  top-level key makes the official decoder reject the row.
  [SRC] `v1-to-v2/src/codec.ts:21-23,132-147`.
- `encodeEvent` returns the logical event object itself, or a shallow copy with
  `sourceEventSeqs` re-encoded (`codec.ts:178-184`). Nothing else is transformed: `data` is
  stored exactly as the logical type. [SRC]
- Key order is whatever the in-memory object had; do not rely on it. [INF]

**The single stored-vs-logical difference — `sourceEventSeqs`:** [SRC] `codec.ts:186-232`

- Encode: if the list is not strictly increasing, it is stored verbatim. Otherwise each run of
  ≥3 consecutive integers `a, a+1, …, b` becomes the pair `[a, b]`; runs of 1 or 2 stay as plain
  numbers. Example: `[3,4,5,6,9,10,12]` → `[[3,6],9,10,12]`.
- Decode: a number is itself; a 2-element array `[start,end]` expands inclusively. Every
  expanded value must be `< seq` of the row and unique; if any pair was present the expanded
  list must be strictly increasing.
- A verbatim non-increasing list is real: the compaction checkpoint in
  `snapshots/sdk/manual-compact/session.v4.jsonl` line 25 has
  `"sourceEventSeqs":[20,22,8,9,10,11]`. [FIX]
- `surfaceOp.startSeq/endSeq`, `shadowedRange`, `shadowedSeqs`, `messageSeqs`, `headerSeq` are
  **not** range-encoded; they are plain numbers / arrays as typed. [SRC: only the top-level
  `sourceEventSeqs` key is touched.]

The header line also goes through a codec, but it is a plain object too (§4.1).

---

## 4. Header and events

All JSON examples are **constructed from the type definitions, not a real file**. Where a
repository fixture shows the same shape I say so; fixtures have no `seq`/`time`, I added them.

### 4.1 Header line (line 1, alone in frame 1)

[SRC] `jsonl/format.ts:83-98,159-186`; encoder `v1-to-v2/src/codec.ts:155-176` with
`version` overwritten to 4 (`v3-to-v4/src/codec.ts:42-45`).

| Key | Type | Notes |
|---|---|---|
| `type` | `"session"` | required |
| `version` | number | required; equals the `N` of the file name |
| `id` | string | required; session id |
| `createdAt` | integer ≥ 0 | required; epoch ms |
| `cwd` | string | optional; must be an absolute path |
| `parentSession` | string | optional; direct creator of a subagent child |
| `isSeeded` | boolean | required; true = file starts with a fork-inherited prefix |
| `origin` | `"subagent"` | optional |
| `delegationDepth` | integer ≥ 0 | required on disk (0 for top level) |
| `agentPreset` | string | optional |

Unknown keys → official reader rejects (`format.ts:163`). A `version` other than 4 in a file the
reader selected is refused before anything else is checked (`format.ts:340-346`).
There is no title, model or token total in the header.

```json
{"type":"session","version":4,"id":"<session id>","createdAt":1789626545611,"cwd":"D:\\Projects\\Foo","isSeeded":false,"delegationDepth":0}
```

(Same key set as fixture `snapshots/sdk/subagent-spawn-in-process/session.v4.jsonl` line 1. [FIX])
Session id syntax is not fixed by the format ("an unvalidated branded string",
`format.ts:3-4`); fixtures tokenise it. Open question.

### 4.2 Envelope

[SRC] `core/types.ts:506-529`: `{ type, seq, time, data, ignorable?, surfaceOp?, sourceEventSeqs? }`.
`time` is epoch ms. `surfaceOp`/`sourceEventSeqs` exist only on the five surface types
`system/message`, `developer/message`, `user/message`, `assistant/message`, `tool/result`
(`core/types.ts:447-452`); `assistant/message` never has `sourceEventSeqs` (`types.ts:478-486`).
`surfaceOp` is `"append"` or `{ "op":"replace", "startSeq":n, "endSeq":n }` (`types.ts:470-472`).

### 4.3 Turn / step brackets

[SRC] `core/types.ts:294-307,206-235`

```json
{"type":"turn/start","seq":4,"time":1789626545700,"data":{"turn":1}}
{"type":"step/start","seq":6,"time":1789626545701,"data":{"turn":1,"step":1}}
{"type":"step/end","seq":19,"time":1789626549000,"data":{"turn":1,"step":1}}
{"type":"turn/end","seq":25,"time":1789626551000,"data":{"turn":1,"reason":{"kind":"completed"}}}
```

`reason.kind`: `completed`, `blocked`, `max-tokens`, `interrupted` (synthetic, after a crash),
`forked` (synthetic, in a fork seed), `aborted` with
`reason: {kind:'user'|'parent'|'disposed'|'legacy'} | {kind:'hook', reason:string}`, `error` with
`error: {message, code, status?, providerRetryAfterMs?, requestId?, offloadImages?}`
(`llm/types.ts:48-66`).

### 4.4 User message

`data` **is** the message (no `turn`/`step` wrapper). [SRC] `core/types.ts:315`,
`llm/message.ts:138-163`.

```json
{"type":"user/message","seq":8,"time":1789626545702,
 "data":{"id":"<message uuid>","role":"user",
         "content":[{"type":"text","text":"Fix the failing test"}],
         "source":{"kind":"user"}},
 "surfaceOp":"append"}
```

(Shape matches fixture line 10 of `subagent-spawn-in-process/session.v4.jsonl`. [FIX])

**Human-typed vs injected: `data.source.kind`.**

- `"user"` = a human prompt. Two shapes are catalogued: `{kind:"user", rpcId:string}` and bare
  `{kind:"user"}` (also the type of a command's source). `rpcId` is therefore optional for a
  reader. [SRC] `catalog.md:4368-4369`; `llm/message.ts:110`.
- `"retry"` (`rpcId` required) — a user-initiated retry; treat as human-originated or as a
  separate category, your choice. [SRC] `catalog.md` MessageSource table (row `retry`). [INF]
  for the meaning; I did not read its producer.
- Everything else is injected context. Complete list of kinds declared in this repository at the
  pin [SRC] `catalog.md:4252-4380` (table generated from every `MessageSourceMap` merge):
  `action-cards`, `agent-instructions`, `agent-message`, `compact-checkpoint`,
  `cordis-host-runner`, `dsh-session-title-llm`, `goal`, `hooks-claude-code`, `hooks-codex`,
  `model-selection`, `plan-mode`, `ptc-mode`, `repeat-tool-reminder`, `runtime-context`,
  `schedule`, `session-reference`, `skill-catalog`, `skill-invocation`, `subagent-settled`,
  `team-message`, `time-context`, `timeline-priority`, `tmux-context`, `tool-goal`, `tool-jobs`,
  `tool-registry`, `user-approval`, `user-question-reply`, `webhook`, `working-directory`.
  Role-bound kinds: `model` (assistant), `tool` (tool result), `system-prompt` (system).
- Files migrated from v3 can also carry `compact-basic`, `coordinator`, `subagent-report`,
  `tool-cordis` and any `plugin:<name>`. [DOC] `packages/session/session-format-v3-to-v4/README.md:122-134`.
  Third-party plugins add their own kinds. Rule for a reader: `kind === 'user'` → prompt node;
  unknown kind → treat as injected. [INF]
- Optional presentation hint on injected sources: `form` ∈ `instructions | catalog | snapshot |
  notice | relay | recall`; `notice` carries a one-line `summary` (≤120 chars), `snapshot`
  carries `sections: {name,text}[]`. [SRC] `llm/message.ts:54-100,121-132`.

**Trap:** the same message object (same `id`) also appears earlier inside
`agent/inbox/spliced.data.inserted[]` while it waits in the queue. That event is log-only; do not
render it as a prompt or you will show every prompt twice. [FIX] fixture lines 5 and 10;
[SRC] event listed at `catalog.md:172`.

Content blocks [SRC] `llm/types.ts:68-152`:
`{type:"text",text}`, `{type:"reasoning",text}`,
`{type:"image",attachment:{attachmentId,mediaType,width,height,bytes,name?,originalDimensions?},offloaded?:true}`,
`{type:"file",attachment:{attachmentId,name,bytes}}`,
`{type:"tool-call",id,name,arguments}`, `{type:"tool-addition",toolName}`,
`{type:"tool-removal",toolName}`. `attachmentId` looks like `sha256:<64 hex>` [FIX
`snapshots/sdk/inline-image-prompt/session.v4.jsonl`]. The union is open; unknown block types
must be tolerated.

### 4.5 Assistant message

[SRC] `core/types.ts:349-357`, `llm/message.ts:8-25,166-169`, `llm/types.ts:182-196`,
`llm/assistant-stream.ts:19-43`.

```json
{"type":"assistant/message","seq":14,"time":1789626547000,
 "data":{"turn":1,"step":1,
   "message":{"id":"<message uuid>","role":"assistant",
     "content":[
       {"type":"reasoning","text":"I should run the tests first."},
       {"type":"text","text":"Running the tests."},
       {"type":"tool-call","id":"call_00_abc","name":"bash","arguments":"{\"command\": \"npm test\"}"}],
     "source":{"kind":"model","provider":"deepseek-official","model":"deepseek-v4-flash"}},
   "usage":{"inputTokens":135,"outputTokens":124,"cacheReadTokens":1664,"reasoningTokens":55},
   "stream":[
     {"type":"chunk","time":1789626546000,"chunk":{"type":"block-start","index":0,"blockType":"reasoning"}},
     {"type":"reasoning-chunks","time0":1789626546000,"index":0,"dt":[12,9],"texts":["I should"," run the"," tests first."]}]},
 "surfaceOp":"append"}
```

(Field set matches fixture line 16 of `subagent-spawn-in-process/session.v4.jsonl`; the usage
object is copied from it. [FIX])

- Text / thinking / tool calls: `data.message.content[]` blocks, in model order.
  `tool-call.arguments` is the raw JSON **string** from the model, possibly invalid JSON.
- Model identifier: `data.message.source.provider` + `.model` per message. Session-level
  alternatives: `request/header.data.header.config.{provider,model,reasoningEffort?}`,
  `request/context.data.{provider,model,contextWindow?}`,
  `model/selection.data.{provider,model,reasoningEffort?}` (`catalog.md:689-776,4414`).
  `source.replayState` is opaque adapter data; ignore.
- `data.interrupted: true` marks a partial message kept after a cancel (`types.ts:344-347`).
- `data.stream` is the raw timed delta stream, embedded for replay. It duplicates the content
  and is usually the bulk of the line. Record types: `text-chunks` / `reasoning-chunks`
  `{time0,index,dt[],texts[]}`, `tool-call-chunks` `{time0,index,dt[],id,name?,args[]}`, `chunk`
  `{time,chunk}`. Skip it for display; it is only useful for per-token timing.
- `assistant/attempt` `{turn,step,stream}` is a failed/retried attempt with no message
  (`types.ts:363`). Log-only; show nothing or an "attempt failed" marker.

**Usage** — `data.usage`, optional. [SRC] `llm/types.ts:174-196`:

```ts
/** Counts are DISJOINT: `inputTokens` is uncached input only; cached input is reported
 *  separately as `cacheReadTokens`/`cacheWriteTokens` (billed input = sum of the three). */
interface TokenUsage { inputTokens: number; outputTokens: number; totalTokens?: number;
                       cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }
```

Mapping to `{input, cachedInput, output}`:

| Target | Source | Mark |
|---|---|---|
| `cachedInput` | `cacheReadTokens ?? 0` | [SRC] |
| `input` | `inputTokens` if your `input` means "not cached"; `inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)` if your `input` means "total prompt, cached included" (the OpenAI/Codex convention) | [SRC] for the disjointness; choose per your graph's convention |
| `output` | `outputTokens` — do **not** add `reasoningTokens` | [FIX]+[INF]: fixture has `outputTokens:32, reasoningTokens:26` for a 4-word visible reply, so reasoning is inside `outputTokens`. The type comment does not state this. |

There is no separate usage event. `compaction/summary.data.usage` is a second place usage
appears (the summarising call). Title generation and web-search helper calls log requests
(`session/title-llm-request`, `web/deepseek-search-llm-request`) — I did not check whether those
carry usage.

### 4.6 Tool call and tool result

[SRC] `core/types.ts:369,383-393`, `llm/message.ts:27-31,172-179`.

```json
{"type":"tool/call","seq":15,"time":1789626547001,
 "data":{"turn":1,"step":1,"callId":"call_00_abc","name":"bash","arguments":"{\"command\": \"npm test\"}"}}
{"type":"tool/result","seq":18,"time":1789626548500,
 "data":{"turn":1,"step":1,
   "message":{"id":"<message uuid>","role":"tool","toolCallId":"call_00_abc",
     "source":{"kind":"tool","callId":"call_00_abc"},
     "content":[{"type":"text","text":"1 failed\n"}],"isError":false},
   "meta":{"cwd":"D:\\Projects\\Foo"}},
 "sourceEventSeqs":[15],"surfaceOp":"append"}
```

(Shapes match `snapshots/sdk/bash-tool/session.v4.jsonl` lines 17 and 20. [FIX])

- Pairing key: `tool/call.data.callId` === `tool/result.data.message.toolCallId` ===
  `…message.source.callId` === the `tool-call` block's `id` in the assistant message. The id is
  provider-issued and unique within a step; uniqueness across a whole session is not promised —
  pair within `(turn, step)` or by nearest preceding call. [SRC] types; [DOC]
  `session-format-v3-to-v4/README.md:239` ("advertised call ids are unique" per open step).
- In fixtures `tool/result.sourceEventSeqs` holds the `seq` of its `tool/call` — a second,
  exact pairing key. [FIX]; not stated as a rule in the types. [INF]
- Error flag: `data.message.isError` (boolean, optional). `data.error = {name, code, reason?}`
  is extra, user-facing, and only allowed when `isError` is true. Synthetic errors after a
  crash/fork use codes `TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN`.
  [SRC] `types.ts:387-391`; [DOC] jsonl README:147, v3-to-v4 README:267-269.
- Output: `data.message.content` is a `ContentBlock[]` (usually text blocks, can contain
  images). `data.meta` is tool-private JSON for the UI card (bash: `{cwd}`, fs tools: a diff,
  subagent: see §4.10). [SRC] `types.ts:371-382`.
- A `tool/result` can be a `surfaceOp: replace` of an earlier result (pruning/offload); then it
  is a new version of an old result, not a new tool run. [DOC] v3-to-v4 README:239.
- `tool/ptc-dispatch-start` / `tool/ptc-dispatch` are tool calls made from inside "code mode"
  (programmatic tool calling); they carry their own `meta`. Shapes at `catalog.md:1111-1158`,
  not expanded here.

### 4.7 Session title

[SRC] `packages/session/session-title/src/types.ts:28-48`; event at `catalog.md:856-870`.

```json
{"type":"session/title","seq":13,"time":1789626545900,
 "data":{"title":"Fix the failing test","messageSeqs":[8],"source":{"kind":"fallback"}}}
```

Latest event wins. `source.kind`: `fallback` (first words of the prompt), `provider`
(`provider`, optional `model:{provider,model}`), `user` (manual rename; `messageSeqs` empty).
`messageSeqs` = seqs of the human `user/message` events the title was derived from. A session
can have no title event at all (no prompt yet).

### 4.8 Working directory change

[SRC] `catalog.md:1322-1330` (declared at `packages/session/working-directory/src/index.ts:55`).

```json
{"type":"working-directory/change","seq":40,"time":1789626600000,"data":{"cwd":"D:\\Projects\\Foo\\packages\\api"}}
```

The header `cwd` never changes ("the immutable Session header retains the original project");
the latest `working-directory/change` is the effective directory. Bash results also carry
`meta.cwd` [FIX].

### 4.9 Compaction

[SRC] `catalog.md:372-476` (declared in `packages/compaction/compaction/src/types.ts:24-82`).
Order on disk, all appended, nothing rewritten:

```json
{"type":"compaction/start","seq":22,"time":1,"data":{"compactionId":"<id>","turn":null}}
{"type":"compaction/summary","seq":24,"time":2,"data":{"compactionId":"<id>","summary":[{"type":"text","text":"## Primary Request…"}],"rawOutput":[{"type":"text","text":"…"}],"llmStreamCall":true,"shadowedRange":{"start":8,"end":11},"shadowedSeqs":[8,9,10,11],"shadowedTokenCount":4115,"provider":"deepseek-official","model":"deepseek-v4-flash","usage":{"inputTokens":10,"outputTokens":2}}}
{"type":"user/message","seq":25,"time":3,"data":{"id":"<uuid>","role":"user","content":[{"type":"text","text":"This is an automatically generated checkpoint…"}],"source":{"kind":"compact-checkpoint","compactionId":"<id>"}},"sourceEventSeqs":[20,22,8,9,10,11],"surfaceOp":{"op":"replace","startSeq":8,"endSeq":11}}
{"type":"compaction/end","seq":26,"time":4,"data":{"compactionId":"<id>","turn":null}}
```

(Sequence and fields match `snapshots/sdk/manual-compact/session.v4.jsonl` lines 22-26; other
events may sit in between, e.g. line 23 there is `session-log-deepseek/delivery-accepted`. [FIX])

- `turn` is a number when compaction ran inside a turn, `null` for a manual `/compact` between
  turns. Optional `sourceCommandId` on all three and on the checkpoint source.
  `compaction/end.data.error` (string) = failed attempt.
- The replacing `user/message` immediately follows `compaction/summary` (contractual).
- `compaction/prune` `{shadowedRange, shadowedSeqs, shadowedTokenCount}` is the model-free
  variant, followed immediately by its own replace event.
- For a visualiser: the events with seq in `shadowedSeqs` are still in the file and still
  displayable; the replace only tells you what the *model* stopped seeing. Draw the checkpoint
  as a system node.
- Manual commands appear as `command/run {commandId,name,args,source}` /
  `command/done {commandId,kind,text,sourceEventSeq}` [FIX lines 21, 27].

### 4.10 Subagents

Parent side — `subagent/catalog`, log-only. [SRC] `packages/subagent/subagent/src/catalog.ts:22-44,149-181`.

```json
{"type":"subagent/catalog","seq":16,"time":1789626547100,
 "data":{"version":3,"childId":"<child session id>","childCreatedAt":1789626547090,"mode":"continuable","label":"echo probe","name":"agent-1"}}
```

| version | fields beyond `childId`, `childCreatedAt` |
|---|---|
| 0 | `mode: 'one-shot'` (+`label?`) or `'continuable'` (+`label`) |
| 1 | as 0, plus `mode: 'unknown'` (+`label?`) |
| 2 | `mode: 'external'`, `label?` |
| 3 (written now) | `name` + (`mode:'continuable'`,`label`) or (`mode:'external'`,`label?`) |

- `mode: 'external'` (Codex / Claude Code / ACP / DSH-SDK backends) has **no local session
  file**; `childId` is whatever the external provider returned and `childCreatedAt` is the
  parent's clock. [SRC] `catalog.ts:172-181`.
- `name`: unique among that parent's children; default `agent-1`, `agent-2`, …; rule
  `[a-z][a-z0-9-]{0,31}`, not `lead`. [DOC] `packages/subagent/subagent/README.md:68`.
- Catalog entries inherited through a fork prefix are not this session's children: the official
  projection ignores `subagent/catalog` with `seq < inheritedEventCount`. [SRC] `catalog.ts:134-137`.

**Parent tool call → child session id.** The spawning tool (default name `subagent`,
configurable; a second instance is typically `subagent_fork`) returns immediately:

```json
{"type":"tool/result","seq":18,"time":1789626547200,
 "data":{"turn":1,"step":1,
   "message":{"id":"<uuid>","role":"tool","toolCallId":"call_00_x","source":{"kind":"tool","callId":"call_00_x"},
     "content":[{"type":"text","text":"started subagent agent-1"}],"isError":false},
   "meta":{"kind":"activation","name":"agent-1"}},
 "sourceEventSeqs":[15],"surfaceOp":"append"}
```

- `meta = {kind:'activation', name}` comes from the tool's `presentationMeta`; text is
  `started subagent <name>`. [SRC] `packages/subagent/tool-subagent/src/index.ts:262-273,330-338`.
- `name` there is the child's **full name from the root** (`reviewer/checker` for a grandchild),
  while `subagent/catalog.data.name` is the sibling-unique last segment.
  [DOC] `tool-subagent/README.md:60`, `subagent/README.md:70`.
- Join: `tool/result.data.meta.kind === 'activation'` → take the last `/` segment of
  `meta.name` → the `subagent/catalog` event **in the same file** with that `name` →
  `childId`. In the fixture the catalog row sits between the `tool/call` and its `tool/result`
  (lines 17-20), so "the catalog event(s) between call and result" is a second way to join when
  `name` is missing (catalog v0-v2). [FIX] for the ordering; [INF] that it always holds
  (parallel subagent calls in one step can interleave — then use `name`).
- There is no `callId` on the catalog event and no `childId` on the tool result. [SRC]
- Calls made from code mode keep the same meta on `tool/ptc-dispatch.data.meta` instead.
  [DOC] `tool-subagent/README.md:60`.

**Where the child file lives.** The child is an ordinary session:
`<root>/<projectKey(childHeader.cwd)>/<encodeSegment(childId)>/session.v4.jsonl.zstd`.
The child header is built as `{cwd: parentHeader.cwd, parentSession: parentHeader.id,
isSeeded, origin:'subagent', delegationDepth: parent+1, agentPreset?}`
([SRC] `packages/subagent/subagent/src/child-agent.ts:135-154`), so the child sits in the **same
project directory as the parent** even when the tool call passed a different `cwd` (that only
produces a `working-directory/change` in the child). To find a child by id without assuming
this, scan all project directories for `encodeSegment(childId)` (the official `findLog` does
exactly that, `jsonl/index.ts:1631-1646`).

Child side:

```json
{"type":"session","version":4,"id":"<child id>","createdAt":1789626547090,"cwd":"D:\\Projects\\Foo","parentSession":"<parent id>","isSeeded":false,"origin":"subagent","delegationDepth":1}
{"type":"subagent/descriptor","seq":0,"time":1789626547095,"data":{"version":3,"mode":"continuable","provider":"spawn","label":"echo probe","agentProvider":"deepseek-official","agentModel":"deepseek-v4-flash"}}
```

([FIX] `subagent-spawn-in-process/session.1.v4.jsonl` lines 1-2.)
`subagent/descriptor` [SRC] `packages/subagent/subagent/src/descriptor.ts:48-91`:
`{version, mode:'one-shot'|'continuable', provider, label?, agentProvider?, agentModel?,
agentReasoningEffort?, persona?, toolFilter?:{allow?,deny?}}`. `provider` is the backend name
(`spawn`, `fork`, …), not an LLM provider.

- Use header `origin === 'subagent'` to classify a file as a subagent; `parentSession` alone is
  not enough (old ordinary forks may carry it). [SRC] `core/types.ts:107-122`.
- A `fork` backend child has `isSeeded: true` **and** `parentSession`/`origin` — its file starts
  with a copy of the parent's history up to the cut (§5). [FIX]
  `snapshots/sdk/subagent-fork-in-process/session.1.v4.jsonl` lines 1, 19-20.
- The child's first `user/message` (`source.kind:'user'`) is the delegated prompt written by the
  parent model, not by a human. [FIX] child fixture line 10. For display, a `user`-kind message
  in a file whose header has `origin:'subagent'` is "task from parent".
- Result delivery to the parent: a later `user/message` with
  `source = {kind:'subagent-settled', form:'notice', summary, senderSessionId:<childId>,
  stopReason?}` — `senderSessionId` is a third, direct link to the child id.
  [SRC] `catalog.md` `SubagentSettledMessageSource` (declared at
  `packages/subagent/subagent/src/continuation-messages.ts:29`); [FIX] parent fixture line 25.
  Messages between agents use `source = {kind:'agent-message', form:'relay', senderSessionId}`.
- Other subagent events: `subagent/model-selection-policy {allowedModels[]}`;
  Agent Teams `team/*`; workflows `tool-workflow/*` (`catalog.md:962,1005-1247`).

### 4.11 Fork / seed markers

[SRC] `core/types.ts:411-435`; [DOC] `docs/subsystems/session.md:711-713,770-772`.

```json
{"type":"session/end-seed","seq":18,"time":1783352137161,"data":{"inherited":true}}
{"type":"session/end-seed","seq":40,"time":1783352999000,"data":{}}
```

- Header `isSeeded: true` ⇔ the file contains at least one `session/end-seed` with
  `data.inherited === true`. The **last** such event is the cut: every event with a smaller
  `seq` is inherited (deep-copied from the source session), its own `seq` is the inherited
  count. The official decoder refuses a file where header and marker disagree.
  [SRC] `v1-to-v2/src/codec.ts:114-127`.
- After the cut a fork may contain synthetic closers written for the child: `tool/result` with
  `TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` (ids like `forked-tool-result-<callId>-<seq>`),
  `step/end`, `turn/end {reason:{kind:'forked'}}`. [DOC] v3-to-v4 README:267-269.
- An untagged `session/end-seed {}` is only a restart boundary ("everything before this was
  loaded from disk by a new process"); it says nothing about forks. It is appended on resume
  when the stored log does not already end in a marker.
- An ordinary user fork: `isSeeded:true`, **no** `parentSession`, same `cwd` as the source.
  The file does not name the session it was forked from. [DOC] session.md:711.

### 4.12 Other events worth a node, and `ignorable`

- `system/message {turn, step, message:{id, role:'system', content, source:{kind:'system-prompt'}}}`
  — the rendered system prompt; can be re-issued with `surfaceOp: replace`.
- `developer/message {turn, step, message, headerSeq?}` — tool additions/removals.
- `request/header`, `request/context` — model config and tool schemas per request (large).
- `llm/retry`, `llm/retry-started`, `approval/asked|decided|policy`, `plan/mode`,
  `permission/preset`, `sandbox/mode`, `todo/write`, `goal/change`, `job/registered|settled`,
  `hook/invoked|result`, `image/offload`, `workspace/changes`, `deliverables/presented`,
  `feedback/*`, `schedule/change`, `agent-preset/selected`,
  `session-log-deepseek/delivery-accepted` — log-only state; full shapes in `catalog.md:166-1350`.
- `ignorable`: optional envelope key, only value `true`. It means "a reader that does not know
  this `type` may skip the row"; absent means required, and the official reader refuses the
  whole session on an unknown required type. [SRC] `core/types.ts:514-524`.
  It is a per-event flag set by the writer, not a fixed list of types; none of the nine v4
  fixtures I fetched contains it. [FIX] An external **visualiser** should skip every unknown
  type, ignorable or not, and perhaps count them. [INF]
- Experimental plugins write types named `plugin:<…>` (`core/types.ts:531-562`).

---

## 5. Ordering and identity

- `seq` is assigned 0,1,2,… in file order and the official decoder requires row *k* to have
  `seq === k` (gap or repeat → error, or "recoverable tail" handling).
  [SRC] `v1-to-v2/src/codec.ts:104-113`; writer-side `assertContiguous`
  (`packages/session/session-persistence/src/storage-contract.ts:145-151`).
  So within one committed file `seq` is unique, strictly increasing by 1, and equals the
  zero-based event line index (header excluded).
- Out-of-order appends: not possible through the official writer (single writer per session via
  kernel lock + contiguity check). [SRC] `jsonl/lease.ts`, `jsonl/storage.ts:320-341`.
- Duplicates within a file: only transiently for a reader that salvages a torn tail (§2.3).
- Across files: a fork's inherited prefix is a deep copy **with the same `seq` values and the
  same message `id`s and `callId`s** as the source file. So `message.id` and `callId` are *not*
  globally unique; `(session id, seq)` is. [DOC] session.md:711 ("deep-cloned seed events");
  [FIX] fork fixture.
- De-duplication key for a line: `(header.id, seq)`. For "is this the same message as in the
  parent/fork source": `data.message.id` (or `data.id` for `user/message`).
- `time` is not guaranteed monotonic (it is wall-clock at append; inherited events keep their
  original times). Order by `seq`. [INF]
- After a migration the *new generation* has different `seq` numbering than the old file
  (events are inserted/merged and references remapped — [DOC] v1-to-v2 README:12, v2-to-v3
  README:56). Never mix seqs from two generations of one session.

---

## 6. Older formats

Several generation files can sit side by side in one session directory. **Only the highest `N`
is authoritative**; lower ones are frozen leftovers and are never updated or deleted. A v4 file
appears beside an old one the first time a v4 build opens that session *for writing*; read-only
opens migrate in memory and write nothing. [SRC] `jsonl/index.ts:1591-1628`; [DOC] jsonl
README:87. A machine can therefore still have sessions whose highest file is v0-v3.

**Unversioned flat layout (pre-release).** `<project dir>/<encoded id>.jsonl[.zstd]`, no
per-session directory. The current build refuses to load it. [SRC] `jsonl/index.ts:1741-1749,1814-1819`.
Contents not studied.

**v0 (`session.jsonl.zstd`) and v1 (`session.v1.jsonl.zstd`).** Same physical layout, only the
header `version` differs. Header has optional numeric `seedLength` instead of `isSeeded`
(`isSeeded = seedLength !== undefined`, cut = `seedLength`). Rows are either ordinary
`{type,seq,time,data,…}` objects or **packed assistant-delta rows**
`{type:'text-chunks'|'reasoning-chunks'|'tool-call-chunks', seq0, time0, data:{turn, step, index, dt[], texts[] | (id, name?, args[])}}`
— one row standing for `texts.length` consecutive `assistant/chunk` events with seqs
`seq0…seq0+n-1`. So in v0/v1, line index ≠ seq. `sourceEventSeqs` pairs already exist.
[SRC] `packages/session/session-format-v0-to-v1/src/codec.ts:21-23,142-187,203-295`.
v0 logs with `request/header-delta` are rejected outright. [DOC] session.md:208.

**v2 (`session.v2.jsonl.zstd`).** The row framing used ever since: one event per row, header
with `isSeeded`, cut from the tagged `session/end-seed`. `assistant/chunk` events are gone; the
stream is embedded in `assistant/message.data.stream`, and `assistant/attempt` appears.
The system prompt is still a string at `request/header.data.header.system` (no `system/message`
events). Preset id `code` (later `ptc`). [SRC] `v1-to-v2/src/codec.ts`; [DOC]
`session-format-v1-to-v2/README.md:12`, `session-format-v2-to-v3/README.md:56-70`.

**v3 (`session.v3.jsonl.zstd`).** Same framing as v2 plus `system/message` events. Differences
from v4 that matter for display: (a) a tool result is
`tool/result.data.message = {id, role:'user', source:{kind:'tool',callId}, content:[{type:'tool-result', toolCallId, content:[…], isError?}]}`
— unwrap the single `tool-result` block; (b) injected message sources are
`{kind:'plugin', plugin:'<name>', …}` instead of a direct kind (`compact` → `compact-checkpoint`,
`tools-ptc`/`tools-code-mode` → `ptc-mode`, `@deepseek-ai/dsh-system-prompt` → `system-prompt`
or `runtime-context`, most others keep their name); (c) parent `subagent/catalog` rows may be
missing (the migration adds them from child headers). [DOC]
`session-format-v3-to-v4/README.md:85-93,110-134`; fixtures `session.v3.jsonl` exist next to the
v4 ones for comparison.

Suggested policy for the tool [INF]: support v4 fully; support v3 with the two unwraps above;
for v0-v2 show header-level metadata and a "format too old, open it once in dsh" notice.

---

## 7. Write behaviour

- **Lazy creation.** `create()` writes nothing. The first append writes header frame + first
  batch to a temp file, fsyncs, and publishes it with `link()` (POSIX) or a no-replace rename
  (Windows). An empty session leaves no trace on disk unless explicitly flushed (then: a file
  with only the header frame). [SRC] `jsonl/index.ts:1320-1444`.
- **Append-only.** Later batches: open `'a'`, write one frame, fsync. Committed bytes are never
  rewritten by the official writer, with exactly two exceptions, both at the tail: truncation of
  a torn frame before the first new append, and rollback of a failed append. [SRC] §2.3.
- **Batching.** Live events wait at most 200 ms; the checkpoint policy forces a durable flush
  before each model request, before a top-level tool body runs, and before the next step.
  [SRC] `jsonl/storage.ts:36-37`; [DOC] `packages/session/session-checkpoint-policy/README.md:12`.
- **When an assistant reply reaches disk.** Once, as a complete `assistant/message`, after the
  model call for that step settles. Streaming deltas are never appended ("unfinished Assistant
  streams remain transient"). A tailing reader sees: user message + `request/header` (flushed
  before the request) … silence … `assistant/message`, then `tool/call` (flushed before the tool
  runs) … `tool/result`. A cancelled stream yields `assistant/message` with `interrupted:true`
  or nothing. [SRC] `core/types.ts:340-363`; [DOC] checkpoint README:12.
- **Crash.** File ends with an open `turn/start`; the next write-open appends synthetic closers
  (`tool/result` errors, `step/end`, `turn/end {reason:{kind:'interrupted'}}`). Read-only tools
  see the open turn as is. [DOC] `docs/subsystems/persistence.md:108-114`, jsonl README:77,147.
- **Compaction.** Appends only (§4.9). No file is rewritten or replaced.
- **Rewind / edit.** No rewind operation exists in the persistence layer; there is no API that
  removes or rewrites events. Branching from an earlier point is a fork. [SRC: `jsonl/` has no
  such code path]; whether the UI's "edit message" maps to a fork was not checked.
- **Fork.** Creates a new session directory with a new id; the source file is untouched. The
  new file = deep copy of the source prefix + `session/end-seed {inherited:true}` + synthetic
  closers + new work. [DOC] session.md:711-713.
- **Delete.** "Nothing deletes session files … the seam has no deletion API."
  [DOC] jsonl README:167. I did not check whether the app's UI deletes directories itself.
- **Archive.** Sets a flag in plugin storage (§1.4) and stops running work; the session file is
  not moved, renamed or marked. [DOC] `packages/workspace/workspace/README.md:101-119`.
  An external reader cannot tell archived from active without reading `<home>/storages`.
- **Migration.** Write-open of an old generation writes `session.migration.<token>….tmp`,
  verifies it, and links it as `session.v4…` without overwrite; the old file stays
  byte-identical. [SRC] `jsonl/generation.ts:728-834`; [DOC] jsonl README:87.
- **Upload.** By default the log is also sent incrementally to DeepSeek with official-API
  requests; each acceptance is recorded as `session-log-deepseek/delivery-accepted
  {sessionId, sessionFormatVersion, throughSeq}` in the log itself. [FIX] manual-compact line 23.

---

## 8. Things an external reader must be careful about

1. **Read-only, no lock.** Never take `session.lock`; never write, truncate or "repair". The
   lock is advisory on POSIX and absent on Windows, so a reader cannot block a writer anyway —
   but on Windows open the file with shared read/write/delete access (Node's `fs` default does
   this) so the writer's truncate/append is not blocked. [SRC] lease.ts; [INF] for Windows sharing.
2. **Torn tail is normal** while a session is live (§2.3). Decode complete frames only.
3. **File can shrink** (§2.4 rule 3). Detect and rescan.
4. **Checksums.** Each frame carries a content checksum; a checksum/decompress failure in a
   *complete* frame is corruption for the official reader (whole session refused). An external
   reader may keep the frames before it. [SRC] `jsonl/index.ts:1016-1100`.
5. **Line size.** `assistant/message` rows embed the full timed stream; `request/header` rows
   embed every tool schema; `tool/result` rows embed whole outputs and `meta` diffs. Single
   lines of hundreds of KB to MBs are plausible; frames are decoded into one buffer
   (the official decoder caps a frame's output at Node's `buffer.constants.MAX_LENGTH`). [SRC]
   `zstd-private-decoder.ts`; sizes are [INF].
6. **Large tool output is cut before it is logged.** With the spill policy, the `tool/result`
   content holds head/tail text plus a notice like
   `(Omitted N bytes. Full formatted result stored at: /…/session-…/…-web_fetch.txt. …)`;
   the full text is in a spill file under a private temp directory (default) that is swept by
   age. The path in the log may be dead. [DOC] `packages/spill/spill-policy/README.md:12,54`,
   `packages/spill/spill-local/README.md:12,43,59`. [INF] that the logged content is the
   reduced one.
7. **Images and files are references**, not bytes: `attachment.attachmentId = "sha256:<hex>"`
   → `<home>/attachments/v1/objects/<prefix>/<hex>` (§1.4). `<prefix>` length not read.
   `image` blocks with `offloaded:true` were replaced by placeholder text for the model.
8. **Same message twice.** `agent/inbox/spliced.data.inserted[]` duplicates queued user and
   subagent-settled messages before their `user/message` event (§4.4).
9. **Fork prefixes duplicate whole histories** across files (§5) — including inherited
   `subagent/catalog` rows that do not belong to the fork (§4.10).
10. **Arguments are raw strings.** `tool/call.data.arguments` and `tool-call.arguments` may be
    invalid or truncated JSON.
11. **Unknown vocabulary.** Plugins add event types, source kinds and content block types
    freely. Be permissive; the strictness in the official reader is about safe *resumption*,
    not display.
12. **Version gate.** Header `version` must equal the file name's `N`; a `session.v5…` would be
    a format this document does not cover — show metadata only.
13. **Hidden cwd collisions.** Two cwds can map to one project directory; always group by header
    `cwd`, not by directory name.
14. **Privacy.** System prompts, tool schemas, file contents and command output are all in the
    log in clear text (compressed, not encrypted).

---


## Checked against one real file (2026-11-18)

One real session written on Windows (one turn: a prompt, five model responses with reasoning,
four `web_search` calls, a final text, `turn/end` completed; 48 lines in 25 frames, 85 KB
compressed, 283 KB decoded) was decoded with a decoder written separately from the product's
reader and compared with what the product shows for it. Prompt text, the five reasoning texts,
each call's name, arguments, output and status, the final text, every node time (to the
millisecond), the title, the working directory, the session id and the usage of each response
were equal. No record type outside this document occurred. The harness version that wrote the
file was not recorded. What that file settles, by the number of the open question below:

- **1.** On Node 25.2 `zlib.zstdDecompressSync(wholeFile)` returns the first frame only (the
  header line) and does not throw. The frame walk is mandatory.
- **3.** Every event after the header has `type`, `seq`, `time`, `data` in that order; some
  also carry `surfaceOp` or `sourceEventSeqs`. No `ignorable` was seen.
- **4.** The session id is `session-<uuid>` (44 characters) in the header, and the session
  directory has the same name. The project directory was the working directory with every
  separator and the drive colon turned into `-`, wrapped in `--` on both sides.
- **5.** (partly) On this machine the files were under `%USERPROFILE%\.dsh` with no `DSH_HOME`
  set. Which surface wrote them was not recorded.
- **6.** (partly) In all five responses `totalTokens = inputTokens + cacheReadTokens +
  cacheWriteTokens + outputTokens`, so `inputTokens` excludes cache reads; `cacheWriteTokens`
  was 0 every time. Whether `outputTokens` includes reasoning cannot be told from the file.
- **7.** The longest line was 43 KB (an assistant row with its embedded stream); the
  `request/header` row was 33 KB.

Also seen: three of the four `user/message` rows were injected (`source.kind` of
`runtime-context`, `skill-catalog`, `time-context`), one was typed (`user`); the title was set
twice (`source.kind` `fallback`, then `provider`); the row types
`session-log-deepseek/delivery-accepted`, `session/title-llm-request`, `request/context`,
`agent/inbox/spliced`, `permission/preset`, `sandbox/mode`, `approval/policy` occur in an
ordinary session.

Not covered by that file: subagents, forks, compaction, a turn that fails or is interrupted,
file-reading and file-writing tools, more than one turn, questions 2 and 8-12.

## Open questions that only a real file can settle

1. Does `zlib.zstdDecompressSync(wholeFile)` / `createZstdDecompress()` on the installed Node
   return all concatenated frames, stop after the first, or throw? (Decides whether the
   frame-walk is mandatory or just the tailing optimisation.)
2. Exact frame-header variant Node writes (single-segment + content size or not). Irrelevant if
   the general walk in §2.2 is ported, but worth one assertion in a test.
3. Real envelope bytes: presence and order of `seq`/`time` and whether any shipped event
   actually carries `ignorable: true` (fixtures strip `seq`/`time` and show no `ignorable`).
4. Session id syntax (UUID? prefix?) and therefore what directory names look like; whether
   `encodeSegment` ever escapes anything in practice.
5. Whether the desktop app on Windows uses `%USERPROFILE%\.dsh` or sets its own `DSH_HOME`.
6. `outputTokens` includes `reasoningTokens` for every provider adapter, or only for the
   DeepSeek one seen in fixtures; and whether `cacheWriteTokens` is ever non-zero.
7. Typical and maximum line/frame sizes (stream-embedded assistant rows, `request/header`).
8. With several `subagent` calls in one step: is each `subagent/catalog` row still between its
   own `tool/call` and `tool/result`, and is `meta.name` always present on the result?
9. What a one-shot/"unknown" child looks like in files written by 0.1.x builds (catalog v0-v2,
   no `name`).
10. What the UI's delete, "edit earlier message" and rewind actions do on disk (delete the
    directory? fork?), and the on-disk shape of the archive set under `<home>/storages`.
11. How often the tail is observed torn in practice, and whether the 200 ms batching makes
    frames small enough that per-frame decode cost matters.
12. Whether real v3-highest sessions still exist on machines installed after 0.1.7.
