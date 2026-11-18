import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { GraphEdge, GraphNode, GraphSnapshot, NodeDetail, Project, Session } from '@agent-canvas/shared';
import { AnomaliesService } from '../src/anomalies/service.js';
import { buildServer } from '../src/api/server.js';
import { fileSources } from '../src/cli.js';
import { loadConfig, type Config } from '../src/config.js';
import { qwenNodeId } from '../src/normalize/qwen.js';
import { Pipeline } from '../src/pipeline.js';
import { StatsService, storeStatsSource } from '../src/stats/service.js';
import { openStore, type Store } from '../src/store/store.js';
import { agentArgs, agentMeta, agentResultDisplay, agentThread, fcall, Log, SID, text, titleSidecar, turnResult, usageMeta } from './qwen-fixtures.js';

// Qwen Code end to end: files under a temp `<qwenDir>/projects`, the real fileSources + Pipeline, then the HTTP API.
// Archiving and unarchiving (one key, two places), deletion, message-group deletion (a file replaced in place), a file
// that cannot be opened, arrival order of subagent files and sidecars, and the order the scan lists files in.
// Every config names every tool directory.

const QP = 'home-u-app';
const PROJECT_ID = '-home-u-app';
const AGENT = 'Explore-call_b7';
const SID2 = 'a1b2c3d4-0000-4000-8000-000000000002';
const SID3 = 'a1b2c3d4-0000-4000-8000-000000000003';

let tmp: string;
let qwen: string;
let projects: string;
const stores: Store[] = [];
const pipelines: Pipeline[] = [];
const apps: FastifyInstance[] = [];

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-qwen-e2e-'));
  qwen = path.join(tmp, '.qwen');
  projects = path.join(qwen, 'projects');
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const a of apps.splice(0)) await a.close();
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
const mainAt = (sid = SID): string => path.join(projects, QP, 'chats', `${sid}.jsonl`);
const titleAt = (sid = SID): string => path.join(projects, QP, 'chats', `${sid}.title.json`);
const archivedMainAt = (sid = SID): string => path.join(projects, QP, 'chats', 'archive', `${sid}.jsonl`);
const archivedTitleAt = (sid = SID): string => path.join(projects, QP, 'chats', 'archive', `${sid}.title.json`);
const agentAt = (sid = SID): string => path.join(projects, QP, 'subagents', sid, `agent-${AGENT}.jsonl`);
const agentMetaAt = (sid = SID): string => path.join(projects, QP, 'subagents', sid, `agent-${AGENT}.meta.json`);
const mainKey = (sid = SID): string => `qwen:${QP}/chats/${sid}.jsonl`;
const cfg = (): Config =>
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
    codebuddyDir: null,
    doubaoDirs: [],
    qwenDir: qwen,
  });
const open = (): Store => {
  const s = openStore(':memory:');
  stores.push(s);
  return s;
};
const newPipeline = (store: Store, c: Config = cfg()): Pipeline => {
  const p = new Pipeline(store, c, { sources: fileSources(c, store) });
  pipelines.push(p);
  return p;
};
async function scan(p: Pipeline): Promise<void> {
  await p.scanAll();
  await p.idle();
}
function full(store: Store, sid: string) {
  const g = store.getGraph(sid);
  if (g === null) return null;
  const nodes: Record<string, GraphNode> = Object.fromEntries([...g.nodes].sort((a, b) => a.id.localeCompare(b.id)).map((n) => [n.id, n]));
  const edges: Record<string, GraphEdge> = Object.fromEntries([...g.edges].sort((a, b) => a.id.localeCompare(b.id)).map((e) => [e.id, e]));
  const details = Object.fromEntries(Object.keys(nodes).map((id) => [id, store.getNodeDetail(sid, id)]));
  return { session: g.session, nodes, edges, details };
}
const rawCount = (store: Store, sid = SID): number => store.rawForSessionAfter(sid, 0, 1_000_000).length;
const getJson = async <T>(app: FastifyInstance, url: string): Promise<T> => {
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode, url).toBe(200);
  return res.json() as T;
};

