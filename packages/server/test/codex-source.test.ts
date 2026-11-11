import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CODEX_INDEX_KEY, CodexFileSource, type CodexLookup } from '../src/sources/codex/source.js';
import { isPromise, originOfKey, type FileClass } from '../src/sources/source.js';
import { indexLine, rollout, rolloutRel, sessionMetaLine, taskStarted } from './codex-rollout.js';

const ROOT = '019a0000-0000-7000-8000-00000000000a';
const SUB = '019a0000-0000-7000-8000-00000000000b';
const OTHER = '019a0000-0000-7000-8000-00000000000c';
const CWD = path.join(path.sep === '\\' ? 'D:\\' : '/', 'work', 'app');
const PROJECT = CWD.replace(/[^A-Za-z0-9]/g, '-');
const WORKTREE = path.join(CWD, '.worktrees', 'helper');

let tmp: string;
let dir: string;
const abs = (rel: string): string => path.join(dir, ...rel.split('/'));
async function writeRel(rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
  await fs.writeFile(abs(rel), content);
}
const key = (rel: string): string => `codex:${rel}`;
async function classify(source: CodexFileSource, k: string): Promise<FileClass | null> {
  const c = source.classify(k);
  return isPromise(c) ? await c : c;
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-codex-source-'));
  dir = path.join(tmp, 'sessions');
  await fs.mkdir(dir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

describe('CodexFileSource：文件和键', () => {
  test('origin、根目录、监视深度 4', () => {
    const s = new CodexFileSource(dir);
    expect(s.origin).toBe('codex');
    expect(s.rootDir).toBe(dir);
    expect(s.watchDepth).toBe(4);
    expect(s.indexFiles()).toEqual([path.join(tmp, 'session_index.jsonl')]);
  });

  test('键是 codex: 加相对路径（/ 分隔）；索引文件的键是 codex:../session_index.jsonl；其他路径没有键', () => {
    const s = new CodexFileSource(dir);
    const rel = rolloutRel(ROOT);
    expect(s.keyOf(abs(rel))).toBe(`codex:${rel}`);
    expect(originOfKey(s.keyOf(abs(rel))!)).toBe('codex');
    expect(s.pathOf(`codex:${rel}`)).toBe(abs(rel));
    expect(s.keyOf(path.join(tmp, 'session_index.jsonl'))).toBe(CODEX_INDEX_KEY);
    expect(CODEX_INDEX_KEY).toBe('codex:../session_index.jsonl');
    expect(s.pathOf(CODEX_INDEX_KEY)).toBe(path.join(tmp, 'session_index.jsonl'));
    expect(s.keyOf(abs('2026/11/11/notes.txt'))).toBeNull();
    expect(s.keyOf(abs('2026/11/11/other.jsonl'))).toBeNull();
    expect(s.keyOf(dir)).toBeNull();
    expect(s.keyOf(path.join(tmp, 'config.toml'))).toBeNull();
    expect(s.keyOf(path.join(tmp, 'archived_sessions', 'rollout-x.jsonl'))).toBeNull();
    expect(s.pathOf('proj/s1.jsonl')).toBeNull();
    expect(s.pathOf(`codex:index/${ROOT}`)).toBeNull();
  });

  test('listFiles：年/月/日下的 rollout 文件和存在的索引文件，排序；目录不存在时为空', async () => {
    const s = new CodexFileSource(dir);
    expect(await s.listFiles()).toEqual([]);
    await writeRel(rolloutRel(SUB, '2026/11/12'), '');
    await writeRel(rolloutRel(ROOT), '');
    await writeRel('2026/11/11/notes.txt', '');
    expect(await s.listFiles()).toEqual([abs(rolloutRel(ROOT)), abs(rolloutRel(SUB, '2026/11/12'))]);
    await fs.writeFile(path.join(tmp, 'session_index.jsonl'), '');
    expect(await s.listFiles()).toEqual(
      [abs(rolloutRel(ROOT)), abs(rolloutRel(SUB, '2026/11/12')), path.join(tmp, 'session_index.jsonl')].sort(),
    );
    expect(await new CodexFileSource(path.join(tmp, 'missing')).listFiles()).toEqual([]);
  });
});

describe('CodexFileSource：按第一行归类', () => {
  test('主线程：session，会话 id = 线程 id，项目 = cwd 的编码', async () => {
    await writeRel(rolloutRel(ROOT), rollout(sessionMetaLine({ id: ROOT, cwd: CWD }), taskStarted('t1')));
    const s = new CodexFileSource(dir);
    expect(await classify(s, key(rolloutRel(ROOT)))).toEqual({ kind: 'session', projectId: PROJECT, sessionId: ROOT });
    expect(s.mainSessionOf(key(rolloutRel(ROOT)))).toBe(ROOT);
  });

  test('子代理线程：agent，会话 id = session_id（根线程），agentId = 自己的线程 id；项目取根线程的', async () => {
    await writeRel(rolloutRel(ROOT), rollout(sessionMetaLine({ id: ROOT, cwd: CWD })));
    await writeRel(rolloutRel(SUB), rollout(sessionMetaLine({ id: SUB, sessionId: ROOT, parent: ROOT, cwd: WORKTREE })));
    const s = new CodexFileSource(dir);
    await classify(s, key(rolloutRel(ROOT)));
    expect(await classify(s, key(rolloutRel(SUB)))).toEqual({ kind: 'agent', projectId: PROJECT, sessionId: ROOT, agentId: SUB });
    expect(s.mainSessionOf(key(rolloutRel(SUB)))).toBeNull();
  });

  test('子代理线程先于根线程被读到：会话和线程照样正确，项目用它自己的 cwd', async () => {
    await writeRel(rolloutRel(ROOT), rollout(sessionMetaLine({ id: ROOT, cwd: CWD })));
    await writeRel(rolloutRel(SUB), rollout(sessionMetaLine({ id: SUB, sessionId: ROOT, parent: ROOT, cwd: WORKTREE })));
    const s = new CodexFileSource(dir);
    expect(await classify(s, key(rolloutRel(SUB)))).toEqual({
      kind: 'agent',
      projectId: WORKTREE.replace(/[^A-Za-z0-9]/g, '-'),
      sessionId: ROOT,
      agentId: SUB,
    });
    expect(await classify(s, key(rolloutRel(ROOT)))).toEqual({ kind: 'session', projectId: PROJECT, sessionId: ROOT });
  });

  test('归类按文件缓存：第二次同步返回，不再读文件', async () => {
    await writeRel(rolloutRel(ROOT), rollout(sessionMetaLine({ id: ROOT, cwd: CWD })));
    const s = new CodexFileSource(dir);
    const first = await classify(s, key(rolloutRel(ROOT)));
    await fs.writeFile(abs(rolloutRel(ROOT)), 'garbage\n'); // a re-read would fail now
    const again = s.classify(key(rolloutRel(ROOT)));
    expect(isPromise(again)).toBe(false);
    expect(again).toEqual(first);
  });

  test.each([
    ['空文件', '', /first line missing/],
    ['第一行还没写完', sessionMetaLine({ id: ROOT, cwd: CWD }).slice(0, 40), /first line incomplete/],
    ['第一行不是 JSON', 'not json\n', /first line is not JSON/],
    ['第一行不是 session_meta', `${taskStarted('t1')}\n`, /first line is not session_meta \(type: event_msg\)/],
    ['session_meta 没有 id', `${JSON.stringify({ type: 'session_meta', payload: { cwd: CWD } })}\n`, /session_meta without an id/],
  ])('无效的第一行（%s）：抛出可报告的错误；变成有效后能归类', async (_name, body, error) => {
    await writeRel(rolloutRel(ROOT), body);
    const s = new CodexFileSource(dir);
    await expect(classify(s, key(rolloutRel(ROOT)))).rejects.toThrow(error);
    await fs.writeFile(abs(rolloutRel(ROOT)), rollout(sessionMetaLine({ id: ROOT, cwd: CWD })));
    expect(await classify(s, key(rolloutRel(ROOT)))).toEqual({ kind: 'session', projectId: PROJECT, sessionId: ROOT });
  });

  test('错误信息不带文件内容', async () => {
    await writeRel(rolloutRel(ROOT), 'secret-content-here\n');
    const s = new CodexFileSource(dir);
    const err = await Promise.resolve(classify(s, key(rolloutRel(ROOT)))).catch((e: unknown) => e as Error);
    expect(String((err as Error).message)).not.toContain('secret');
  });

  test('不存在的文件（且没有存档记录）不归类', async () => {
    const s = new CodexFileSource(dir);
    expect(await classify(s, key(rolloutRel(ROOT)))).toBeNull();
    expect(s.mainSessionOf(key(rolloutRel(ROOT)))).toBeNull();
  });

  test('索引文件归为 index；条目键和其他键不归类', async () => {
    const s = new CodexFileSource(dir);
    expect(await classify(s, CODEX_INDEX_KEY)).toMatchObject({ kind: 'index' });
    expect(s.mainSessionOf(CODEX_INDEX_KEY)).toBeNull();
    expect(await classify(s, `codex:index/${ROOT}`)).toBeNull();
  });

  test('projectOfKey 永远是 null（项目随原始事件保存）；projectOfTranscript 用已知的归类，不读文件', async () => {
    await writeRel(rolloutRel(ROOT), rollout(sessionMetaLine({ id: ROOT, cwd: CWD })));
    const s = new CodexFileSource(dir);
    expect(s.projectOfKey(key(rolloutRel(ROOT)))).toBeNull();
    expect(s.projectOfTranscript(abs(rolloutRel(ROOT)))).toBeNull(); // not classified yet, nothing stored
    await classify(s, key(rolloutRel(ROOT)));
    expect(s.projectOfTranscript(abs(rolloutRel(ROOT)))).toBe(PROJECT);
    expect(s.projectOfTranscript(path.join(tmp, 'elsewhere.jsonl'))).toBeNull();
  });
});

describe('CodexFileSource：已存档的文件和项目 id', () => {
  const lookup = (stored: Record<string, { sessionId: string; agentId: string | null; projectId: string | null }>, projects: string[] = []): CodexLookup & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      storedFile: (k) => {
        calls.push(k);
        return stored[k] ?? null;
      },
      knownProjectIds: () => projects,
    };
  };

  test('已经不存在的文件：从存档的原始事件得到会话、线程和项目（主文件、projectOfTranscript、归类）', async () => {
    const l = lookup({
      [key(rolloutRel(ROOT))]: { sessionId: ROOT, agentId: null, projectId: PROJECT },
      [key(rolloutRel(SUB))]: { sessionId: ROOT, agentId: SUB, projectId: PROJECT },
    });
    const s = new CodexFileSource(dir, l);
    expect(s.mainSessionOf(key(rolloutRel(ROOT)))).toBe(ROOT);
    expect(s.mainSessionOf(key(rolloutRel(SUB)))).toBeNull();
    const c = s.classify(key(rolloutRel(SUB)));
    expect(isPromise(c)).toBe(false); // stored: no read
    expect(c).toEqual({ kind: 'agent', projectId: PROJECT, sessionId: ROOT, agentId: SUB });
    expect(s.projectOfTranscript(abs(rolloutRel(ROOT)))).toBe(PROJECT);
  });

  test('存档优先于第一行：重建 / 重启后项目 id 不变', async () => {
    // Stored with the worktree's project (the root was not known when it was first read); the root is known now.
    await writeRel(rolloutRel(ROOT), rollout(sessionMetaLine({ id: ROOT, cwd: CWD })));
    await writeRel(rolloutRel(SUB), rollout(sessionMetaLine({ id: SUB, sessionId: ROOT, parent: ROOT, cwd: WORKTREE })));
    const stale = WORKTREE.replace(/[^A-Za-z0-9]/g, '-');
    const s = new CodexFileSource(dir, lookup({ [key(rolloutRel(SUB))]: { sessionId: ROOT, agentId: SUB, projectId: stale } }));
    await classify(s, key(rolloutRel(ROOT)));
    expect(await classify(s, key(rolloutRel(SUB)))).toEqual({ kind: 'agent', projectId: stale, sessionId: ROOT, agentId: SUB });
  });

  test('只是大小写不同的已有项目 id 被沿用（Windows 盘符）；两个 Codex 会话之间也一致', async () => {
    const upper = 'D--work-app';
    const A = '019a0000-0000-7000-8000-0000000000a1';
    const B = '019a0000-0000-7000-8000-0000000000b1';
    await writeRel(rolloutRel(A), rollout(sessionMetaLine({ id: A, cwd: 'd:\\work\\app' })));
    await writeRel(rolloutRel(B), rollout(sessionMetaLine({ id: B, cwd: 'd:/WORK/app' })));
    const s = new CodexFileSource(dir, lookup({}, [upper]));
    expect(await classify(s, key(rolloutRel(A)))).toMatchObject({ projectId: upper });
    expect(await classify(s, key(rolloutRel(B)))).toMatchObject({ projectId: upper });

    const fresh = new CodexFileSource(dir);
    expect(await classify(fresh, key(rolloutRel(A)))).toMatchObject({ projectId: 'd--work-app' });
    expect(await classify(fresh, key(rolloutRel(B)))).toMatchObject({ projectId: 'd--work-app' });
  });
});

