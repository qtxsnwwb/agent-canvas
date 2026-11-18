import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fileSources } from '../src/cli.js';
import { loadConfig, type Config } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { QWEN_SCAN_BUDGET, QwenFileSource, qwenProjectDir, type QwenLookup } from '../src/sources/qwen/source.js';
import { openStore, type Store } from '../src/store/store.js';
import { CWD as BUDDY_CWD, exampleMain, SID as BUDDY_SID } from './buddy-fixtures.js';
import { exampleSession, line, Log, SID, system } from './qwen-fixtures.js';

// QwenFileSource (Qwen Code, spec 2, 3; docs/formats/qwen-code.md 1, 4.4, 4.6, 5.2): which files under
// `<qwenDir>/projects` are sessions, titles, subagent threads and their sidecars; their keys (an archived file keeps the
// key of its place in `chats/`); the project of each; managed sessions. Temp directories only.

/** Qwen Code's project directory name of CWD (reference 1.3); the source never decodes it. */
const QP = 'home-u-app';
/** Project id of CWD (`/home/u/app`, Claude Code's encoding). */
const PROJECT_ID = '-home-u-app';
const SID2 = 'a1b2c3d4-0000-4000-8000-000000000002';
/** 32 hex digits without hyphens: also a session id (the product's own rule). */
const SID32 = '0123456789abcdef0123456789ABCDEF';
const AGENT = 'Explore-call_b7';

let tmp: string;
let qwen: string;
let projects: string;
const stores: Store[] = [];
const pipelines: Pipeline[] = [];

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-qwen-source-'));
  qwen = path.join(tmp, '.qwen');
  projects = path.join(qwen, 'projects');
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of pipelines.splice(0)) {
    await p.close();
    await p.idle();
  }
  for (const s of stores.splice(0)) s.close();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

const body = (lines: readonly string[]): string => lines.map((l) => `${l}\n`).join('');
async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}
const chatsAt = (name: string, p = QP): string => path.join(projects, p, 'chats', name);
const archiveAt = (name: string, p = QP): string => path.join(projects, p, 'chats', 'archive', name);
const mainAt = (sid = SID, p = QP): string => chatsAt(`${sid}.jsonl`, p);
const agentAt = (stem = AGENT, sid = SID, p = QP, ext = '.jsonl'): string => path.join(projects, p, 'subagents', sid, `agent-${stem}${ext}`);
const cfg = (o: { qwenDir?: string | null; codebuddyDir?: string | null } = {}): Config =>
  loadConfig({}, {
    projectsDir: path.join(tmp, 'claude-projects'),
    dataDir: path.join(tmp, 'data'),
    codexSessionsDir: null,
    cursorDbPath: null,
    geminiDir: null,
    grokDir: null,
    copilotDir: null,
    deepseekDir: null,
    workbuddyDirs: [],
    codebuddyDir: o.codebuddyDir ?? null,
    doubaoDirs: [],
    qwenDir: o.qwenDir === undefined ? qwen : o.qwenDir,
  });
const qwenOf = (sources: readonly { origin: string }[]): QwenFileSource => sources.find((s) => s.origin === 'qwen') as QwenFileSource;

/** A session's lines whose records carry `cwd` (the example session otherwise). */
function sessionLines(o: { sid?: string; cwd?: string; prefix?: string } = {}): string[] {
  const log = new Log({ sessionId: o.sid ?? SID, prefix: o.prefix });
  log.prompt('hello');
  log.add((env) => line('assistant', undefined, env, { message: { role: 'model', parts: [{ text: 'hi' }] } }));
  return o.cwd === undefined ? log.lines : log.lines.map((l) => JSON.stringify({ ...(JSON.parse(l) as object), cwd: o.cwd }));
}
const mainKey = (sid = SID, p = QP): string => `qwen:${p}/chats/${sid}.jsonl`;
/** A managed session's header record (reference 4.6; the wrapper format is not traced, only its subtype matters). */
const managedHeader = (sid = SID): string => JSON.stringify({ uuid: 'm-1', parentUuid: null, sessionId: sid, timestamp: '2026-11-16T09:00:00.000Z', type: 'system', subtype: 'managed_session_header_v1', cwd: '/home/u/app' });
const engineRecord = (sid = SID): string => system('session_execution_engine', { owner: 'managed' }, { uuid: 'e-1', parentUuid: null, sessionId: sid, timestamp: '2026-11-16T09:00:00.000Z' });