/** The parent session: a prompt; a reply delegating to an `agent` call; its result; a final reply; turn_result. */
function mainLog(sid = SID): { log: Log; ids: Record<string, string> } {
  const log = new Log({ sessionId: sid });
  const ids: Record<string, string> = {};
  ids.p1 = log.prompt('find the callers of uploadChunk');
  ids.a1 = log.reply([text('Delegating to an agent.'), fcall('agent', agentArgs('explore-type'), 'call_b7')], { usage: usageMeta(1000, 10) });
  ids.r1 = log.result('agent', 'One caller: src/a.ts:12.', { id: 'call_b7', resultDisplay: agentResultDisplay('Explore') });
  ids.a2 = log.reply([text('Found it.')]);
  ids.t1 = log.add((env) => turnResult('completed', env));
  return { log, ids };
}
const NM = (uuid: string, part: string, sid = SID): string => qwenNodeId(sid, null, uuid, part);
const agentLines = (): string[] => agentThread(AGENT).log.lines;
const metaBody = (): string => agentMeta({ agentId: AGENT, agentType: 'Explore', toolUseId: 'call_b7' });

async function writeSession(): Promise<{ log: Log; ids: Record<string, string> }> {
  const main = mainLog();
  await write(mainAt(), body(main.log.lines));
  await write(titleAt(), titleSidecar('Find the callers', 'manual'));
  await write(agentAt(), body(agentLines()));
  await write(agentMetaAt(), metaBody());
  return main;
}

/** The view of a fresh store that read the tree as it is now. */
async function fresh(sid = SID) {
  const s = open();
  await scan(newPipeline(s));
  return full(s, sid);
}