describe('CodexFileSource：会话索引', () => {
  test('每个已见过的根线程一条（最后一行为准）；未知或子代理线程的行跳过；无效行跳过', async () => {
    await writeRel(rolloutRel(ROOT), rollout(sessionMetaLine({ id: ROOT, cwd: CWD })));
    await writeRel(rolloutRel(SUB), rollout(sessionMetaLine({ id: SUB, sessionId: ROOT, parent: ROOT, cwd: CWD })));
    const s = new CodexFileSource(dir);
    const v0 = s.indexVersion();
    await classify(s, key(rolloutRel(ROOT)));
    await classify(s, key(rolloutRel(SUB)));
    const v1 = s.indexVersion();
    expect(v1).not.toBe(v0);
    const content = [
      indexLine(ROOT, 'old title'),
      indexLine(SUB, 'helper'),
      indexLine(OTHER, 'unknown thread'),
      'not json',
      JSON.stringify({ thread_name: 'no id' }),
      indexLine(ROOT, 'new title'),
      '',
    ].join('\n');
    expect(s.indexEntries(CODEX_INDEX_KEY, content)).toEqual([
      { key: `codex:index/${ROOT}`, sessionId: ROOT, agentId: null, projectId: PROJECT, payload: indexLine(ROOT, 'new title') },
    ]);

    // OTHER turns out to be a root thread: the version changes and its entry is placed.
    await writeRel(rolloutRel(OTHER), rollout(sessionMetaLine({ id: OTHER, cwd: CWD })));
    await classify(s, key(rolloutRel(OTHER)));
    expect(s.indexVersion()).not.toBe(v1);
    expect(s.indexEntries(CODEX_INDEX_KEY, content).map((e) => e.sessionId)).toEqual([ROOT, OTHER]);
    // A second classification of a known root does not change the version.
    const v2 = s.indexVersion();
    await classify(s, key(rolloutRel(OTHER)));
    expect(s.indexVersion()).toBe(v2);
  });

  test('CRLF 行尾的索引行去掉 \\r', async () => {
    await writeRel(rolloutRel(ROOT), rollout(sessionMetaLine({ id: ROOT, cwd: CWD })));
    const s = new CodexFileSource(dir);
    await classify(s, key(rolloutRel(ROOT)));
    expect(s.indexEntries(CODEX_INDEX_KEY, `${indexLine(ROOT, 't')}\r\n`)[0]!.payload).toBe(indexLine(ROOT, 't'));
  });
});