describe('files and keys', () => {
  test('origin, root, depth, line identity, reader', () => {
    const s = new QwenFileSource(projects);
    expect(s.origin).toBe('qwen');
    expect(s.rootDir).toBe(projects);
    expect(s.watchDepth).toBe(3);
    expect(s.lineIdentity).toBe('offset');
    expect(typeof s.readLines).toBe('function'); // readGuardedLines, wrapped (a file gone at the path read keeps its offset)
    expect(s.status()).toEqual({ unsupportedSessions: 0 });
  });

  test('each kind of file has its key; the key leads back to the file', () => {
    const s = new QwenFileSource(projects);
    const cases: [string, string][] = [
      [mainAt(), mainKey()],
      [chatsAt(`${SID}.title.json`), `qwen:${QP}/chats/${SID}.title.json`],
      [mainAt(SID32), mainKey(SID32)],
      [agentAt(), `qwen:${QP}/subagents/${SID}/agent-${AGENT}.jsonl`],
      [agentAt(AGENT, SID, QP, '.meta.json'), `qwen:${QP}/subagents/${SID}/agent-${AGENT}.meta.json`],
    ];
    for (const [file, key] of cases) {
      expect(s.keyOf(file), file).toBe(key);
      expect(s.pathOf(key), key).toBe(file);
    }
  });

  test('an archived session and its title have the keys of their place in chats/', () => {
    const s = new QwenFileSource(projects);
    expect(s.keyOf(archiveAt(`${SID}.jsonl`))).toBe(mainKey());
    expect(s.keyOf(archiveAt(`${SID}.title.json`))).toBe(`qwen:${QP}/chats/${SID}.title.json`);
  });

  test('everything else is not a file of the source', () => {
    const s = new QwenFileSource(projects);
    const not = [
      chatsAt(`${SID}.runtime.json`),
      chatsAt(`${SID}.worktree.json`),
      chatsAt(`${SID}.pr.json`),
      archiveAt(`${SID}.runtime.json`),
      agentAt(AGENT, SID, QP, '.jsonl.stream'),
      agentAt('', SID, QP),
      agentAt('a.b', SID, QP),
      path.join(projects, QP, 'subagents', SID, 'notagent-x.jsonl'),
      path.join(projects, QP, 'subagents', 'not-a-session', `agent-${AGENT}.jsonl`),
      path.join(projects, QP, 'workflows', 'run-1', 'journal.jsonl'),
      path.join(projects, QP, 'workflows', `${SID}.jsonl`),
      path.join(projects, QP, `${SID}.jsonl`),
      path.join(projects, QP, 'chats', 'archive', 'archive', `${SID}.jsonl`),
      path.join(projects, `${SID}.jsonl`),
      path.join(qwen, 'tmp', 'abc', 'chats', `${SID}.jsonl`),
      path.join(tmp, 'elsewhere', QP, 'chats', `${SID}.jsonl`),
      // The id pattern: 32 to 36 hex digits or hyphens.
      mainAt('0123456789abcdef0123456789abcde'), // 31
      mainAt(`${SID}0`), // 37
      mainAt('3b1e0c9a-5d2f-4e61-8a70-1c2d3e4f5a6g'),
      chatsAt('session-2025-11-27T10-00-3b1e0c9a.json'),
    ];
    for (const file of not) expect(s.keyOf(file), file).toBeNull();
    for (const key of [`qwen:${QP}/chats/archive/${SID}.jsonl`, `codebuddy:${QP}/chats/${SID}.jsonl`, `${QP}/chats/${SID}.jsonl`, `qwen:${QP}/chats/${SID}.runtime.json`]) {
      expect(s.pathOf(key), key).toBeNull();
    }
  });

  test('pathOf a session or title key: chats/ when it exists, else chats/archive/ when that exists, else chats/', async () => {
    const s = new QwenFileSource(projects);
    for (const name of [`${SID}.jsonl`, `${SID}.title.json`]) {
      const key = `qwen:${QP}/chats/${name}`;
      expect(s.pathOf(key)).toBe(chatsAt(name)); // neither
      await write(archiveAt(name), '{}\n');
      expect(s.pathOf(key)).toBe(archiveAt(name)); // archived only
      await write(chatsAt(name), '{}\n');
      expect(s.pathOf(key)).toBe(chatsAt(name)); // both: chats/
      await fs.rm(archiveAt(name));
      expect(s.pathOf(key)).toBe(chatsAt(name)); // chats/ only
    }
  });

  test('both copies present: chats/ is read; the archived copy is not a file of the source while the other exists', async () => {
    await write(mainAt(), body(sessionLines()));
    await write(archiveAt(`${SID}.jsonl`), body(sessionLines({ prefix: 'x' })));
    await write(chatsAt(`${SID}.title.json`), '{}');
    await write(archiveAt(`${SID}.title.json`), '{}');
    const s = new QwenFileSource(projects);
    expect(s.keyOf(archiveAt(`${SID}.jsonl`))).toBeNull();
    expect(s.keyOf(archiveAt(`${SID}.title.json`))).toBeNull();
    const listed = await s.listFiles();
    expect(listed).toEqual([chatsAt(`${SID}.jsonl`), chatsAt(`${SID}.title.json`)].sort());
    // The chats/ copy goes: the archived one is the session's file again.
    await fs.rm(mainAt());
    expect(s.keyOf(archiveAt(`${SID}.jsonl`))).toBe(mainKey());
    expect(await s.listFiles()).toEqual([archiveAt(`${SID}.jsonl`), chatsAt(`${SID}.title.json`)].sort());
  });

  test('listing: sessions (in chats/ or archived), titles, subagent threads and their sidecars; nothing else', async () => {
    await write(mainAt(), body(sessionLines()));
    await write(chatsAt(`${SID}.title.json`), '{}');
    await write(archiveAt(`${SID2}.jsonl`), body(sessionLines({ sid: SID2 })));
    await write(archiveAt(`${SID2}.title.json`), '{}');
    await write(agentAt(), '');
    await write(agentAt(AGENT, SID, QP, '.meta.json'), '{}');
    for (const other of [
      chatsAt(`${SID}.runtime.json`),
      chatsAt(`${SID}.worktree.json`),
      chatsAt(`${SID}.pr.json`),
      archiveAt(`${SID2}.pr.json`),
      agentAt(AGENT, SID, QP, '.jsonl.stream'),
      path.join(projects, QP, 'workflows', 'w', 'journal.jsonl'),
      chatsAt('notes.jsonl'),
      path.join(qwen, 'tmp', 'h', 'chats', 'session-1.json'),
    ]) {
      await write(other, '{}\n');
    }
    const s = new QwenFileSource(projects);
    expect(await s.listFiles()).toEqual(
      [mainAt(), chatsAt(`${SID}.title.json`), archiveAt(`${SID2}.jsonl`), archiveAt(`${SID2}.title.json`), agentAt(), agentAt(AGENT, SID, QP, '.meta.json')].sort(),
    );
  });
});

