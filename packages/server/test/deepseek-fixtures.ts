import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import type { RawEvent } from '../src/store/store.js';

// Invented DeepSeek Harness (dsh) session data, shaped after docs/formats/deepseek-harness.md (sections 1, 2, 4.1, 5):
// fake ids, paths and text. Files are built at test time with node:zlib's own zstd (checksum flag on, as dsh does).

type Obj = Record<string, unknown>;

export const SID = 'f3a9c1d2-5b6e-4a7f-8c9d-0e1f2a3b4c5d';
export const CHILD = '7b8c9d0e-1f2a-4b3c-9d4e-5f6a7b8c9d0e';
export const GRANDCHILD = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
export const CWD = 'D:\\Projects\\Demo';
/** CWD as Claude Code encodes it (the project id). */
export const PROJECT = 'D--Projects-Demo';
/** Epoch ms of the example's header. */
export const T0 = 1789626545611;
export const V4 = 'session.v4.jsonl.zstd';

/** Whether this Node has zstd in node:zlib (Node >= 22.15); tests that need it skip otherwise. */
export const HAS_ZSTD = typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === 'function';
export const NO_ZSTD_REASON = 'node:zlib has no zstd on this Node (needs 22.15 or later): DeepSeek container tests skipped';

/** dsh's `projectKey(cwd)` (format reference 1.2). */
export function projectKey(cwd: string): string {
  let out = '';
  let inSep = false;
  for (let i = 0; i < cwd.length; i++) {
    const ch = cwd[i]!;
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!inSep) out += '-';
      inSep = true;
      continue;
    }
    inSep = false;
    out += /[A-Za-z0-9._-]/.test(ch) ? ch : `~${cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  const slug = out.replace(/^-+/, '') || 'root';
  return `--${slug.slice(0, 251)}--`;
}

/** dsh's `encodeSegment(id)` (format reference 1.2). */
export function encodeSegment(id: string): string {
  if (id === '.' || id === '..') return id.replace(/\./g, '~002E');
  let out = '';
  for (let i = 0; i < id.length; i++) {
    const ch = id[i]!;
    out += /[A-Za-z0-9._-]/.test(ch) ? ch : `~${id.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/** `<projectKey(cwd)>/<encodeSegment(id)>/<name>`: a session file's path relative to `<dsh home>/sessions`. */
export const sessionRel = (id: string, cwd: string | null = CWD, name = V4): string => `${cwd === null ? '_no-cwd' : projectKey(cwd)}/${encodeSegment(id)}/${name}`;

/** The header line (format reference 4.1). */
export function headerLine(opts: { id?: string; cwd?: string | null; parent?: string; origin?: 'subagent'; depth?: number; seeded?: boolean; version?: number; extra?: Obj } = {}): string {
  const h: Obj = {
    type: 'session',
    version: opts.version ?? 4,
    id: opts.id ?? SID,
    createdAt: T0,
    ...(opts.cwd === null ? {} : { cwd: opts.cwd ?? CWD }),
    ...(opts.parent !== undefined ? { parentSession: opts.parent } : {}),
    isSeeded: opts.seeded ?? false,
    ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
    delegationDepth: opts.depth ?? (opts.parent !== undefined ? 1 : 0),
    ...opts.extra,
  };
  return JSON.stringify(h);
}

/** An event row `{type, seq, time, data}` (format reference 4.2). */
export const eventLine = (seq: number, type = 'turn/start', data: Obj = { turn: 1 }): string => JSON.stringify({ type, seq, time: T0 + 100 + seq, data });

/** One standard zstd frame of `lines` (each followed by `\n`), with the content checksum, as dsh writes it. */
export function frameOf(lines: readonly string[]): Buffer {
  const z = zlib as unknown as { zstdCompressSync(b: Buffer, o: object): Buffer; constants: Record<string, number> };
  return z.zstdCompressSync(Buffer.from(lines.map((l) => `${l}\n`).join('')), { params: { [z.constants.ZSTD_c_checksumFlag!]: 1 } });
}

/** The bytes of a session file: the header alone in frame 1, then one frame per batch. */
export const fileBytes = (header: string, batches: readonly (readonly string[])[] = []): Buffer => Buffer.concat([frameOf([header]), ...batches.map((b) => frameOf(b))]);

/** Writes a session file (header frame + one frame per batch), creating its directories. */
export async function writeSession(file: string, header: string, batches: readonly (readonly string[])[] = []): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, fileBytes(header, batches));
}

