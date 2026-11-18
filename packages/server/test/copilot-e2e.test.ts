import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GraphEdge, GraphNode, GraphSnapshot } from '@agent-canvas/shared';
import { fileSources } from '../src/cli.js';
import { loadConfig, type Config } from '../src/config.js';
import { copilotNodeId } from '../src/normalize/copilot.js';
import { Pipeline } from '../src/pipeline.js';
import { COPILOT_FIRST_LINE_MAX_BYTES, CopilotFileSource, copilotIo } from '../src/sources/copilot/source.js';
import { openStore, type Store } from '../src/store/store.js';
import { CWD, E, ev, EVENTS_REL, exampleLines, PROJECT, SID, startLine, WORKSPACE_REL, WORKSPACE_YAML } from './copilot-fixtures.js';

// Pipeline + store on temp directories: a Copilot CLI root (`<copilotDir>/session-state`) with one session directory.

let tmp: string;
let config: Config;
let copilotDir: string;
let stateDir: string;
const stores: Store[] = [];

const abs = (rel: string): string => path.join(stateDir, ...rel.split('/'));
async function writeRel(rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
  await fs.writeFile(abs(rel), content);
}
const body = (ls: string[]): string => ls.map((l) => `${l}\n`).join('');
const open = (): Store => {
  const s = openStore(':memory:');
  stores.push(s);
  return s;
};
const newPipeline = (store: Store, c: Config = config): Pipeline => new Pipeline(store, c, { sources: fileSources(c, store) });
const cfg = (dir: string | null): Config =>
  loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, deepseekDir: null, workbuddyDirs: [], codebuddyDir: null, doubaoDirs: [], geminiDir: null, grokDir: null, copilotDir: dir });
function view(store: Store, sessionId: string) {
  const g: GraphSnapshot | null = store.getGraph(sessionId);
  if (g === null) return null;
  const nodes: Record<string, GraphNode> = Object.fromEntries([...g.nodes].sort((a, b) => a.id.localeCompare(b.id)).map((n) => [n.id, n]));
  const edges: Record<string, GraphEdge> = Object.fromEntries([...g.edges].sort((a, b) => a.id.localeCompare(b.id)).map((e) => [e.id, e]));
  return { session: g.session, nodes, edges };
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-copilot-e2e-'));
  copilotDir = path.join(tmp, '.copilot');
  stateDir = path.join(copilotDir, 'session-state');
  await fs.mkdir(stateDir, { recursive: true });
  config = cfg(copilotDir);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) s.close();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