describe('classification and project', () => {
  test('a session, its title, its subagent thread and sidecar; an archived session alike', async () => {
    await write(mainAt(), body(sessionLines()));
    await write(archiveAt(`${SID2}.jsonl`), body(sessionLines({ sid: SID2 })));
    const s = new QwenFileSource(projects);
    expect(await s.classify(mainKey())).toEqual({ kind: 'session', projectId: PROJECT_ID, sessionId: SID });
    expect(await s.classify(`qwen:${QP}/chats/${SID}.title.json`)).toEqual({ kind: 'title', projectId: PROJECT_ID, sessionId: SID });
    expect(await s.classify(`qwen:${QP}/subagents/${SID}/agent-${AGENT}.jsonl`)).toEqual({ kind: 'agent', projectId: PROJECT_ID, sessionId: SID, agentId: AGENT });
    expect(await s.classify(`qwen:${QP}/subagents/${SID}/agent-${AGENT}.meta.json`)).toEqual({ kind: 'agent_meta', projectId: PROJECT_ID, sessionId: SID, agentId: AGENT });
    expect(await s.classify(mainKey(SID2))).toEqual({ kind: 'session', projectId: PROJECT_ID, sessionId: SID2 });
    expect(await s.classify(`qwen:${QP}/chats/${SID2}.title.json`)).toEqual({ kind: 'title', projectId: PROJECT_ID, sessionId: SID2 });
    expect(s.mainSessionOf(mainKey())).toBe(SID);
    expect(s.mainSessionOf(mainKey(SID2))).toBe(SID2);
    expect(s.mainSessionOf(`qwen:${QP}/subagents/${SID}/agent-${AGENT}.jsonl`)).toBeNull();
    expect(s.mainSessionOf(`qwen:${QP}/chats/${SID}.title.json`)).toBeNull();
    expect(s.projectOfKey(mainKey())).toBeNull();
    expect(s.projectOfTranscript(mainAt())).toBe(PROJECT_ID);
    expect(s.projectOfTranscript(agentAt())).toBe(PROJECT_ID);
  });

  test('project from the first valid record: invalid lines, other sessions’ records and a partial last line are passed over', async () => {
    const invalid = [
      'not json',
      '[1]',
      JSON.stringify({ cwd: '/wrong/no-uuid', type: 'user', sessionId: SID, parentUuid: null }),
      JSON.stringify({ uuid: 'u', parentUuid: 7, sessionId: SID, type: 'user', cwd: '/wrong/parent' }),
      JSON.stringify({ uuid: 'u', parentUuid: null, sessionId: SID, type: 'bogus', cwd: '/wrong/type' }),
      JSON.stringify({ uuid: 'u', parentUuid: null, sessionId: SID2, type: 'user', cwd: '/wrong/session' }),
      '',
    ];
    const s = new QwenFileSource(projects);
    await write(mainAt(), body(invalid));
    expect(await s.classify(mainKey())).toBeNull(); // not classifiable yet
    const good = sessionLines({ cwd: '/srv/real' });
    await fs.appendFile(mainAt(), good[0]!); // no newline yet: a partial line
    expect(await s.classify(mainKey())).toBeNull();
    expect(await s.classify(`qwen:${QP}/subagents/${SID}/agent-${AGENT}.jsonl`)).toBeNull(); // its session cannot be told yet
    await fs.appendFile(mainAt(), `\n${good[1]!}\n`);
    expect(await s.classify(mainKey())).toEqual({ kind: 'session', projectId: '-srv-real', sessionId: SID });
    expect(await s.classify(`qwen:${QP}/subagents/${SID}/agent-${AGENT}.jsonl`)).toMatchObject({ projectId: '-srv-real', sessionId: SID });
  });

  test('a session file that is missing or empty is not classified; a subagent file without its session is not either', async () => {
    const s = new QwenFileSource(projects);
    expect(await s.classify(mainKey())).toBeNull();
    await write(mainAt(), '');
    expect(await s.classify(mainKey())).toBeNull();
    await write(agentAt(), body(sessionLines()));
    expect(await s.classify(`qwen:${QP}/subagents/${SID2}/agent-${AGENT}.jsonl`)).toBeNull();
  });

  test('the class is taken from the stored raw events when there are any (nothing is read)', async () => {
    const lookup: QwenLookup = {
      storedFile: (key) => (key === mainKey() ? { sessionId: SID, agentId: null, projectId: '-stored-project' } : null),
      knownProjectIds: () => [],
    };
    const s = new QwenFileSource(projects, lookup);
    expect(await s.classify(mainKey())).toEqual({ kind: 'session', projectId: '-stored-project', sessionId: SID });
    expect(await s.classify(`qwen:${QP}/subagents/${SID}/agent-${AGENT}.jsonl`)).toMatchObject({ projectId: '-stored-project' });
    expect(s.mainSessionOf(mainKey())).toBe(SID);
  });

  test('qwenProjectDir: <repo>/.qwen/worktrees/<x>[/…] is <repo>, with either separator; anything else unchanged', () => {
    const cases: [string, string][] = [
      ['/home/u/repo/.qwen/worktrees/fix-1', '/home/u/repo'],
      ['/home/u/repo/.qwen/worktrees/fix-1/', '/home/u/repo'],
      ['/home/u/repo/.qwen/worktrees/fix-1/packages/a', '/home/u/repo'],
      ['C:\\work\\repo\\.qwen\\worktrees\\fix-1', 'C:\\work\\repo'],
      ['C:\\work\\repo\\.qwen\\worktrees\\fix-1\\src', 'C:\\work\\repo'],
      ['C:/work/repo/.qwen/worktrees/fix-1', 'C:/work/repo'],
      ['/.qwen/worktrees/x', '/'],
      ['C:\\.qwen\\worktrees\\x', 'C:\\'],
      ['/home/u/repo', '/home/u/repo'],
      ['/home/u/repo/.qwen/worktrees', '/home/u/repo/.qwen/worktrees'],
      ['/home/u/repo/.qwen/worktrees/', '/home/u/repo/.qwen/worktrees/'],
      ['/home/u/repo/.qwen/worktreesX/a', '/home/u/repo/.qwen/worktreesX/a'],
      ['/home/u/repo/qwen/worktrees/a', '/home/u/repo/qwen/worktrees/a'],
      ['/home/u/repo/.qwen/other/a', '/home/u/repo/.qwen/other/a'],
    ];
    for (const [cwd, want] of cases) expect(qwenProjectDir(cwd), cwd).toBe(want);
  });

  test('a session in a worktree belongs to the repository’s project ("/" and "\\")', async () => {
    await write(mainAt(SID), body(sessionLines({ sid: SID, cwd: '/home/u/app/.qwen/worktrees/fix-1' })));
    await write(mainAt(SID2, 'c--work-repo'), body(sessionLines({ sid: SID2, cwd: 'C:\\work\\repo\\.qwen\\worktrees\\fix-2\\pkg' })));
    const s = new QwenFileSource(projects);
    expect(await s.classify(mainKey(SID))).toMatchObject({ projectId: PROJECT_ID });
    expect(await s.classify(mainKey(SID2, 'c--work-repo'))).toMatchObject({ projectId: 'C--work-repo' });
  });

  test('the project directory name does not matter (Qwen Code lower-cases it on Windows): the records’ cwd does', async () => {
    // On Windows the two names are one directory; elsewhere two. Either way both sessions are in one project.
    await write(mainAt(SID, 'd--projects-foo'), body(sessionLines({ sid: SID, cwd: 'D:\\Projects\\Foo' })));
    await write(mainAt(SID2, 'D--Projects-Foo'), body(sessionLines({ sid: SID2, cwd: 'd:\\Projects\\Foo\\' })));
    const s = new QwenFileSource(projects);
    const keys = (await s.listFiles()).map((f) => s.keyOf(f)!);
    const classes = await Promise.all(keys.map((k) => s.classify(k)));
    expect(classes.map((c) => c!.projectId)).toEqual(['D--Projects-Foo', 'D--Projects-Foo']);
    expect(new Set(classes.map((c) => c!.sessionId))).toEqual(new Set([SID, SID2]));
  });
});