/** Appends one batch (one frame), as dsh's writer does. */
export async function appendBatch(file: string, lines: readonly string[]): Promise<void> {
  await fs.appendFile(file, frameOf(lines));
}

/** Appends the first `keep` bytes of a batch's frame: a torn last frame. Returns the whole frame (to complete it later). */
export async function appendTorn(file: string, lines: readonly string[], keep: number): Promise<Buffer> {
  const frame = frameOf(lines);
  await fs.appendFile(file, frame.subarray(0, keep));
  return frame;
}

/** Cuts the file to `size` bytes (dsh's writer truncating a torn frame, or rolling back a failed append). */
export async function truncateTo(file: string, size: number): Promise<void> {
  await fs.truncate(file, size);
}

/** `n` consecutive event rows starting at `seq`. */
export const events = (seq: number, n: number, type?: string): string[] => Array.from({ length: n }, (_, i) => eventLine(seq + i, type));

// ---- event logs for the normaliser (format reference sections 4.3-4.11) ----

/** Epoch ms of event `seq` in a DshLog: one second apart, after the header's createdAt. */
export const timeOf = (seq: number, base = T0 + 1000): number => base + seq * 1000;
export const isoOf = (ms: number): string => new Date(ms).toISOString();

export const textBlock = (text: string): Obj => ({ type: 'text', text });
export const reasoningBlock = (text: string): Obj => ({ type: 'reasoning', text });
export const callBlock = (id: string, name: string, args: unknown): Obj => ({ type: 'tool-call', id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });

/** An event log whose rows get `seq` 0, 1, 2, … and `time` = timeOf(seq) as they are added. */
export class DshLog {
  readonly lines: string[] = [];
  private seq: number;
  constructor(
    first = 0,
    private readonly base = T0 + 1000,
  ) {
    this.seq = first;
  }
  get next(): number {
    return this.seq;
  }
  /** A row of any type; returns its seq. */
  add(type: string, data: unknown, extra: Obj = {}): number {
    const seq = this.seq++;
    this.lines.push(JSON.stringify({ type, seq, time: timeOf(seq, this.base), data, ...extra }));
    return seq;
  }
  turnStart(turn: number): number {
    return this.add('turn/start', { turn });
  }
  turnEnd(turn: number, reason: Obj = { kind: 'completed' }): number {
    return this.add('turn/end', { turn, reason });
  }
  stepStart(turn: number, step: number): number {
    return this.add('step/start', { turn, step });
  }
  stepEnd(turn: number, step: number): number {
    return this.add('step/end', { turn, step });
  }
  /** A `user/message`; `source` defaults to a human prompt. */
  user(text: string, source: Obj = { kind: 'user', rpcId: 'rpc-1' }, extra: Obj = {}): number {
    return this.add('user/message', { id: `u-${this.seq}`, role: 'user', content: [textBlock(text)], source }, { surfaceOp: 'append', ...extra });
  }
  assistant(turn: number, step: number, content: Obj[], opts: { id?: string; usage?: Obj | null; model?: string; provider?: string; interrupted?: boolean } = {}): number {
    const usage = opts.usage === undefined ? { inputTokens: 100, outputTokens: 20, cacheReadTokens: 1000, reasoningTokens: 5 } : opts.usage;
    const message = { id: opts.id ?? `a-${this.seq}`, role: 'assistant', content, source: { kind: 'model', provider: opts.provider ?? 'deepseek-official', model: opts.model ?? 'deepseek-v4-flash' } };
    const stream = [{ type: 'text-chunks', time0: timeOf(this.seq, this.base), index: 0, dt: [1], texts: ['(stream copy)'] }];
    return this.add('assistant/message', { turn, step, message, ...(usage === null ? {} : { usage }), stream, ...(opts.interrupted ? { interrupted: true } : {}) }, { surfaceOp: 'append' });
  }
  toolCall(turn: number, step: number, callId: string, name: string, args: unknown): number {
    return this.add('tool/call', { turn, step, callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
  }
  toolResult(turn: number | null, step: number | null, callId: string, text: string, opts: { isError?: boolean; meta?: Obj; error?: Obj; surfaceOp?: unknown; callSeq?: number } = {}): number {
    const message = { id: `r-${this.seq}`, role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: [textBlock(text)], isError: opts.isError ?? false };
    const data: Obj = { ...(turn === null ? {} : { turn }), ...(step === null ? {} : { step }), message, ...(opts.meta !== undefined ? { meta: opts.meta } : {}), ...(opts.error !== undefined ? { error: opts.error } : {}) };
    return this.add('tool/result', data, { ...(opts.callSeq !== undefined ? { sourceEventSeqs: [opts.callSeq] } : {}), surfaceOp: opts.surfaceOp ?? 'append' });
  }
  title(title: string, kind = 'fallback'): number {
    return this.add('session/title', { title, messageSeqs: [], source: { kind } });
  }
  cwd(cwd: string): number {
    return this.add('working-directory/change', { cwd });
  }
  catalog(childId: string, name: string | null, opts: { mode?: string; label?: string } = {}): number {
    return this.add('subagent/catalog', { version: name === null ? 0 : 3, childId, childCreatedAt: T0, mode: opts.mode ?? 'continuable', label: opts.label ?? 'helper', ...(name === null ? {} : { name }) });
  }
  endSeed(inherited: boolean): number {
    return this.add('session/end-seed', inherited ? { inherited: true } : {});
  }
}

/** The raw events of one file as the source delivers them: the header at offset 0, then the rows at 1, 2, …. */
export function dshEvents(header: string, lines: readonly string[], opts: { sessionId?: string; agentId?: string | null; key?: string; projectId?: string | null; startOffset?: number } = {}): RawEvent[] {
  const agentId = opts.agentId ?? null;
  const key = opts.key ?? `deepseek:${sessionRel(agentId ?? opts.sessionId ?? SID)}`;
  const all = [header, ...lines];
  const start = opts.startOffset ?? 0;
  return all.slice(start).map((line, i) => {
    let recordType = '?';
    try {
      recordType = String((JSON.parse(line) as Obj).type);
    } catch {
      // kept as '?'
    }
    return { source: 'transcript' as const, origin: 'deepseek' as const, file: key, offset: start + i, line, recordType, sessionId: opts.sessionId ?? SID, agentId, projectId: opts.projectId === undefined ? PROJECT : opts.projectId };
  });
}

/**
 * The example main session: turn 1 (an injected message, the prompt, a bash call that succeeds, then the same callId
 * in step 2 for a read_file call that fails, then a reply), two titles, a cwd change, a manual compaction, turn 2
 * dispatching the CHILD subagent (`agent-1`) and an external one (`agent-2`), aborted by the user.
 */
export function exampleMain(): { header: string; lines: string[] } {
  const l = new DshLog();
  l.turnStart(1); // 0
  l.user('<instructions>be careful</instructions>', { kind: 'agent-instructions', form: 'instructions' }); // 1
  l.add('agent/inbox/spliced', { inserted: [{ id: 'u-3', role: 'user', content: [textBlock('Fix the failing test')], source: { kind: 'user' } }] }); // 2
  l.user('Fix the failing test'); // 3
  l.stepStart(1, 1); // 4
  l.add('request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } }); // 5
  l.assistant(1, 1, [reasoningBlock('I should run the tests first.'), textBlock('Running the tests.'), callBlock('call_00_a', 'bash', { command: 'npm test' })], {
    id: 'msg-1',
    usage: { inputTokens: 135, outputTokens: 124, cacheReadTokens: 1664, cacheWriteTokens: 10, reasoningTokens: 55 },
  }); // 6
  l.toolCall(1, 1, 'call_00_a', 'bash', { command: 'npm test' }); // 7
  l.toolResult(1, 1, 'call_00_a', '1 failed\n', { meta: { cwd: CWD }, callSeq: 7 }); // 8
  l.stepEnd(1, 1); // 9
  l.title('Fix the failing test'); // 10
  l.stepStart(1, 2); // 11
  l.assistant(1, 2, [callBlock('call_00_a', 'read_file', { path: 'src/parser.ts' })], { id: 'msg-2', usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 1800 } }); // 12
  l.toolCall(1, 2, 'call_00_a', 'read_file', { path: 'src/parser.ts' }); // 13
  l.toolResult(1, 2, 'call_00_a', 'no such file', { isError: true, error: { name: 'NotFound', code: 'ENOENT' }, callSeq: 13 }); // 14
  l.stepEnd(1, 2); // 15
  l.stepStart(1, 3); // 16
  l.assistant(1, 3, [textBlock('The parser test fails; fixed it.')], { id: 'msg-3', usage: { inputTokens: 20, outputTokens: 30, cacheReadTokens: 1900 } }); // 17
  l.stepEnd(1, 3); // 18
  l.turnEnd(1); // 19
  l.title('Fix the parser test', 'provider'); // 20
  l.cwd('D:\\Projects\\Demo\\packages\\api'); // 21
  l.add('compaction/start', { compactionId: 'c1', turn: null }); // 22
  l.add('compaction/summary', { compactionId: 'c1', summary: [textBlock('## Summary')], shadowedRange: { start: 3, end: 8 }, shadowedSeqs: [3, 8], shadowedTokenCount: 400, provider: 'deepseek-official', model: 'deepseek-v4-flash', usage: { inputTokens: 10, outputTokens: 2 } }); // 23
  l.user('This is an automatically generated checkpoint of the conversation so far.', { kind: 'compact-checkpoint', compactionId: 'c1' }, { sourceEventSeqs: [20, 22, 3, 4, 5], surfaceOp: { op: 'replace', startSeq: 3, endSeq: 8 } }); // 24
  l.add('compaction/end', { compactionId: 'c1', turn: null }); // 25
  l.turnStart(2); // 26
  l.user('Spawn a helper'); // 27
  l.stepStart(2, 1); // 28
  l.assistant(2, 1, [callBlock('call_00_s', 'subagent', { prompt: 'check the parser' }), callBlock('call_01_e', 'subagent', { prompt: 'ask codex', backend: 'codex' })], { id: 'msg-4' }); // 29
  l.toolCall(2, 1, 'call_00_s', 'subagent', { prompt: 'check the parser' }); // 30
  l.catalog(CHILD, 'agent-1', { label: 'parser check' }); // 31
  l.toolResult(2, 1, 'call_00_s', 'started subagent agent-1', { meta: { kind: 'activation', name: 'agent-1' } }); // 32
  l.toolCall(2, 1, 'call_01_e', 'subagent', { prompt: 'ask codex', backend: 'codex' }); // 33
  l.catalog('codex-thread-77', 'agent-2', { mode: 'external', label: 'codex' }); // 34
  l.toolResult(2, 1, 'call_01_e', 'started subagent agent-2', { meta: { kind: 'activation', name: 'agent-2' } }); // 35
  l.stepEnd(2, 1); // 36
  l.turnEnd(2, { kind: 'aborted', reason: { kind: 'user' } }); // 37
  return { header: headerLine(), lines: l.lines };
}

/** The CHILD subagent's file: descriptor, its task prompt, a reply, and a dispatch of GRANDCHILD (`agent-1/agent-1`). */
export function exampleChild(): { header: string; lines: string[] } {
  const l = new DshLog(0, T0 + 40_000);
  l.add('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'spawn', label: 'parser check', agentProvider: 'deepseek-official', agentModel: 'deepseek-v4-flash' }); // 0
  l.turnStart(1); // 1
  l.user('check the parser'); // 2
  l.stepStart(1, 1); // 3
  l.assistant(1, 1, [textBlock('Looking.'), callBlock('call_00_g', 'subagent', { prompt: 'go deeper' })], { id: 'cmsg-1' }); // 4
  l.toolCall(1, 1, 'call_00_g', 'subagent', { prompt: 'go deeper' }); // 5
  l.catalog(GRANDCHILD, 'agent-1', { label: 'deeper' }); // 6
  l.toolResult(1, 1, 'call_00_g', 'started subagent agent-1/agent-1', { meta: { kind: 'activation', name: 'agent-1/agent-1' } }); // 7
  l.stepEnd(1, 1); // 8
  l.stepStart(1, 2); // 9
  l.assistant(1, 2, [textBlock('The parser is fine.')], { id: 'cmsg-2' }); // 10
  l.stepEnd(1, 2); // 11
  l.turnEnd(1); // 12
  return { header: headerLine({ id: CHILD, parent: SID, origin: 'subagent' }), lines: l.lines };
}

/** The GRANDCHILD's file (parent: CHILD). */
export function exampleGrandchild(): { header: string; lines: string[] } {
  const l = new DshLog(0, T0 + 50_000);
  l.turnStart(1);
  l.user('go deeper');
  l.stepStart(1, 1);
  l.assistant(1, 1, [textBlock('Nothing deeper.')], { id: 'gmsg-1' });
  l.stepEnd(1, 1);
  l.turnEnd(1);
  return { header: headerLine({ id: GRANDCHILD, parent: CHILD, origin: 'subagent', depth: 2 }), lines: l.lines };
}
