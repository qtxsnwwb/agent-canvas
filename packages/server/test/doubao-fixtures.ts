import fs from 'node:fs/promises';
import path from 'node:path';
import type { RawEvent } from '../src/store/store.js';

// Invented Doubao Work (豆包工作) session data, shaped after docs/formats/doubao-work.md (A1-A4): fake ids, paths and
// text, constructed from the third-party reader's rules (no real file was ever seen).

type Obj = Record<string, unknown>;

/** A conversation id (digits, as the reference's readers expect). */
export const CONV = '7391000000000000123';
/** The main agent's directory (`^m_[a-zA-Z0-9]+$`). */
export const MAIN = 'm_ab12';
/** An organizer subagent and a leaf under it (prefixes as in the third-party fixture). */
export const ORG = 'o_cd34';
export const LEAF = 's_ef56';
/** Header times of the example's demands. */
export const T1 = '2026-11-17T02:00:00.000Z';
export const T2 = '2026-11-17T03:00:00.000Z';
export const T3 = '2026-11-17T04:00:00.000Z';
/** A file modification time used for the fallback. */
export const MTIME = Date.parse('2026-11-17T09:30:00.000Z');
export const DOUBAO_PROJECT_ID = 'doubao-work';

export const body = (lines: readonly string[]): string => lines.map((l) => `${l}\n`).join('');

// ---- trajectory.jsonl rows (format reference A2) ----

export const user = (content: unknown, extra: Obj = {}): string => JSON.stringify({ role: 'user', content, ...extra });
export const call = (id: string, name: string, args: unknown): Obj => ({ id, function: { name, arguments: args } });
/** An assistant row; `content` undefined leaves the field out (a row of tool calls only). */
export function assistant(content: unknown, calls?: Obj[], extra: Obj = {}): string {
  const rec: Obj = { role: 'assistant' };
  if (content !== undefined) rec.content = content;
  if (calls !== undefined) rec.tool_calls = calls;
  return JSON.stringify({ ...rec, ...extra });
}
export const tool = (id: string, content: unknown): string => JSON.stringify({ role: 'tool', tool_call_id: id, content });
/** The `create_agent` result text (format reference A4). */
export const createAgentOk = (child: string, parent: string, threadId = '7391000000000000001', extra = 'agent_type: organizer\nsubtask: Collect the figures'): string =>
  `create_agent ok\nagent_id: ${child}\nparent_id: ${parent}\nthread_id: ${threadId}\n${extra}`;

// ---- assignment.md (format reference A1, "Sibling files") ----

export const REMINDER = '<system-reminder>\nThe user is in China; answer in Chinese.\n</system-reminder>';

/** An assignment.md: an administrative header, then one `## [<at>] 需求` section per demand. */
export function assignment(demands: readonly { at: string; text: string }[], preface = '# Assignment\n- Role: main\n\n'): string {
  return preface + demands.map((d) => `## [${d.at}] 需求\n${d.text}\n\n`).join('');
}

/** The example main agent: two prompts, two parallel Reads, a create_agent call, final answers. */
export function exampleMain(): { lines: string[]; assignment: string } {
  const lines = [
    user('Summarise the three reports in this folder'),
    assistant('I will read the files first.', [call('call_a1', 'Read', { file_path: 'report-1.md' }), call('call_a2', 'Read', JSON.stringify({ file_path: 'report-2.md' }))]),
    tool('call_a2', 'second report text'),
    tool('call_a1', 'first report text'),
    assistant(undefined, [call('call_c1', 'create_agent', { subtask: 'Collect the figures' })]),
    tool('call_c1', createAgentOk(ORG, 'main_agent')),
    assistant('Here is the summary: all three are fine.'),
    user('Now chart them'),
    assistant('Charted.', [call('call_b1', 'PowerShell', { command: 'python chart.py' })]),
    tool('call_b1', 'ok'),
    assistant('Done: chart.png'),
  ];
  const text = assignment([
    { at: T1, text: `${REMINDER}\nSummarise the three reports in this folder` },
    { at: T1, text: REMINDER }, // a notification sharing the time: not a demand
    { at: T2, text: 'Now chart them' },
  ]);
  return { lines, assignment: text };
}