describe('GitHub Copilot CLI end to end', () => {
  test('fileSources: a CopilotFileSource only when <copilotDir>/session-state exists; nothing is created otherwise', async () => {
    expect(fileSources(config).some((s) => s instanceof CopilotFileSource)).toBe(true);
    const bare = path.join(tmp, 'bare-copilot');
    await fs.mkdir(bare);
    const c2 = cfg(bare);
    const store = open();
    const p = newPipeline(store, c2);
    expect(p.fileSources().map((s) => s.origin)).toEqual(['claude']);
    await p.scanAll();
    await p.idle();
    expect(await fs.readdir(bare)).toEqual([]);
    expect(fileSources(cfg(null)).map((s) => s.origin)).toEqual(['claude']);
    expect(fileSources(cfg(path.join(tmp, 'missing'))).map((s) => s.origin)).toEqual(['claude']);
  });

  test('one-shot ingest = line-by-line appended ingest = rebuild from raw events; restart re-ingests nothing', async () => {
    await writeRel(EVENTS_REL, body(exampleLines()));
    await writeRel(WORKSPACE_REL, WORKSPACE_YAML);
    const s1 = open();
    const p1 = newPipeline(s1);
    await p1.scanAll();
    await p1.idle();
    expect(p1.ingestFailures()).toEqual([]);
    expect(s1.diagnostics().unknownRecords).toEqual([]);
    const oneShot = view(s1, SID)!;
    expect(oneShot.session).toMatchObject({ origin: 'copilot', projectId: PROJECT, cwd: CWD, title: 'Fix README typo', status: 'ended', gitBranch: 'main' });
    expect(Object.keys(oneShot.nodes)).toHaveLength(8);
    expect(s1.listProjects(Date.now()).map((x) => [x.id, x.cwd, x.origins])).toEqual([[PROJECT, CWD, ['copilot']]]);

    // Line by line (the workspace written after the first record).
    await fs.rm(abs(EVENTS_REL));
    await fs.rm(abs(WORKSPACE_REL));
    const s2 = open();
    const p2 = newPipeline(s2);
    await p2.scanAll();
    let text = '';
    for (const [i, line] of exampleLines().entries()) {
      text += `${line}\n`;
      await writeRel(EVENTS_REL, text);
      await p2.ingestFile(abs(EVENTS_REL));
      if (i === 1) {
        await writeRel(WORKSPACE_REL, WORKSPACE_YAML);
        await p2.ingestFile(abs(WORKSPACE_REL));
      }
    }
    await p2.idle();
    expect(p2.ingestFailures()).toEqual([]);
    expect(view(s2, SID)).toEqual(oneShot);

    p1.rebuild();
    expect(view(s1, SID)).toEqual(oneShot);
    p2.rebuild();
    expect(view(s2, SID)).toEqual(oneShot);
    const again = newPipeline(s2);
    await again.scanAll();
    await again.idle();
    expect(view(s2, SID)).toEqual(oneShot);
  });

  test('Review Focus 1: the file replaced by a shorter one (two lines dropped, the rest kept): no duplicates, survivors unchanged', async () => {
    const lines = exampleLines();
    await writeRel(EVENTS_REL, body(lines));
    const store = open();
    const p = newPipeline(store);
    await p.scanAll();
    await p.idle();
    const before = view(store, SID)!;

    // Copilot's transcript recovery rewrites the file: here the thinking line and the final text line are gone, and two
    // surviving events come back serialized differently (other key order: new raw lines for the store, same event ids).
    const reserialize = (l: string): string => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(l) as object).reverse()));
    const kept = lines.filter((_, i) => i !== 3 && i !== 9).map((l, i) => (i === 1 || i === 4 ? reserialize(l) : l));
    await writeRel(EVENTS_REL, body(kept));
    await p.ingestFile(abs(EVENTS_REL));
    await p.idle();
    const after = view(store, SID)!;
    expect(Object.keys(after.nodes)).toEqual(Object.keys(before.nodes));
    expect(after).toEqual(before); // survivors unchanged; the dropped lines' nodes stay (their raw events stay too)
    // The stored offset follows the new file: an appended record continues the chain once.
    await fs.appendFile(abs(EVENTS_REL), `${ev('user.message', { content: 'after the rewrite' }, { at: '2026-11-12T00:00:00.000Z', id: 'post-1' })}\n`);
    await p.ingestFile(abs(EVENTS_REL));
    await p.idle();
    const grown = view(store, SID)!;
    expect(Object.keys(grown.nodes)).toHaveLength(Object.keys(before.nodes).length + 1);
    expect(grown.nodes[copilotNodeId(SID, 'post-1')]).toMatchObject({ parentId: copilotNodeId(SID, E(16)), kind: 'prompt' });
    // A rebuild from the raw events gives the same.
    p.rebuild();
    expect(view(store, SID)).toEqual(grown);
    // A rewrite that moves session.start (same lines, other order) adds nothing either.
    const moved = [...kept.slice(1, 4), kept[0]!, ...kept.slice(4)]; // without the appended line: shorter again
    await writeRel(EVENTS_REL, body(moved));
    await p.ingestFile(abs(EVENTS_REL));
    await p.idle();
    expect(view(store, SID)).toEqual(grown);
  });

  test('Review Focus 4: a 5 MB events.jsonl is ingested with classify reading only the bounded first-line window', async () => {
    const lines: string[] = [startLine()];
    const pad = 'z'.repeat(60_000); // few, large events: the size is what is tested, not the event count
    for (let i = 0; lines.join('\n').length < 5 * 1024 * 1024 && i < 10_000; i++) {
      lines.push(ev('user.message', { content: `step ${i}` }, { at: '2026-11-12T08:00:01.000Z', id: `u${i}` }));
      lines.push(ev('tool.execution_start', { toolCallId: `c${i}`, toolName: 'view', arguments: { path: `/w/f${i}.ts` } }, { at: '2026-11-12T08:00:02.000Z', id: `s${i}` }));
      lines.push(ev('tool.execution_complete', { toolCallId: `c${i}`, success: true, result: { content: pad } }, { at: '2026-11-12T08:00:03.000Z', id: `d${i}` }));
    }
    const text = body(lines);
    expect(Buffer.byteLength(text)).toBeGreaterThan(5 * 1024 * 1024);
    await writeRel(EVENTS_REL, text);
    const read = vi.spyOn(copilotIo, 'readFirstLine');
    const store = open();
    const p = newPipeline(store);
    await p.scanAll();
    await p.idle();
    expect(p.ingestFailures()).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![1]).toBeLessThanOrEqual(COPILOT_FIRST_LINE_MAX_BYTES);
    expect((await read.mock.results[0]!.value).bytesRead).toBeLessThanOrEqual(COPILOT_FIRST_LINE_MAX_BYTES);
    expect(store.getGraph(SID)!.nodes).toHaveLength(((lines.length - 1) / 3) * 2);
    expect(store.getSession(SID)).toMatchObject({ projectId: PROJECT });
  }, 60_000);

  test('I-4: two shutdowns (100 then 250): stats total 250, one-shot = appended = rebuild', async () => {
    const sd = (at: string, input: number, id: string) => ev('session.shutdown', { shutdownType: 'routine', modelMetrics: { m: { usage: { inputTokens: input, outputTokens: input / 10 } } } }, { at, id });
    const lines = [
      startLine(),
      ev('user.message', { content: 'first run' }, { at: '2026-11-12T08:00:01.000Z', id: 'u1' }),
      sd('2026-11-12T08:10:00.000Z', 100, 'sd1'),
      ev('session.resume', { resumeTime: '2026-11-12T09:00:00.000Z', eventCount: 3 }, { at: '2026-11-12T09:00:00.000Z', id: 'r1' }),
      ev('user.message', { content: 'second run' }, { at: '2026-11-12T09:00:01.000Z', id: 'u2' }),
      sd('2026-11-12T09:10:00.000Z', 250, 'sd2'),
    ];
    const totalOf = (store: Store) => store.getGraph(SID)!.nodes.reduce((a, n) => a + (n.usage?.inputTokens ?? 0), 0);
    await writeRel(EVENTS_REL, body(lines));
    const s1 = open();
    const p1 = newPipeline(s1);
    await p1.scanAll();
    await p1.idle();
    const oneShot = view(s1, SID)!;
    expect(totalOf(s1)).toBe(250);
    await fs.rm(abs(EVENTS_REL));
    const s2 = open();
    const p2 = newPipeline(s2);
    let text = '';
    for (const line of lines) {
      text += `${line}\n`;
      await writeRel(EVENTS_REL, text);
      await p2.ingestFile(abs(EVENTS_REL));
    }
    await p2.idle();
    expect(view(s2, SID)).toEqual(oneShot);
    p1.rebuild();
    expect(view(s1, SID)).toEqual(oneShot);
    expect(totalOf(s1)).toBe(250);
  });

  test('title precedence: workspace name > summary > first prompt', async () => {
    await writeRel(EVENTS_REL, body(exampleLines()));
    const store = open();
    const p = newPipeline(store);
    await p.scanAll();
    await p.idle();
    expect(store.getSession(SID)!.title).toBe('Fix the typo in README');
    await writeRel(WORKSPACE_REL, 'summary: The summary\n');
    await p.ingestFile(abs(WORKSPACE_REL));
    await p.idle();
    expect(store.getSession(SID)!.title).toBe('The summary');
    await writeRel(WORKSPACE_REL, 'name: |\n  The name\nsummary: The summary\n');
    await p.ingestFile(abs(WORKSPACE_REL));
    await p.idle();
    expect(store.getSession(SID)!.title).toBe('The name');
    p.rebuild();
    expect(store.getSession(SID)!.title).toBe('The name');
  });

  test('a zero-byte or garbage-only file creates nothing; a session.start alone creates the session', async () => {
    const A = 'aaaaaaaa-0000-4000-8000-000000000001';
    const B = 'bbbbbbbb-0000-4000-8000-000000000002';
    await writeRel(`${A}/events.jsonl`, '');
    await writeRel(`${B}/events.jsonl`, 'garbage\n\u0001\u0002\n');
    await writeRel(EVENTS_REL, body([startLine()]));
    const store = open();
    const p = newPipeline(store);
    await p.scanAll();
    await p.idle();
    expect(store.getSession(A)).toBeNull();
    expect(store.getSession(B)).toBeNull();
    expect(store.getSession(SID)).toMatchObject({ status: 'running', cwd: CWD });
    expect(store.listProjects(Date.now()).map((x) => x.id)).toEqual([PROJECT]);
    p.rebuild();
    expect(store.getSession(B)).toBeNull();
  });
});
