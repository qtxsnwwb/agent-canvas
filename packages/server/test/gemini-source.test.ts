import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as projectModule from '../src/sources/gemini/project.js';
import { geminiProject, GEMINI_PROJECT_ENTRY_PREFIX, PROJECT_ROOT_MAX_BYTES } from '../src/sources/gemini/project.js';
import { GEMINI_PROJECTS_KEY, GeminiFileSource, type GeminiLookup } from '../src/sources/gemini/source.js';
import { isPromise, originOfKey, type FileClass } from '../src/sources/source.js';
import { exampleLines, legacyJson, MAIN_KEY, MAIN_REL, metaLine, SID, SUB_ID, SUB_KEY, SUB_REL, subagentLines, userMsg, M1 } from './gemini-fixtures.js';

let tmp: string;
let root: string;
let dir: string;
const abs = (rel: string): string => path.join(dir, ...rel.split('/'));
async function writeRel(rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
  await fs.writeFile(abs(rel), content);
}
const body = (ls: string[]): string => ls.map((l) => `${l}\n`).join('');
async function classify(source: GeminiFileSource, k: string): Promise<FileClass | null> {
  const c = source.classify(k);
  return isPromise(c) ? await c : c;
}
const LEGACY_REL = 'demo-app/chats/session-2026-11-16T09-41-3f9c2a1b.json';

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-gemini-source-'));
  root = path.join(tmp, '.gemini');
  dir = path.join(root, 'tmp');
  await fs.mkdir(dir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

describe('GeminiFileSource: files and keys', () => {
  test('origin, root, watch depth reaching <slug>/chats/<session>/<agent>.jsonl', () => {
    const s = new GeminiFileSource(dir);
    expect(s.origin).toBe('gemini');
    expect(s.rootDir).toBe(dir);
    expect(s.watchDepth).toBe(3);
  });

  test('keys of every path shape; others are not this source’s', () => {
    const s = new GeminiFileSource(dir);
    expect(s.keyOf(abs(MAIN_REL))).toBe(MAIN_KEY);
    expect(s.keyOf(abs(SUB_REL))).toBe(SUB_KEY);
    expect(s.keyOf(abs(LEGACY_REL))).toBe(`gemini:${LEGACY_REL}`);
    expect(s.keyOf(abs('demo-app/.project_root'))).toBe('gemini:demo-app/.project_root');
    expect(s.keyOf(path.join(root, 'projects.json'))).toBe(GEMINI_PROJECTS_KEY);
    for (const rel of [
      'demo-app/chats/session-x.jsonl.tmp-1234',
      'demo-app/chats/session-x.jsonl.unreadable-1700000000',
      'demo-app/chats/other.jsonl',
      'demo-app/logs.json',
      'demo-app/checkpoint-x.json',
      'demo-app/chats/a/b/c.jsonl',
      'demo-app/chats/p/x.txt',
      'demo-app/chats/p/x.jsonl.tmp-9',
      'demo-app/shell_history',
    ]) {
      expect(s.keyOf(abs(rel)), rel).toBeNull();
    }
    expect(s.keyOf(path.join(root, 'settings.json'))).toBeNull();
    expect(s.pathOf(MAIN_KEY)).toBe(abs(MAIN_REL));
    expect(s.pathOf(GEMINI_PROJECTS_KEY)).toBe(path.join(root, 'projects.json'));
    expect(s.pathOf(`${GEMINI_PROJECT_ENTRY_PREFIX}${SID}`)).toBeNull();
    expect(originOfKey(MAIN_KEY)).toBe('gemini');
  });

  test('listFiles: the files of every shape, projects.json, sorted; nothing else', async () => {
    await writeRel(MAIN_REL, body(exampleLines()));
    await writeRel(SUB_REL, body(subagentLines()));
    await writeRel('demo-app/.project_root', '/home/dev/demo-app');
    await writeRel('demo-app/logs.json', '[]');
    await writeRel('demo-app/chats/session-z.jsonl.tmp-1', 'x');
    await fs.writeFile(path.join(root, 'projects.json'), '{}');
    const s = new GeminiFileSource(dir);
    expect(await s.listFiles()).toEqual([abs(MAIN_REL), abs(SUB_REL), abs('demo-app/.project_root'), path.join(root, 'projects.json')].sort());
  });

  test('listFiles of a missing directory: empty, nothing created', async () => {
    const missing = path.join(tmp, 'nope', 'tmp');
    expect(await new GeminiFileSource(missing).listFiles()).toEqual([]);
    await expect(fs.stat(path.join(tmp, 'nope'))).rejects.toThrow();
  });
});

describe('GeminiFileSource: classify', () => {
  test('main .jsonl → session (id from the first line); subagent → agent (session = folder, agent = file name)', async () => {
    await writeRel(MAIN_REL, body(exampleLines()));
    await writeRel(SUB_REL, body(subagentLines()));
    const s = new GeminiFileSource(dir);
    expect(await classify(s, MAIN_KEY)).toEqual({ kind: 'session', projectId: 'gemini:demo-app', sessionId: SID });
    expect(await classify(s, SUB_KEY)).toEqual({ kind: 'agent', projectId: 'gemini:demo-app', sessionId: SID, agentId: SUB_ID });
    expect(s.mainSessionOf(MAIN_KEY)).toBe(SID);
    expect(s.mainSessionOf(SUB_KEY)).toBeNull();
  });

  test('index files: .project_root and projects.json', async () => {
    const s = new GeminiFileSource(dir);
    expect(await classify(s, 'gemini:demo-app/.project_root')).toEqual({ kind: 'index', projectId: '', sessionId: '' });
    expect(await classify(s, GEMINI_PROJECTS_KEY)).toEqual({ kind: 'index', projectId: '', sessionId: '' });
  });

  test('a first line still being written / missing / without sessionId: throws (reported, retried); a missing file: null', async () => {
    const s = new GeminiFileSource(dir);
    await writeRel(MAIN_REL, metaLine().slice(0, 20));
    await expect(classify(s, MAIN_KEY)).rejects.toThrow(/incomplete/);
    await writeRel(MAIN_REL, '');
    await expect(classify(s, MAIN_KEY)).rejects.toThrow(/missing/);
    await writeRel(MAIN_REL, '{"$set":{}}\n');
    await expect(classify(s, MAIN_KEY)).rejects.toThrow(/sessionId/);
    expect(await classify(s, 'gemini:demo-app/chats/session-gone.jsonl')).toBeNull();
  });

  test('legacy .json → title (whole read), session id from its head; skipped when the same-named .jsonl exists', async () => {
    await writeRel(LEGACY_REL, legacyJson([userMsg(M1, 'a')]));
    const s = new GeminiFileSource(dir);
    expect(await classify(s, `gemini:${LEGACY_REL}`)).toEqual({ kind: 'title', projectId: 'gemini:demo-app', sessionId: SID });
    expect(s.mainSessionOf(`gemini:${LEGACY_REL}`)).toBe(SID);
    await writeRel(`${LEGACY_REL}l`, body(exampleLines()));
    const s2 = new GeminiFileSource(dir);
    expect(await classify(s2, `gemini:${LEGACY_REL}`)).toBeNull();
    expect(s2.mainSessionOf(`gemini:${LEGACY_REL}`)).toBeNull();
    expect(await classify(s2, `gemini:${LEGACY_REL}l`)).toEqual({ kind: 'session', projectId: 'gemini:demo-app', sessionId: SID });
  });

  test('legacy .json whose sessionId is not first: parsed whole; a subagent legacy .json → agent_meta', async () => {
    await writeRel(LEGACY_REL, JSON.stringify({ projectHash: 'x', messages: [], sessionId: SID }));
    await writeRel(`demo-app/chats/${SID}/${SUB_ID}.json`, legacyJson([], {}, SUB_ID));
    const s = new GeminiFileSource(dir);
    expect(await classify(s, `gemini:${LEGACY_REL}`)).toMatchObject({ kind: 'title', sessionId: SID });
    expect(await classify(s, `gemini:demo-app/chats/${SID}/${SUB_ID}.json`)).toEqual({ kind: 'agent_meta', projectId: 'gemini:demo-app', sessionId: SID, agentId: SUB_ID });
  });

  test('the session of a key is taken from the stored raw events, without reading the file', async () => {
    const lookup: GeminiLookup = { storedFile: (k) => (k === MAIN_KEY ? { sessionId: 'stored-id', agentId: null, projectId: 'P-stored' } : null), knownProjectIds: () => [] };
    const s = new GeminiFileSource(dir, lookup); // the file does not exist
    expect(await classify(s, MAIN_KEY)).toEqual({ kind: 'session', projectId: 'P-stored', sessionId: 'stored-id' });
    expect(s.mainSessionOf(MAIN_KEY)).toBe('stored-id');
  });

  test('projectOfKey is null (the project is stored with each event); projectOfTranscript after classify', async () => {
    await writeRel(MAIN_REL, body(exampleLines()));
    const s = new GeminiFileSource(dir);
    expect(s.projectOfKey(MAIN_KEY)).toBeNull();
    await classify(s, MAIN_KEY);
    expect(s.projectOfTranscript(abs(MAIN_REL))).toBe('gemini:demo-app');
  });
});

describe('geminiProject and project entries', () => {
  test('from .project_root, else projects.json, else gemini:<slug> with no cwd', async () => {
    expect(geminiProject(dir, 'demo-app', () => [], 'linux')).toEqual({ projectId: 'gemini:demo-app', cwd: null });
    await fs.writeFile(path.join(root, 'projects.json'), JSON.stringify({ projects: { '/home/dev/other': 'other', '/home/dev/demo-app': 'demo-app' } }));
    expect(geminiProject(dir, 'demo-app', () => [], 'linux')).toEqual({ projectId: '-home-dev-demo-app', cwd: '/home/dev/demo-app' });
    await writeRel('demo-app/.project_root', '/home/dev/Demo-App\n');
    expect(geminiProject(dir, 'demo-app', () => [], 'linux')).toEqual({ projectId: '-home-dev-Demo-App', cwd: '/home/dev/Demo-App' });
  });

  test('Windows: the lower-cased .project_root reuses a project id in use that differs only in case; elsewhere exact', async () => {
    await writeRel('demo-app/.project_root', 'c:\\work\\demo-app');
    const known = () => ['C--Work-Demo-App'];
    expect(geminiProject(dir, 'demo-app', known, 'win32')).toEqual({ projectId: 'C--Work-Demo-App', cwd: 'C:\\work\\demo-app' });
    expect(geminiProject(dir, 'demo-app', () => [], 'win32')).toEqual({ projectId: 'C--work-demo-app', cwd: 'C:\\work\\demo-app' });
    expect(geminiProject(dir, 'demo-app', known, 'linux').projectId).toBe('C--work-demo-app');
  });

  test('missing, empty or garbage sidecars do not throw', async () => {
    await writeRel('demo-app/.project_root', '');
    await fs.writeFile(path.join(root, 'projects.json'), '{not json');
    expect(geminiProject(dir, 'demo-app')).toEqual({ projectId: 'gemini:demo-app', cwd: null });
    await fs.writeFile(path.join(root, 'projects.json'), JSON.stringify({ projects: ['x'] }));
    expect(geminiProject(dir, 'demo-app')).toEqual({ projectId: 'gemini:demo-app', cwd: null });
    await fs.writeFile(path.join(root, 'projects.json'), '[]');
    expect(geminiProject(dir, 'nope')).toEqual({ projectId: 'gemini:nope', cwd: null });
  });

  test('classify uses the project; indexEntries give one entry per session seen in that directory', async () => {
    await writeRel(MAIN_REL, body(exampleLines()));
    await writeRel('demo-app/.project_root', '/home/dev/demo-app');
    await writeRel('other/chats/session-2026-11-16T10-00-aaaaaaaa.jsonl', `${metaLine('aaaaaaaa-0000')}\n`);
    const s = new GeminiFileSource(dir);
    expect(s.indexVersion()).toBe(0);
    await classify(s, MAIN_KEY);
    await classify(s, 'gemini:other/chats/session-2026-11-16T10-00-aaaaaaaa.jsonl');
    expect(s.indexVersion()).toBe(2);
    expect(s.indexFiles()).toEqual([path.join(root, 'projects.json'), abs('demo-app/.project_root'), abs('other/.project_root')]);
    const proj = '-home-dev-demo-app';
    expect(s.indexEntries('gemini:demo-app/.project_root', '')).toEqual([
      { key: `${GEMINI_PROJECT_ENTRY_PREFIX}${SID}`, sessionId: SID, agentId: null, projectId: proj, payload: JSON.stringify({ cwd: '/home/dev/demo-app' }) },
    ]);
    // 'other' has no directory anywhere: no entry.
    expect(s.indexEntries(GEMINI_PROJECTS_KEY, '{}').map((e) => e.sessionId)).toEqual([SID]);
    expect(s.indexEntries('gemini:other/.project_root', '')).toEqual([]);
  });
});

describe('fix round 1: sidecars', () => {
  test('M4: a .project_root that is not one absolute path (relative, multi-line, control characters) counts as missing', async () => {
    await fs.writeFile(path.join(root, 'projects.json'), JSON.stringify({ projects: { '/home/dev/demo-app': 'demo-app', 'relative/x': 'rel' } }));
    for (const bad of ['\u0000\u0001garbage not a path', 'relative/path', '/home/dev/a\n/home/dev/b', 'C:\\work\u0007x', '  ']) {
      await writeRel('demo-app/.project_root', bad);
      expect(geminiProject(dir, 'demo-app', () => [], 'linux'), JSON.stringify(bad)).toEqual({ projectId: '-home-dev-demo-app', cwd: '/home/dev/demo-app' });
    }
    expect(geminiProject(dir, 'rel', () => [], 'linux')).toEqual({ projectId: 'gemini:rel', cwd: null });
    for (const good of ['/home/dev/demo-app\n', 'C:\\work\\demo', 'c:/work/demo', '\\\\server\\share\\demo']) {
      await writeRel('demo-app/.project_root', good);
      expect(geminiProject(dir, 'demo-app', () => [], 'linux').cwd, good).not.toBeNull();
    }
  });

  test('I5: an oversized .project_root is not read (treated as missing); 1,000 sessions read each sidecar once per change', async () => {
    await writeRel('demo-app/.project_root', `/home/dev/${'x'.repeat(PROJECT_ROOT_MAX_BYTES + 10)}`);
    const before = projectModule.sidecarReads;
    expect(geminiProject(dir, 'demo-app', () => [], 'linux')).toEqual({ projectId: 'gemini:demo-app', cwd: null });
    expect(projectModule.sidecarReads).toBe(before);

    await writeRel('demo-app/.project_root', '/home/dev/demo-app');
    await fs.writeFile(path.join(root, 'projects.json'), JSON.stringify({ projects: { '/home/dev/demo-app': 'demo-app' } }));
    const s = new GeminiFileSource(dir);
    const start = projectModule.sidecarReads;
    for (let i = 0; i < 1000; i++) await classify(s, `gemini:demo-app/chats/${`s${i}`.padStart(8, '0')}/a.jsonl`);
    expect(s.indexEntries('gemini:demo-app/.project_root', '')).toHaveLength(1000);
    expect(s.indexEntries(GEMINI_PROJECTS_KEY, '')).toHaveLength(1000);
    expect(projectModule.sidecarReads - start).toBeLessThanOrEqual(2);
    const again = projectModule.sidecarReads;
    s.indexEntries('gemini:demo-app/.project_root', '');
    expect(projectModule.sidecarReads).toBe(again);
  });
});