describe('managed sessions (spec 3.4; reference 4.6)', () => {
  for (const [name, head] of [
    ['header first', [managedHeader()]],
    ['header after a session_execution_engine record', [engineRecord(), managedHeader()]],
  ] as const) {
    test(`${name}: not read, counted once however often it is seen; its subagent files and title are not read`, async () => {
      await write(mainAt(), body([...head, ...sessionLines()]));
      await write(chatsAt(`${SID}.title.json`), '{}');
      await write(agentAt(), body(sessionLines()));
      await write(agentAt(AGENT, SID, QP, '.meta.json'), '{}');
      await write(mainAt(SID2), body(sessionLines({ sid: SID2 })));
      const s = new QwenFileSource(projects);
      for (let round = 0; round < 3; round++) {
        const files = await s.listFiles();
        const classes = await Promise.all(files.map((f) => s.classify(s.keyOf(f)!)));
        expect(classes.filter((c) => c !== null).map((c) => c!.sessionId)).toEqual([SID2]);
        expect(s.status()).toEqual({ unsupportedSessions: 1 });
      }
      expect(s.mainSessionOf(mainKey())).toBeNull();
    });
  }

  test('a session_execution_engine record alone does not decide: the next record does', async () => {
    await write(mainAt(), body([engineRecord()]));
    const s = new QwenFileSource(projects);
    expect(await s.classify(mainKey())).toBeNull();
    expect(s.status()).toEqual({ unsupportedSessions: 0 });
    await fs.appendFile(mainAt(), body(sessionLines()));
    expect(await s.classify(mainKey())).toEqual({ kind: 'session', projectId: PROJECT_ID, sessionId: SID });
    expect(s.status()).toEqual({ unsupportedSessions: 0 });
  });

  test('archived, it is still one session; deleted, it is no longer counted', async () => {
    await write(mainAt(), body([managedHeader()]));
    const s = new QwenFileSource(projects);
    expect(await s.classify(mainKey())).toBeNull();
    await fs.mkdir(path.dirname(archiveAt(`${SID}.jsonl`)), { recursive: true });
    await fs.rename(mainAt(), archiveAt(`${SID}.jsonl`));
    await s.listFiles();
    expect(await s.classify(mainKey())).toBeNull();
    expect(s.status()).toEqual({ unsupportedSessions: 1 });
    await fs.rm(archiveAt(`${SID}.jsonl`));
    await s.listFiles();
    expect(s.status()).toEqual({ unsupportedSessions: 0 });
  });

  test('only the first record decides (after one optional session_execution_engine record): a header later is plain, incrementally or read fresh', async () => {
    // Incremental: a plain session read, then a header line appended.
    await write(mainAt(), body(sessionLines()));
    const s = new QwenFileSource(projects);
    expect(await s.classify(mainKey())).toMatchObject({ projectId: PROJECT_ID });
    await fs.appendFile(mainAt(), body([managedHeader()]));
    expect(await s.classify(mainKey())).toMatchObject({ projectId: PROJECT_ID });
    expect(s.status()).toEqual({ unsupportedSessions: 0 });
    // Fresh: the same file read by a new source.
    const t = new QwenFileSource(projects);
    expect(await t.classify(mainKey())).toEqual({ kind: 'session', projectId: PROJECT_ID, sessionId: SID });
    expect(t.status()).toEqual({ unsupportedSessions: 0 });
    // Two engine records, then a header: the header is not the first record after one engine record.
    await write(mainAt(SID2), body([engineRecord(SID2), engineRecord(SID2), managedHeader(SID2), ...sessionLines({ sid: SID2 })]));
    expect(await t.classify(mainKey(SID2))).toMatchObject({ sessionId: SID2 });
    expect(t.status()).toEqual({ unsupportedSessions: 0 });
  });

  test('an over-long first record cannot be a managed header: the file is plain', async () => {
    const long = JSON.stringify({ note: 'x'.repeat(70 * 1024) });
    await write(mainAt(), body([long, managedHeader(), ...sessionLines()]));
    const s = new QwenFileSource(projects);
    expect(await s.classify(mainKey())).toEqual({ kind: 'session', projectId: PROJECT_ID, sessionId: SID });
    expect(s.status()).toEqual({ unsupportedSessions: 0 });
  });
});

