import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { COPILOT_FIRST_LINE_MAX_BYTES, COPILOT_WORKSPACE_MAX_BYTES, CopilotFileSource, copilotIo, type CopilotLookup } from '../src/sources/copilot/source.js';
import { isPromise, originOfKey, type FileClass } from '../src/sources/source.js';
import { EVENTS_KEY, EVENTS_REL, exampleLines, SID, startLine, WORKSPACE_KEY, WORKSPACE_REL, WORKSPACE_YAML } from './copilot-fixtures.js';

let tmp: string;
let dir: string;
const abs = (rel: string): string => path.join(dir, ...rel.split('/'));
async function writeRel(rel: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
  await fs.writeFile(abs(rel), content);
}
const body = (ls: string[]): string => ls.map((l) => `${l}\n`).join('');
async function classify(source: CopilotFileSource, k: string): Promise<FileClass | null> {
  const c = source.classify(k);
  return isPromise(c) ? await c : c;
}
const LEGACY_SID = '11111111-2222-4333-8444-555555555555';
const LEGACY_REL = `${LEGACY_SID}.jsonl`;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-copilot-source-'));
  dir = path.join(tmp, '.copilot', 'session-state');
  await fs.mkdir(dir, { recursive: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

describe('CopilotFileSource: files and keys', () => {
  test('origin, root, watch depth 1', () => {
    const s = new CopilotFileSource(dir);
    expect(s).toMatchObject({ origin: 'copilot', rootDir: dir, watchDepth: 1 });
  });

  test('keys: <id>/events.jsonl, legacy <id>.jsonl, <id>/workspace.yaml; nothing else', () => {
    const s = new CopilotFileSource(dir);
    expect(s.keyOf(abs(EVENTS_REL))).toBe(EVENTS_KEY);
    expect(s.keyOf(abs(LEGACY_REL))).toBe(`copilot:${LEGACY_REL}`);
    expect(s.keyOf(abs(WORKSPACE_REL))).toBe(WORKSPACE_KEY);
    for (const rel of [
      `${SID}/session.db`,
      `${SID}/checkpoints/001.json`,
      `${SID}/checkpoints/index.md`,
      `${SID}/checkpoints/events.jsonl`,
      `${SID}/plan.md`,
      `${SID}/files/notes.txt`,
      `${SID}/inuse.lock`,
      `${SID}/vscode.metadata.json`,
      `${SID}/other.jsonl`,
      `${SID}`,
      'notes.txt',
      '.jsonl',
      '../events.jsonl',
    ]) {
      expect(s.keyOf(abs(rel)), rel).toBeNull();
    }
    expect(s.keyOf(path.join(tmp, 'elsewhere', 'events.jsonl'))).toBeNull();
    for (const k of [EVENTS_KEY, `copilot:${LEGACY_REL}`, WORKSPACE_KEY]) {
      expect(s.pathOf(k)).toBe(abs(k.slice('copilot:'.length)));
      expect(originOfKey(k)).toBe('copilot');
    }
    expect(s.pathOf('copilot:x/plan.md')).toBeNull();
    expect(s.pathOf('gemini:x/events.jsonl')).toBeNull();
  });

  test('listFiles: events, workspace and legacy files by name, without entering checkpoints/ or files/', async () => {
    await writeRel(EVENTS_REL, body(exampleLines()));
    await writeRel(WORKSPACE_REL, WORKSPACE_YAML);
    await writeRel(`${SID}/session.db`, 'x');
    await writeRel(`${SID}/checkpoints/001.json`, '{}');
    await writeRel(`${SID}/files/a.txt`, 'a');
    await writeRel(LEGACY_REL, body([startLine()]));
    await writeRel('empty-dir/plan.md', '# plan');
    await fs.mkdir(abs('events.jsonl'), { recursive: true }); // a directory named like a file: not listed
    const readdir = vi.spyOn(fs, 'readdir');
    const listed = await new CopilotFileSource(dir).listFiles();
    expect(listed).toEqual([abs(EVENTS_REL), abs(WORKSPACE_REL), abs(LEGACY_REL)].sort());
    const visited = readdir.mock.calls.map((c) => path.resolve(String(c[0])));
    expect(visited.some((p) => p.includes('checkpoints') || p.endsWith(`${path.sep}files`))).toBe(false);
    for (const call of readdir.mock.calls) expect((call[1] as { recursive?: boolean } | undefined)?.recursive ?? false).toBe(false);
  });

  test('listFiles of a missing directory is empty', async () => {
    expect(await new CopilotFileSource(path.join(tmp, 'nope')).listFiles()).toEqual([]);
  });
});

describe('CopilotFileSource: classify', () => {
  test('events.jsonl and legacy <id>.jsonl → session (id from the path); workspace.yaml → title; others → null', async () => {
    await writeRel(EVENTS_REL, body(exampleLines()));
    await writeRel(WORKSPACE_REL, WORKSPACE_YAML);
    await writeRel(LEGACY_REL, body([startLine('/home/dev/legacy')]));
    const s = new CopilotFileSource(dir);
    expect(await classify(s, EVENTS_KEY)).toEqual({ kind: 'session', projectId: '-home-dev-demo', sessionId: SID });
    expect(await classify(s, WORKSPACE_KEY)).toEqual({ kind: 'title', projectId: '-home-dev-demo', sessionId: SID });
    expect(await classify(s, `copilot:${LEGACY_REL}`)).toEqual({ kind: 'session', projectId: '-home-dev-legacy', sessionId: LEGACY_SID });
    for (const k of [`copilot:${SID}/session.db`, `copilot:${SID}/plan.md`, `copilot:${SID}/checkpoints/001.json`, 'codex:x.jsonl']) expect(await classify(s, k), k).toBeNull();
    expect(s.mainSessionOf(EVENTS_KEY)).toBe(SID);
    expect(s.mainSessionOf(`copilot:${LEGACY_REL}`)).toBe(LEGACY_SID);
    expect(s.mainSessionOf(WORKSPACE_KEY)).toBeNull();
    expect(s.projectOfKey(EVENTS_KEY)).toBeNull();
    expect(s.projectOfTranscript(abs(EVENTS_REL))).toBe('-home-dev-demo');
  });

  test('project order 1: what is stored with the raw events wins, without reading the file', async () => {
    await writeRel(EVENTS_REL, body(exampleLines()));
    const lookup: CopilotLookup = { storedFile: (k) => (k === EVENTS_KEY ? { sessionId: SID, agentId: null, projectId: 'stored-project' } : null), knownProjectIds: () => [] };
    const read = vi.spyOn(copilotIo, 'readFirstLine');
    const s = new CopilotFileSource(dir, lookup);
    expect(await classify(s, EVENTS_KEY)).toMatchObject({ projectId: 'stored-project' });
    expect(await classify(s, WORKSPACE_KEY)).toBeNull(); // no workspace.yaml
    await writeRel(WORKSPACE_REL, 'cwd: /somewhere/else\n');
    expect(await classify(s, WORKSPACE_KEY)).toMatchObject({ projectId: 'stored-project' });
    expect(read).not.toHaveBeenCalled();
  });

  test('project order 2–4: the first line’s session.start cwd, else workspace.yaml cwd, else unknown', async () => {
    await writeRel(EVENTS_REL, body([JSON.stringify({ type: 'user.message', id: 'u', data: { content: 'no start first' } })]));
    await writeRel(WORKSPACE_REL, 'cwd: /home/dev/from-yaml\n');
    expect(await classify(new CopilotFileSource(dir), EVENTS_KEY)).toMatchObject({ projectId: '-home-dev-from-yaml' });
    await writeRel(WORKSPACE_REL, 'name: no cwd here\n');
    expect(await classify(new CopilotFileSource(dir), EVENTS_KEY)).toMatchObject({ projectId: 'unknown' });
    await writeRel(EVENTS_REL, body([startLine('/home/dev/first-line')]));
    await writeRel(WORKSPACE_REL, 'cwd: /home/dev/from-yaml\n');
    expect(await classify(new CopilotFileSource(dir), EVENTS_KEY)).toMatchObject({ projectId: '-home-dev-first-line' });
  });

  test('a project id in use that differs only in letter case is reused', async () => {
    await writeRel(EVENTS_REL, body([startLine('C:\\Work\\Demo')]));
    const lookup: CopilotLookup = { storedFile: () => null, knownProjectIds: () => ['c--work-demo'] };
    expect(await classify(new CopilotFileSource(dir, lookup), EVENTS_KEY)).toMatchObject({ projectId: 'c--work-demo' });
  });

  test('a zero-byte file or an incomplete first line: null (nothing to read yet), not cached', async () => {
    await writeRel(EVENTS_REL, '');
    const s = new CopilotFileSource(dir);
    expect(await classify(s, EVENTS_KEY)).toBeNull();
    await writeRel(EVENTS_REL, startLine().slice(0, 40));
    expect(await classify(s, EVENTS_KEY)).toBeNull();
    await writeRel(EVENTS_REL, body([startLine()]));
    expect(await classify(s, EVENTS_KEY)).toMatchObject({ projectId: '-home-dev-demo' });
    expect(await classify(s, 'copilot:missing.jsonl')).toBeNull();
  });

  test('the first-line read is bounded: a longer first line is not read past the window (falls back to the workspace)', async () => {
    const huge = `{"type":"session.start","data":{"pad":"${'x'.repeat(COPILOT_FIRST_LINE_MAX_BYTES * 2)}"}}`;
    await writeRel(EVENTS_REL, `${huge}\n`);
    await writeRel(WORKSPACE_REL, 'cwd: /home/dev/from-yaml\n');
    const read = vi.spyOn(copilotIo, 'readFirstLine');
    expect(await classify(new CopilotFileSource(dir), EVENTS_KEY)).toMatchObject({ projectId: '-home-dev-from-yaml' });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![1]).toBeLessThanOrEqual(COPILOT_FIRST_LINE_MAX_BYTES);
    const result = await read.mock.results[0]!.value;
    expect(result.bytesRead).toBeLessThanOrEqual(COPILOT_FIRST_LINE_MAX_BYTES);
  });

  test('workspace.yaml: bounded, cached by mtime and size; an oversized one counts as missing and is not classified', async () => {
    await writeRel(EVENTS_REL, body([JSON.stringify({ type: 'user.message', id: 'u', data: { content: 'x' } })]));
    await writeRel(WORKSPACE_REL, `cwd: /home/dev/big\nsummary: ${'y'.repeat(COPILOT_WORKSPACE_MAX_BYTES)}\n`);
    const ws = vi.spyOn(copilotIo, 'readWorkspace');
    const s = new CopilotFileSource(dir);
    expect(await classify(s, WORKSPACE_KEY)).toBeNull();
    expect(await classify(s, EVENTS_KEY)).toMatchObject({ projectId: 'unknown' });
    expect(ws.mock.results.every((r) => r.value === null)).toBe(true);

    // Small: read once, then served from the cache while unchanged.
    await writeRel(WORKSPACE_REL, 'cwd: /home/dev/small\n');
    const before = copilotIo.workspaceReads;
    const s2 = new CopilotFileSource(dir);
    expect(await classify(s2, EVENTS_KEY)).toMatchObject({ projectId: '-home-dev-small' });
    expect(await classify(new CopilotFileSource(dir), EVENTS_KEY)).toMatchObject({ projectId: '-home-dev-small' });
    expect(copilotIo.workspaceReads - before).toBe(1);
  });

  test('a legacy file next to the session directory’s events.jsonl is not the session’s main file', async () => {
    await writeRel(`${SID}.jsonl`, body([startLine()]));
    const s = new CopilotFileSource(dir);
    expect(s.mainSessionOf(`copilot:${SID}.jsonl`)).toBe(SID);
    await writeRel(EVENTS_REL, body([startLine()]));
    expect(s.mainSessionOf(`copilot:${SID}.jsonl`)).toBeNull();
    expect(s.mainSessionOf(EVENTS_KEY)).toBe(SID);
  });

  test('garbage sidecars and first lines never throw', async () => {
    await writeRel(EVENTS_REL, '\u0000\u0001garbage\n{"type":');
    await writeRel(WORKSPACE_REL, Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    const s = new CopilotFileSource(dir);
    expect(await classify(s, EVENTS_KEY)).toMatchObject({ kind: 'session', projectId: 'unknown' });
    expect(await classify(s, WORKSPACE_KEY)).toMatchObject({ kind: 'title' });
  });
});