/** The organizer: its task arrives in assignment.md only (no user row), it writes a file. */
export function exampleChild(): { lines: string[]; assignment: string } {
  const lines = [
    assistant('Collecting.', [call('call_w1', 'Write', { file_path: 'figures.csv', content: 'a,b' })]),
    tool('call_w1', 'written'),
    assistant('Figures collected.'),
  ];
  return { lines, assignment: assignment([{ at: T3, text: 'Collect the figures' }], '# Assignment\n- Role: organizer\n\n') };
}

// ---- raw events as the pipeline stores them ----

/** The synthetic first line the Doubao reader emits when it reads a file from its start. */
export const fileLine = (mtimeMs: number): string => JSON.stringify({ __agentCanvas: 'file', mtimeMs });

/** Store key of an agent's file under the root labelled `label` (default profile and namespace). */
export const keyOf = (agent: string, file: 'trajectory.jsonl' | 'assignment.md', o: { conv?: string; label?: string; profile?: string; ns?: string } = {}): string =>
  `doubao:${o.label ?? 'DoubaoWork'}/${o.profile ?? 'Default'}/${o.ns ?? '.doubaowork'}/${o.conv ?? CONV}/${agent}/${file}`;

/**
 * The raw events of a trajectory read whole from its start: the synthetic line at offset -1, then each row at its
 * byte offset. agentId null for the main agent.
 */
export function rowEvents(lines: readonly string[], o: { agent?: string; agentId?: string | null; conv?: string; mtimeMs?: number | null } = {}): RawEvent[] {
  const agent = o.agent ?? MAIN;
  const agentId = o.agentId === undefined ? (agent === MAIN ? null : agent) : o.agentId;
  const conv = o.conv ?? CONV;
  const file = keyOf(agent, 'trajectory.jsonl', { conv });
  const out: RawEvent[] = [];
  const mk = (offset: number, line: string): RawEvent => ({ source: 'transcript', origin: 'doubao', file, offset, line, recordType: '', sessionId: conv, agentId, projectId: null });
  if (o.mtimeMs !== null) out.push(mk(-1, fileLine(o.mtimeMs ?? MTIME)));
  let offset = 0;
  for (const line of lines) {
    out.push(mk(offset, line));
    offset += Buffer.byteLength(line) + 1;
  }
  return out;
}

/** The meta raw event of an agent's assignment.md (kind `title` for the main agent, `agent_meta` for the others). */
export function metaEvent(payload: string, o: { agent?: string; conv?: string } = {}): RawEvent {
  const agent = o.agent ?? MAIN;
  const conv = o.conv ?? CONV;
  return { source: 'meta', origin: 'doubao', file: keyOf(agent, 'assignment.md', { conv }), sessionId: conv, agentId: agent === MAIN ? null : agent, payload };
}

/** Byte offset of row `i` of `lines`. */
export const offsetOf = (lines: readonly string[], i: number): number => lines.slice(0, i).reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);

// ---- files on disk ----

/** `<root>/<profile>/<ns>/agent_mode/workspace/.sessions`. */
export const sessionsDir = (root: string, profile = 'Default', ns = '.doubaowork'): string => path.join(root, profile, ns, 'agent_mode', 'workspace', '.sessions');
/** `<sessions>/<conv>/agents/<agent>/system/<file>`. */
export const agentFile = (root: string, agent: string, file: 'trajectory.jsonl' | 'assignment.md', o: { conv?: string; profile?: string; ns?: string } = {}): string =>
  path.join(sessionsDir(root, o.profile, o.ns), o.conv ?? CONV, 'agents', agent, 'system', file);

export async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

/** Writes the example conversation (main + organizer) under a root and sets each trajectory's modification time. */
export async function writeExample(root: string, o: { conv?: string; profile?: string; ns?: string; mtimeMs?: number } = {}): Promise<void> {
  const m = exampleMain();
  const c = exampleChild();
  await write(agentFile(root, MAIN, 'trajectory.jsonl', o), body(m.lines));
  await write(agentFile(root, MAIN, 'assignment.md', o), m.assignment);
  await write(agentFile(root, ORG, 'trajectory.jsonl', o), body(c.lines));
  await write(agentFile(root, ORG, 'assignment.md', o), c.assignment);
  const t = new Date(o.mtimeMs ?? MTIME);
  for (const a of [MAIN, ORG]) await fs.utimes(agentFile(root, a, 'trajectory.jsonl', o), t, t);
}
