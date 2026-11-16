import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as sidecar from '../src/sources/sidecar.js';
import { GROK_SUMMARY_ENTRY_PREFIX, GROK_SUMMARY_MAX_BYTES, GrokFileSource, type GrokLookup } from '../src/sources/grok/source.js';
import { CHILD, CWD, DIR, iso, PROJECT, SID, summaryJson, T0 } from './grok-fixtures.js';

let tmp: string;
let root: string;

const abs = (rel: string): string => path.join(root, ...rel.split('/'));
async function writeRel(rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
  await fs.writeFile(abs(rel), content);
}
const key = (rel: string): string => `grok:${rel}`;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-grok-source-'));
  root = path.join(tmp, '.grok', 'sessions');
  await fs.mkdir(root, { recursive: true });
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

describe('GrokFileSource', () => {
  test('keys: updates.jsonl and summary.json of <cwd dir>/<id>/ only', () => {
    const s = new GrokFileSource(root);
    expect(s.origin).toBe('grok');
    expect(s.watchDepth).toBe(2);
    expect(s.keyOf(abs(`${DIR}/${SID}/updates.jsonl`))).toBe(key(`${DIR}/${SID}/updates.jsonl`));
    expect(s.keyOf(abs(`${DIR}/${SID}/summary.json`))).toBe(key(`${DIR}/${SID}/summary.json`));
    for (const other of [`${DIR}/${SID}/chat_history.jsonl`, `${DIR}/${SID}/usage.json`, `${DIR}/.cwd`, `${DIR}/${SID}/prompts/updates.jsonl`, `${SID}/updates.jsonl`, `@x/${SID}/summary.json`]) {
      expect(s.keyOf(abs(other)), other).toBeNull();
    }
    expect(s.keyOf(path.join(tmp, 'elsewhere.jsonl'))).toBeNull();
    expect(s.pathOf(key(`${DIR}/${SID}/updates.jsonl`))).toBe(abs(`${DIR}/${SID}/updates.jsonl`));
    expect(s.pathOf('grok:nope')).toBeNull();
    expect(s.pathOf(`${GROK_SUMMARY_ENTRY_PREFIX}${SID}`)).toBeNull();
  });

  test('a directory without summary.json is not a session: not listed, not classified', async () => {
    await writeRel(`${DIR}/${SID}/updates.jsonl`, '{}\n');
    const s = new GrokFileSource(root);
    expect(await s.listFiles()).toEqual([]);
    expect(await s.classify(key(`${DIR}/${SID}/updates.jsonl`))).toBeNull();
    expect(s.mainSessionOf(key(`${DIR}/${SID}/updates.jsonl`))).toBeNull();
    // Once summary.json is there, it is.
    await writeRel(`${DIR}/${SID}/summary.json`, summaryJson());
    expect(await s.listFiles()).toEqual([abs(`${DIR}/${SID}/summary.json`), abs(`${DIR}/${SID}/updates.jsonl`)]);
    expect(await s.classify(key(`${DIR}/${SID}/updates.jsonl`))).toEqual({ kind: 'session', projectId: PROJECT, sessionId: SID });
    expect(s.mainSessionOf(key(`${DIR}/${SID}/updates.jsonl`))).toBe(SID);
    expect(await s.classify(key(`${DIR}/${SID}/summary.json`))).toEqual({ kind: 'index', projectId: '', sessionId: '' });
  });

  test('project: info.cwd, else the URL-decoded directory name when absolute, else <cwd dir>/.cwd, else unknown', async () => {
    const cases: [string, string | null, string | null, string][] = [
      // [directory name, info.cwd, .cwd content, expected project]
      ['%2Fhome%2Fdev%2Fother', CWD, null, PROJECT],
      ['%2Fhome%2Fdev%2Fother', null, null, '-home-dev-other'],
      ['D%3A%5Cwork%5Cdemo', null, null, 'D--work-demo'],
      ['demo-0123456789abcdef', null, '/home/dev/a/very/long/path/demo\n', '-home-dev-a-very-long-path-demo'],
      ['demo-0123456789abcdef', null, null, 'unknown'],
      ['relative%20name', null, null, 'unknown'],
      ['%E0%A4%A', null, null, 'unknown'], // undecodable
      ['demo-fedcba9876543210', null, 'not absolute', 'unknown'],
    ];
    for (const [i, [dir, cwd, dotCwd, want]] of cases.entries()) {
      const id = `${SID.slice(0, -2)}${i.toString().padStart(2, '0')}`;
      await writeRel(`${dir}/${id}/summary.json`, summaryJson({ id, cwd }));
      if (dotCwd !== null) await writeRel(`${dir}/.cwd`, dotCwd);
      const s = new GrokFileSource(root);
      expect(await s.classify(key(`${dir}/${id}/updates.jsonl`)), `${dir} ${cwd}`).toEqual({ kind: 'session', projectId: want, sessionId: id });
      await fs.rm(abs(dir), { recursive: true });
    }
  });

  test('a subagent directory is an agent thread of its parent; a fork (parent, kind not subagent) is its own session', async () => {
    await writeRel(`${DIR}/${CHILD}/summary.json`, summaryJson({ id: CHILD, kind: 'subagent', parent: SID }));
    const FORK = '11111111-2222-4333-8444-555555555555';
    await writeRel(`${DIR}/${FORK}/summary.json`, summaryJson({ id: FORK, kind: 'worktree', parent: SID, extra: { forked_at: '2026-11-10T09:05:00Z' } }));
    const LONE = '66666666-2222-4333-8444-555555555555';
    await writeRel(`${DIR}/${LONE}/summary.json`, summaryJson({ id: LONE, kind: 'subagent' })); // no parent: its own session
    const s = new GrokFileSource(root);
    expect(await s.classify(key(`${DIR}/${CHILD}/updates.jsonl`))).toEqual({ kind: 'agent', projectId: PROJECT, sessionId: SID, agentId: CHILD });
    expect(s.mainSessionOf(key(`${DIR}/${CHILD}/updates.jsonl`))).toBeNull();
    expect(await s.classify(key(`${DIR}/${FORK}/updates.jsonl`))).toEqual({ kind: 'session', projectId: PROJECT, sessionId: FORK });
    expect(await s.classify(key(`${DIR}/${LONE}/updates.jsonl`))).toEqual({ kind: 'session', projectId: PROJECT, sessionId: LONE });
    // Summary entries: the main sessions only (a subagent's title is not its parent's).
    expect(s.indexEntries(key(`${DIR}/${CHILD}/summary.json`), summaryJson({ id: CHILD, kind: 'subagent', parent: SID }))).toEqual([]);
    expect(s.indexEntries(key(`${DIR}/${FORK}/summary.json`), summaryJson({ id: FORK, kind: 'worktree', parent: SID })).map((e) => e.sessionId)).toEqual([FORK]);
  });

  test('summary entry: a projection of summary.json (title fields, model, cwd, branch, start), keyed per session', async () => {
    await writeRel(`${DIR}/${SID}/summary.json`, summaryJson());
    const s = new GrokFileSource(root);
    const entries = s.indexEntries(key(`${DIR}/${SID}/summary.json`), summaryJson());
    expect(entries).toEqual([
      {
        key: `${GROK_SUMMARY_ENTRY_PREFIX}${SID}`,
        sessionId: SID,
        agentId: null,
        projectId: PROJECT,
        payload: JSON.stringify({ title: 'Fix failing unit test in parser', summary: 'Fix failing unit test', model: 'grok-build', cwd: CWD, branch: 'main', createdAt: iso(T0) }),
      },
    ]);
    // Counters change on every append; the projection does not.
    const bumped = summaryJson({ extra: { num_messages: 99, updated_at: '2026-11-10T10:00:00Z' } });
    expect(s.indexEntries(key(`${DIR}/${SID}/summary.json`), bumped)).toEqual(entries);
    expect(s.indexEntries(key(`${DIR}/${SID}/summary.json`), 'not json')).toEqual([]);
    expect(s.indexEntries(key(`${DIR}/${SID}/updates.jsonl`), summaryJson())).toEqual([]);
  });

  test('oversized or garbage summary.json counts as missing; reads are bounded and cached by mtime and size', async () => {
    await writeRel(`${DIR}/${SID}/summary.json`, `{"info":{"id":"${SID}","cwd":"${CWD}"},"pad":"${'x'.repeat(GROK_SUMMARY_MAX_BYTES)}"}`);
    const s = new GrokFileSource(root);
    expect(await s.classify(key(`${DIR}/${SID}/summary.json`))).toBeNull();
    expect(await s.classify(key(`${DIR}/${SID}/updates.jsonl`))).toBeNull();
    await writeRel(`${DIR}/${SID}/summary.json`, '{"info": garbage');
    expect(await s.classify(key(`${DIR}/${SID}/updates.jsonl`))).toBeNull();
    await writeRel(`${DIR}/${SID}/summary.json`, summaryJson());
    const before = sidecar.sidecarReads;
    const s2 = new GrokFileSource(root);
    const OTHER = '77777777-2222-4333-8444-555555555555';
    await writeRel(`${DIR}/${OTHER}/summary.json`, summaryJson({ id: OTHER }));
    expect(await s2.classify(key(`${DIR}/${OTHER}/updates.jsonl`))).toMatchObject({ kind: 'session' });
    const afterOne = sidecar.sidecarReads;
    expect(afterOne - before).toBe(1);
    // Cached per key: no more reads; a fresh source reads again only when the file changed.
    expect(await s2.classify(key(`${DIR}/${OTHER}/updates.jsonl`))).toMatchObject({ kind: 'session' });
    expect(await new GrokFileSource(root).classify(key(`${DIR}/${OTHER}/updates.jsonl`))).toMatchObject({ kind: 'session' });
    expect(sidecar.sidecarReads).toBe(afterOne);
  });

  test('classification is restored from the stored raw events without reading anything', async () => {
    const stored: GrokLookup = {
      storedFile: (k) => (k === key(`${DIR}/${CHILD}/updates.jsonl`) ? { sessionId: SID, agentId: CHILD, projectId: PROJECT } : null),
      knownProjectIds: () => [],
    };
    const s = new GrokFileSource(root, stored);
    // No summary.json on disk at all.
    expect(await s.classify(key(`${DIR}/${CHILD}/updates.jsonl`))).toEqual({ kind: 'agent', projectId: PROJECT, sessionId: SID, agentId: CHILD });
    expect(s.projectOfTranscript(abs(`${DIR}/${CHILD}/updates.jsonl`))).toBe(PROJECT);
    expect(s.projectOfKey(key(`${DIR}/${CHILD}/updates.jsonl`))).toBeNull();
  });

  test('a Windows project id differing only in letter case is reused', async () => {
    const lookup: GrokLookup = { storedFile: () => null, knownProjectIds: () => ['D--Work-Demo'] };
    await writeRel(`D%3A%5Cwork%5Cdemo/${SID}/summary.json`, summaryJson({ cwd: null }));
    const s = new GrokFileSource(root, lookup);
    expect(await s.classify(key(`D%3A%5Cwork%5Cdemo/${SID}/updates.jsonl`))).toMatchObject({ projectId: 'D--Work-Demo' });
  });

  test('missing root: no files, no throw', async () => {
    const s = new GrokFileSource(path.join(tmp, 'nope'));
    expect(await s.listFiles()).toEqual([]);
  });
});