describe('Qwen Code end to end', () => {
  test('through the API: projects, sessions, graph, node detail, diagnostics', async () => {
    const main = await writeSession();
    // A managed session beside it: not shown, counted.
    await write(mainAt(SID3), `${JSON.stringify({ uuid: 'm', parentUuid: null, sessionId: SID3, type: 'system', subtype: 'managed_session_header_v1', cwd: '/home/u/app' })}\n`);
    const store = open();
    const config = cfg();
    const pipeline = newPipeline(store, config);
    await scan(pipeline);
    expect(pipeline.ingestFailures()).toEqual([]);
    const stats = new StatsService(storeStatsSource(store));
    const anomalies = new AnomaliesService(storeStatsSource(store), { answerWaitMs: 10_000, liveDelayMs: 0, liveCostFactor: 0 });
    const app = buildServer({ store, pipeline, config, stats, anomalies });
    apps.push(app);

    const projectsList = await getJson<Project[]>(app, '/api/projects');
    expect(projectsList.map((p) => [p.id, p.origins])).toEqual([[PROJECT_ID, ['qwen']]]);
    const sessions = await getJson<Session[]>(app, `/api/projects/${encodeURIComponent(PROJECT_ID)}/sessions`);
    expect(sessions.map((s) => [s.id, s.origin, s.title])).toEqual([[SID, 'qwen', 'Find the callers']]);

    const graph = await getJson<GraphSnapshot>(app, `/api/sessions/${SID}/graph`);
    const prompt = NM(main.ids.p1!, 'prompt');
    const call = NM(main.ids.a1!, 'call:call_b7');
    expect(graph.nodes.find((n) => n.id === prompt)).toMatchObject({ kind: 'prompt' });
    expect(graph.nodes.find((n) => n.id === call)).toMatchObject({ kind: 'subagent', childAgentId: AGENT, title: 'Explore' });
    expect(graph.nodes.some((n) => n.agentId === AGENT)).toBe(true);
    const detail = await getJson<NodeDetail>(app, `/api/sessions/${SID}/nodes/${encodeURIComponent(prompt)}`);
    expect(JSON.stringify(detail)).toContain('find the callers of uploadChunk');

    const diag = await getJson<{ sources: Record<string, Record<string, unknown>> }>(app, '/api/diagnostics');
    expect(diag.sources.qwen).toMatchObject({ dir: projects, present: true, reading: true, sessionCount: 1, unsupportedSessions: 1 });
    // A second scan counts the managed session once still.
    await scan(pipeline);
    expect((await getJson<{ sources: Record<string, Record<string, unknown>> }>(app, '/api/diagnostics')).sources.qwen).toMatchObject({ unsupportedSessions: 1 });
  });

  test('one-shot = line by line (agent first) = rebuild = restart', { timeout: 60_000 }, async () => {
    const main = await writeSession();
    const oneShot = (await fresh())!;
    expect(oneShot.session).toMatchObject({ origin: 'qwen', projectId: PROJECT_ID, cwd: '/home/u/app', title: 'Find the callers' });

    await fs.rm(projects, { recursive: true });
    await write(agentAt(), '');
    await write(mainAt(), '');
    const s = open();
    const p = newPipeline(s);
    await scan(p);
    for (const l of agentLines()) {
      await fs.appendFile(agentAt(), `${l}\n`);
      await p.ingestFile(agentAt());
    }
    for (const l of main.log.lines) {
      await fs.appendFile(mainAt(), `${l}\n`);
      await p.ingestFile(mainAt());
    }
    await write(agentMetaAt(), metaBody());
    await write(titleAt(), titleSidecar('Find the callers', 'manual'));
    await scan(p); // the agent file was not placeable before its session had a record
    expect(p.ingestFailures()).toEqual([]);
    expect(full(s, SID)).toEqual(oneShot);
    p.rebuild();
    expect(full(s, SID)).toEqual(oneShot);
    await scan(newPipeline(s));
    expect(full(s, SID)).toEqual(oneShot);
  });

  test('archive, append, unarchive: nothing read again, nothing duplicated, never source-deleted (also across a restart)', { timeout: 60_000 }, async () => {
    const main = await writeSession();
    const store = open();
    const p = newPipeline(store);
    await scan(p);
    const before = rawCount(store);
    const flag = (): boolean | undefined => store.getSession(SID)?.sourceDeleted;
    expect(flag()).toBe(false);

    // Archive: the file and its title move (rename keeps the content and the modification time).
    await fs.mkdir(path.dirname(archivedMainAt()), { recursive: true });
    await fs.rename(mainAt(), archivedMainAt());
    await fs.rename(titleAt(), archivedTitleAt());
    await p.ingestFile(archivedMainAt()); // the watcher's `add`
    await p.ingestFile(archivedTitleAt());
    await scan(p);
    expect(rawCount(store)).toBe(before);
    expect(flag()).toBe(false);
    expect(p.ingestFailures()).toEqual([]);

    // A restart while archived: the stored offset and guard hold for the archived file.
    const p2 = newPipeline(store);
    await scan(p2);
    expect(rawCount(store)).toBe(before);
    expect(flag()).toBe(false);

    // Appended while archived (a resumed session).
    main.log.prompt('one more question');
    main.log.reply([text('One more answer.')]);
    const appended = main.log.lines.slice(-2);
    await fs.appendFile(archivedMainAt(), body(appended));
    await p2.ingestFile(archivedMainAt());
    await scan(p2);
    expect(rawCount(store)).toBe(before + appended.length);

    // Unarchive.
    await fs.rename(archivedMainAt(), mainAt());
    await fs.rename(archivedTitleAt(), titleAt());
    await p2.ingestFile(mainAt());
    await p2.ingestFile(titleAt());
    await scan(p2);
    expect(rawCount(store)).toBe(before + appended.length);
    expect(flag()).toBe(false);
    expect(store.getMeta(`line-generation:${mainKey()}`) ?? '0').toBe('0');
    expect(p2.ingestFailures()).toEqual([]);
    const now = full(store, SID)!;
    expect(now).toEqual(await fresh());
    expect(JSON.stringify(now)).toContain('One more answer.');
  });

  test('both copies present: the chats/ one is read, an event for the archived one reads nothing', async () => {
    await writeSession();
    const store = open();
    const p = newPipeline(store);
    await scan(p);
    const before = full(store, SID);
    expect(before?.session.title).toBe('Find the callers');
    const count = rawCount(store);
    const other = mainLog();
    other.log.prompt('only in the stale archived copy');
    await write(archivedMainAt(), body(other.log.lines));
    await write(archivedTitleAt(), titleSidecar('Stale archived title', 'manual'));
    await p.ingestFile(archivedMainAt());
    await p.ingestFile(archivedTitleAt());
    await scan(p);
    expect(rawCount(store)).toBe(count);
    expect(full(store, SID)).toEqual(before);
    expect(JSON.stringify(full(store, SID))).not.toContain('only in the stale archived copy');
    expect(store.getSession(SID)?.title).toBe('Find the callers');
  });

  test('the main file deleted for real: source-deleted; back: not', async () => {
    await writeSession();
    const store = open();
    const p = newPipeline(store);
    await scan(p);
    const content = await fs.readFile(mainAt());
    await fs.rm(mainAt());
    await scan(p);
    expect(store.getSession(SID)?.sourceDeleted).toBe(true);
    await fs.writeFile(mainAt(), content);
    await scan(p);
    expect(store.getSession(SID)?.sourceDeleted).toBe(false);
  });

  /** Two turns; message-group deletion of the first: the second's prompt hangs off null (parentUuid repaired). */
  function twoTurns(): { all: string[]; kept: string[]; first: string[]; second: string[] } {
    const log = new Log();
    const first = [log.prompt('first question'), log.reply([text('First answer.')])];
    const second = [log.prompt('second question'), log.reply([text('Second answer.')])];
    const all = [...log.lines];
    const repaired = { ...(JSON.parse(all[2]!) as Record<string, unknown>), parentUuid: null };
    const kept = [JSON.stringify(repaired), all[3]!];
    return { all, kept, first, second };
  }

  for (const sameSize of [false, true]) {
    test(`message-group deletion, the file replaced by ${sameSize ? 'one of the same size' : 'a shorter one'}: the deleted nodes are gone, the rest as read fresh`, async () => {
      const t = twoTurns();
      await write(mainAt(), body(t.all));
      const store = open();
      const p = newPipeline(store);
      await scan(p);
      const before = full(store, SID)!;
      for (const u of [...t.first, ...t.second]) expect(Object.keys(before.nodes).some((id) => id.includes(`:${u}:`)), u).toBe(true);

      let kept = t.kept;
      const size = Buffer.byteLength(body(t.all));
      if (sameSize) {
        // JSON allows whitespace: pad the repaired prompt so the new file has exactly the old size.
        const pad = size - Buffer.byteLength(body(kept));
        kept = [`${kept[0]!.slice(0, -1)}${' '.repeat(pad)}}`, kept[1]!];
        expect(Buffer.byteLength(body(kept))).toBe(size);
      }
      // Replaced as the product does: a temp file renamed over the transcript.
      const temp = `${mainAt()}.tmp`;
      await fs.writeFile(temp, body(kept));
      await fs.rename(temp, mainAt());
      await p.ingestFile(mainAt()); // the watcher's `change`
      await scan(p);
      expect(p.ingestFailures()).toEqual([]);
      const after = full(store, SID)!;
      for (const u of t.first) expect(Object.keys(after.nodes).some((id) => id.includes(`:${u}:`)), u).toBe(false);
      for (const u of t.second) expect(Object.keys(after.nodes).some((id) => id.includes(`:${u}:`)), u).toBe(true);
      expect(after).toEqual(await fresh());
      expect(after.session?.sourceDeleted).toBe(false);
    });
  }

  for (const gone of ['moved to chats/archive/', 'deleted'] as const) {
    test(`the file ${gone} between the pipeline's stat and the read: the offset is kept, and a later deletion of the last group is still seen`, async () => {
      const t = twoTurns();
      const firstTurn = t.all.slice(0, 2);
      await write(mainAt(), body(firstTurn));
      const store = open();
      const p = newPipeline(store);
      await scan(p);
      // The second turn is appended; just before the reader opens the file it goes away.
      await fs.appendFile(mainAt(), body(t.all.slice(2)));
      const real = fs.open.bind(fs);
      let armed = true;
      vi.spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
        if (armed && path.resolve(String(args[0])) === path.resolve(mainAt())) {
          armed = false;
          if (gone === 'deleted') await fs.rm(mainAt());
          else {
            await fs.mkdir(path.dirname(archivedMainAt()), { recursive: true });
            await fs.rename(mainAt(), archivedMainAt());
          }
        }
        return real(...args);
      }) as typeof fs.open);
      await p.ingestFile(mainAt());
      await p.idle();
      expect(armed).toBe(false);
      const fullSize = Buffer.byteLength(body(t.all));
      // Moved: read at its new place. Deleted: nothing read, the offset kept (not reset to 0).
      expect(store.getOffset(mainKey())).toBe(gone === 'deleted' ? Buffer.byteLength(body(firstTurn)) : fullSize);
      // The last message group is deleted (the file is replaced by its first turn), wherever the file now is.
      const at = gone === 'deleted' ? mainAt() : archivedMainAt();
      await write(at, body(firstTurn));
      await p.ingestFile(at);
      await scan(p);
      expect(p.ingestFailures()).toEqual([]);
      const after = full(store, SID)!;
      for (const u of t.second) expect(Object.keys(after.nodes).some((id) => id.includes(`:${u}:`)), u).toBe(false);
      expect(after).toEqual(await fresh());
    });
  }

  test('a file that cannot be opened is not a rewrite: no new generation, the next scan reads the appended lines', async () => {
    const main = await writeSession();
    const store = open();
    const p = newPipeline(store);
    await scan(p);
    const before = full(store, SID)!;
    main.log.prompt('more after a busy moment');
    await fs.appendFile(mainAt(), body(main.log.lines.slice(-1)));
    const real = fs.open.bind(fs);
    let failed = false;
    vi.spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      if (!failed && path.resolve(String(args[0])) === path.resolve(mainAt())) {
        failed = true;
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return real(...args);
    }) as typeof fs.open);
    await scan(p);
    expect(failed).toBe(true);
    expect(store.getMeta(`line-generation:${mainKey()}`) ?? '0').toBe('0');
    expect(p.ingestFailures().map((f) => f.error).join()).toContain('EBUSY');
    expect(full(store, SID)!.nodes).toEqual(before.nodes);
    await p.rescan();
    await p.idle();
    expect(p.ingestFailures()).toEqual([]);
    expect(store.getMeta(`line-generation:${mainKey()}`) ?? '0').toBe('0');
    const after = full(store, SID)!;
    expect(JSON.stringify(after)).toContain('more after a busy moment');
    for (const id of Object.keys(before.nodes)) expect(after.nodes[id], id).toBeDefined();
  });

  test('subagent files and sidecars arriving in either order end in the same graph', { timeout: 60_000 }, async () => {
    await writeSession();
    const want = (await fresh())!;
    expect(want.session).toMatchObject({ title: 'Find the callers', projectId: PROJECT_ID });
    const parts: [string, string][] = [
      [mainAt(), await fs.readFile(mainAt(), 'utf8')],
      [titleAt(), await fs.readFile(titleAt(), 'utf8')],
      [agentAt(), await fs.readFile(agentAt(), 'utf8')],
      [agentMetaAt(), await fs.readFile(agentMetaAt(), 'utf8')],
    ];
    for (const order of [
      [2, 3, 0, 1],
      [3, 1, 2, 0],
      [0, 3, 1, 2],
      [1, 0, 3, 2],
    ]) {
      await fs.rm(projects, { recursive: true, force: true });
      await fs.mkdir(projects, { recursive: true }); // before the source is made: it exists only for an existing directory
      const store = open();
      const p = newPipeline(store);
      for (const i of order) {
        const [file, content] = parts[i]!;
        await write(file, content);
        await p.ingestFile(file);
        await scan(p);
      }
      expect(p.ingestFailures(), order.join()).toEqual([]);
      expect(full(store, SID), order.join()).toEqual(want);
    }
  });

  test('the same tree listed in ascending and in descending order gives the same result', { timeout: 60_000 }, async () => {
    await writeSession();
    // An archived session with a title, a session in both places, a managed one.
    const second = mainLog(SID2);
    await write(archivedMainAt(SID2), body(second.log.lines));
    await write(archivedTitleAt(SID2), titleSidecar('Archived one', 'manual'));
    await write(path.join(projects, QP, 'subagents', SID2, `agent-${AGENT}.jsonl`), body(agentThread(AGENT).log.lines.map((l) => l.split(SID).join(SID2))));
    await write(mainAt(SID3), body(mainLog(SID3).log.lines));
    const stale = mainLog(SID3);
    stale.log.prompt('stale');
    await write(archivedMainAt(SID3), body(stale.log.lines));
    const managed = 'a1b2c3d4-0000-4000-8000-000000000004';
    await write(mainAt(managed), `${JSON.stringify({ uuid: 'm', parentUuid: null, sessionId: managed, type: 'system', subtype: 'managed_session_header_v1', cwd: '/home/u/app' })}\n`);
    await write(path.join(projects, QP, 'subagents', managed, `agent-${AGENT}.jsonl`), body(agentLines()));

    const results = [];
    for (const dir of ['asc', 'desc'] as const) {
      const store = open();
      const p = newPipeline(store);
      const real = p.listFiles.bind(p);
      vi.spyOn(p, 'listFiles').mockImplementation(async () => {
        const files = await real();
        return dir === 'asc' ? files : [...files].reverse();
      });
      await scan(p);
      await scan(p);
      expect(p.ingestFailures()).toEqual([]);
      const diag = p.fileSources().find((s) => s.origin === 'qwen')!.status!();
      results.push({
        views: [SID, SID2, SID3, managed].map((sid) => full(store, sid)),
        raw: [SID, SID2, SID3, managed].map((sid) => rawCount(store, sid)),
        diag,
      });
    }
    expect(results[0]!.views[3]).toBeNull();
    expect(results[0]!.diag).toEqual({ unsupportedSessions: 1 });
    expect(JSON.stringify(results[0]!.views[2])).not.toContain('stale');
    expect(results[1]).toEqual(results[0]);
  });
});
