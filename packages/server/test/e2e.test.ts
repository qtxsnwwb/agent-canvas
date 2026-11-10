import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import { applyChange, emptyGraph, type Change, type GraphEdge, type GraphNode, type Session } from '@claude-canvas/shared';
import { rebuild, start, type Running } from '../src/cli.js';
import type { RawEvent } from '../src/store/store.js';
import { assistantBlock, toolResult, userPrompt } from './fixtures.js';

interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  session: Session;
}

let tmp: string;
let projectsDir: string;
let dataDir: string;
const sockets: WebSocket[] = [];
const apps: Running[] = [];

const abs = (rel: string): string => path.join(projectsDir, ...rel.split('/'));
const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const linesOf = (events: RawEvent[]): string => events.map((e) => (e.source === 'transcript' ? e.line : '') + '\n').join('');

async function append(rel: string, events: RawEvent[]): Promise<void> {
  await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
  await fs.appendFile(abs(rel), linesOf(events));
}
async function launch(overrides: Parameters<typeof start>[0] = {}): Promise<Running> {
  const app = await start({ projectsDir, dataDir, port: 0, ...overrides });
  apps.push(app);
  return app;
}
async function closeApp(app: Running): Promise<void> {
  apps.splice(apps.indexOf(app), 1);
  await app.close();
}
async function getJson<T>(app: Running, p: string): Promise<T> {
  const res = await fetch(app.url + p);
  if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
  return (await res.json()) as T;
}
const graph = (app: Running, sessionId: string): Promise<GraphResponse> => getJson(app, `/api/sessions/${sessionId}/graph`);
const sessions = (app: Running, projectId: string): Promise<Session[]> => getJson(app, `/api/projects/${projectId}/sessions`);

async function connect(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url.replace('http', 'ws') + '/ws');
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}
function collect(ws: WebSocket): () => Change[] {
  const changes: Change[] = [];
  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString()) as { type: string; changes?: Change[] };
    if (msg.type === 'changes' && msg.changes) changes.push(...msg.changes);
  });
  return () => changes;
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-e2e-'));
  projectsDir = path.join(tmp, 'projects');
  dataDir = path.join(tmp, 'data');
  await fs.mkdir(projectsDir, { recursive: true });
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
});

test('回放一轮带权限确认和子代理的会话', async () => {
  const app = await launch({ rescanMs: 100 });
  const ws = await connect(app.url);
  const got = collect(ws);
  ws.send(JSON.stringify({ type: 'subscribe', scope: 'session', sessionId: 's1', sinceSeq: 0 }));
  const H = (name: string, body: object) =>
    fetch(app.url + '/hooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hook_event_name: name, session_id: 's1', cwd: '/w', ...body }),
    });
  const T = { timeout: 15_000 };

  await H('UserPromptSubmit', { prompt: '删掉临时文件' });
  await append('proj/s1.jsonl', [userPrompt('u1', null, '删掉临时文件', { promptId: 'p1' })]);
  await H('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm tmp' }, tool_use_id: 'tu1' });
  await H('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm tmp' } });
  await vi.waitFor(async () => expect((await graph(app, 's1')).nodes.find((n) => n.id === 'tool:tu1')?.status).toBe('awaiting_permission'), T);
  await vi.waitFor(async () => expect((await sessions(app, 'proj')).find((s) => s.id === 's1')?.status).toBe('awaiting_permission'), T);

  await append('proj/s1.jsonl', [assistantBlock('a1', 'u1', { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'rm tmp' } }, { messageId: 'm1' })]);
  await H('PostToolUse', { tool_use_id: 'tu1', tool_response: '', duration_ms: 12 });
  await append('proj/s1.jsonl', [
    toolResult('u2', 'a1', 'tu1', ''),
    assistantBlock('a2', 'u2', { type: 'tool_use', id: 'tu2', name: 'Agent', input: { description: '检查' } }, { messageId: 'm2' }),
  ]);
  await append('proj/s1/subagents/agent-ag1.jsonl', [userPrompt('s1u', null, '检查', { agentId: 'ag1' })]);
  await fs.writeFile(abs('proj/s1/subagents/agent-ag1.meta.json'), JSON.stringify({ toolUseId: 'tu2', agentType: 'Explore', description: '检查' }));
  await H('SubagentStop', { agent_id: 'ag1', agent_type: 'Explore' });
  await append('proj/s1.jsonl', [
    toolResult('u3', 'a2', 'tu2', 'ok'),
    assistantBlock('a3', 'u3', { type: 'text', text: '完成' }, { messageId: 'm3', stopReason: 'end_turn' }),
  ]);
  await H('Stop', {});

  await vi.waitFor(
    async () => expect((await graph(app, 's1')).nodes.map((n) => n.id).sort()).toEqual(['a3', 's1u', 'tool:tu1', 'tool:tu2', 'u1']),
    T,
  );
  await vi.waitFor(async () => expect((await graph(app, 's1')).session.status).toBe('idle'), T);
  const g = await graph(app, 's1');
  expect(g.nodes.find((n) => n.id === 'tool:tu1')).toMatchObject({ status: 'succeeded', confirmed: true, durationMs: 12 });
  expect(g.nodes.find((n) => n.id === 'tool:tu2')).toMatchObject({ kind: 'subagent', status: 'succeeded', title: 'Explore' });
  expect(g.edges).toContainEqual(expect.objectContaining({ from: 'tool:tu2', to: 's1u', kind: 'spawn' }));

  // Changes received over the WebSocket, merged, match the REST snapshot.
  await vi.waitFor(() => {
    const merged = got().reduce(applyChange, emptyGraph());
    expect(Object.values(merged.nodes).sort(byId)).toEqual([...g.nodes].sort(byId));
  }, T);

  // Data survives a restart and a rebuild yields the same graph.
  await closeApp(app);
  rebuild({ projectsDir, dataDir });
  const app2 = await launch();
  expect((await graph(app2, 's1')).nodes.sort(byId)).toEqual([...g.nodes].sort(byId));
  await closeApp(app2);
}, 60_000);

test('服务只监听回环地址', async () => {
  const app = await launch();
  expect(new URL(app.url).hostname).toBe('127.0.0.1');
  expect(Number(new URL(app.url).port)).toBeGreaterThan(0);
  await closeApp(app);
});