describe('long lines (spec 3.3: no bound on the cwd search; 64 KiB per line)', () => {
  /** Bytes read through fs/promises handles of `file` (the head search's reads). */
  function countReads(file: string): { bytes: number } {
    const seen = { bytes: 0 };
    const real = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const handle = await real(...args);
      if (path.resolve(String(args[0])) === path.resolve(file)) {
        const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
        (handle as { read: unknown }).read = async (...a: unknown[]) => {
          const r = await read(...a);
          seen.bytes += r.bytesRead;
          return r;
        };
      }
      return handle;
    }) as typeof fs.open);
    return seen;
  }
  /** A first prompt of 100 KiB (as with `@`-referenced files), then a small reply. */
  function longFirst(messageFirst: boolean): string[] {
    const log = new Log();
    log.prompt(`look at this\n${'x'.repeat(100 * 1024)}`);
    log.add((env) => line('assistant', undefined, env, { message: { role: 'model', parts: [{ text: 'small reply' }] } }));
    if (!messageFirst) return log.lines;
    return log.lines.map((l) => {
      const { message, ...rest } = JSON.parse(l) as Record<string, unknown>;
      return JSON.stringify({ message, ...rest });
    });
  }

  for (const messageFirst of [false, true]) {
    test(`a 100 KiB first prompt then a small reply: classified from the reply (${messageFirst ? 'message first' : 'envelope first'}) and shown through the pipeline`, async () => {
      const lines = longFirst(messageFirst);
      expect(Buffer.byteLength(lines[0]!)).toBeGreaterThan(100 * 1024);
      await write(mainAt(), body(lines));
      const s = new QwenFileSource(projects);
      expect(await s.classify(mainKey())).toEqual({ kind: 'session', projectId: PROJECT_ID, sessionId: SID });
      const store = openStore(':memory:');
      stores.push(store);
      const config = cfg();
      const pipeline = new Pipeline(store, config, { sources: fileSources(config, store) });
      pipelines.push(pipeline);
      await pipeline.scanAll();
      await pipeline.idle();
      expect(pipeline.ingestFailures()).toEqual([]);
      expect(store.getSession(SID)).toMatchObject({ origin: 'qwen', projectId: PROJECT_ID });
      expect(store.rawForSessionAfter(SID, 0, 100).length).toBe(2);
    });
  }

  test('only over-long lines so far: null; classified once a short line arrives; nothing examined is read again', async () => {
    const lines = longFirst(false);
    const first = body([lines[0]!, lines[0]!]); // two over-long lines
    await write(mainAt(), first);
    const reads = countReads(mainAt());
    const s = new QwenFileSource(projects);
    expect(await s.classify(mainKey())).toBeNull();
    expect(reads.bytes).toBe(Buffer.byteLength(first));
    // Unchanged: nothing is read again.
    expect(await s.classify(mainKey())).toBeNull();
    expect(reads.bytes).toBe(Buffer.byteLength(first));
    // A partial over-long line: skipped as far as it goes, not read again later.
    const partial = `{"note":"${'y'.repeat(80 * 1024)}`;
    await fs.appendFile(mainAt(), partial);
    expect(await s.classify(mainKey())).toBeNull();
    const afterPartial = reads.bytes;
    expect(afterPartial).toBe(Buffer.byteLength(first) + Buffer.byteLength(partial));
    const tail = `"}\n${lines[1]!}\n`;
    await fs.appendFile(mainAt(), tail);
    expect(await s.classify(mainKey())).toEqual({ kind: 'session', projectId: PROJECT_ID, sessionId: SID });
    expect(reads.bytes - afterPartial).toBe(Buffer.byteLength(tail));
  });

  test('one attempt reads at most QWEN_SCAN_BUDGET bytes; the next goes on from there', async () => {
    const long = JSON.stringify({ note: 'z'.repeat(QWEN_SCAN_BUDGET + 1024) });
    const rest = sessionLines();
    await write(mainAt(), body([long, ...rest]));
    const reads = countReads(mainAt());
    const s = new QwenFileSource(projects);
    expect(await s.classify(mainKey())).toBeNull();
    expect(reads.bytes).toBeLessThanOrEqual(QWEN_SCAN_BUDGET);
    expect(await s.classify(mainKey())).toEqual({ kind: 'session', projectId: PROJECT_ID, sessionId: SID });
    expect(reads.bytes).toBeLessThanOrEqual(Buffer.byteLength(body([long, ...rest])));
    expect(reads.bytes).toBeGreaterThanOrEqual(Buffer.byteLength(body([long, rest[0]!])));
  });

  test('a file found shorter than where the search stopped is searched again from the start', async () => {
    await write(mainAt(), body([JSON.stringify({ note: 'x'.repeat(70 * 1024) })]));
    const s = new QwenFileSource(projects);
    expect(await s.classify(mainKey())).toBeNull();
    await write(mainAt(), body(sessionLines({ cwd: '/srv/again' })));
    expect(await s.classify(mainKey())).toMatchObject({ projectId: '-srv-again' });
  });
});

describe('fileSources', () => {
  test('created only when <qwenDir>/projects exists; nothing is created', async () => {
    expect(fileSources(cfg({ qwenDir: null })).some((s) => s.origin === 'qwen')).toBe(false);
    expect(fileSources(cfg()).some((s) => s.origin === 'qwen')).toBe(false); // <qwenDir> missing
    await expect(fs.stat(qwen)).rejects.toThrow();
    await fs.mkdir(qwen);
    expect(fileSources(cfg()).some((s) => s.origin === 'qwen')).toBe(false); // projects missing
    await expect(fs.stat(projects)).rejects.toThrow();
    await fs.mkdir(projects);
    const s = qwenOf(fileSources(cfg()));
    expect(s.rootDir).toBe(projects); // `projects` once, not twice
  });

  test('the same directory as a Claude Code session is one project (letter case aside)', async () => {
    const claudeDir = path.join(tmp, 'claude-projects', 'D--Work-App');
    await fs.mkdir(claudeDir, { recursive: true });
    await write(mainAt(SID, 'd--work-app'), body(sessionLines({ cwd: 'd:\\work\\app' })));
    await write(mainAt(SID2), body(sessionLines({ sid: SID2 })));
    await fs.mkdir(path.join(tmp, 'claude-projects', PROJECT_ID), { recursive: true });
    const store = openStore(':memory:');
    stores.push(store);
    const config = cfg();
    const pipeline = new Pipeline(store, config, { sources: fileSources(config, store) });
    pipelines.push(pipeline);
    await pipeline.scanAll();
    await pipeline.idle();
    expect(store.getSession(SID)?.projectId).toBe('D--Work-App');
    expect(store.getSession(SID2)?.projectId).toBe(PROJECT_ID);
  });

  test('shares the project-id resolver with CodeBuddy: one directory in two letter cases in the same first scan is one project', async () => {
    const cb = path.join(tmp, '.codebuddy');
    const cbSession = BUDDY_SID;
    const cbLines = exampleMain().lines.map((l) => l.split(JSON.stringify(BUDDY_CWD)).join(JSON.stringify('/home/u/APP')));
    await write(path.join(cb, 'projects', 'home-u-APP', `${cbSession}.jsonl`), body(cbLines));
    await write(mainAt(), body(sessionLines()));
    const store = openStore(':memory:');
    stores.push(store);
    const config = cfg({ codebuddyDir: cb });
    const pipeline = new Pipeline(store, config, { sources: fileSources(config, store) });
    pipelines.push(pipeline);
    await pipeline.scanAll();
    await pipeline.idle();
    const ids = [store.getSession(SID)?.projectId, store.getSession(cbSession)?.projectId];
    expect(ids[0]).toBeDefined();
    expect(ids[1]).toBeDefined();
    expect(ids[0]).toBe(ids[1]);
  });
});

test('the example session is classified (fixtures sanity)', async () => {
  await write(mainAt(), body(exampleSession().log.lines));
  const s = new QwenFileSource(projects);
  expect(await s.classify(mainKey())).toEqual({ kind: 'session', projectId: PROJECT_ID, sessionId: SID });
});
