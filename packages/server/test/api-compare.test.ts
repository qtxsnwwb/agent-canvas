import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Change, CompareResponse, FileTouch, GraphNode, Session } from '@agent-canvas/shared';
import { buildServer } from '../src/api/server.js';
import { loadConfig, type Config } from '../src/config.js';
import { Pipeline } from '../src/pipeline.js';
import { openStore, type Store } from '../src/store/store.js';

// Invented sessions in an in-memory store; temp directories only.
const NOW = Date.parse('2026-01-02T12:00:00.000Z');
const P = 'D--w-tea-shop';
const iso = (ms: number): string => new Date(ms).toISOString();

function session(id: string, o: Partial<Session> = {}): Session {
  return {
    id, projectId: P, origin: 'claude', cwd: 'D:\\w\\tea-shop', title: null, gitBranch: null, status: 'idle',
    sourceDeleted: false, startedAt: iso(NOW - 3600_000), lastActivityAt: iso(NOW - 3000_000), ...o,
  };
}
function node(sessionId: string, id: string, ms: number, o: Partial<GraphNode> = {}): GraphNode {
  return {
    id, sessionId, turnId: 'T1', agentId: null, parentId: null, kind: 'tool', status: 'succeeded', timestamp: iso(ms),
    confirmed: true, title: 'Bash', summary: 'SECRET COMMAND', toolName: 'Bash', toolUseId: null, messageId: null,
    durationMs: 2000, usage: null, systemSubtype: null, childAgentId: null, endedAt: null, ...o,
  };
}
const touch = (p: string, action: FileTouch['action']): FileTouch[] => [{ path: p, action }];

describe('GET /api/compare', () => {
  let tmp: string;
  let store: Store;
  let config: Config;
  let pipeline: Pipeline;
  let app: FastifyInstance;
  const get = (url: string) => app.inject({ method: 'GET', url });
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-api-compare-'));
    config = loadConfig({}, { deepseekDir: null, workbuddyDirs: [], codebuddyDir: null, doubaoDirs: [], qwenDir: null, geminiDir: null, grokDir: null, copilotDir: null, projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), cursorDbPath: null });
    await fs.mkdir(config.projectsDir, { recursive: true });
    store = openStore(':memory:');
    pipeline = new Pipeline(store, config);
    app = buildServer({ store, pipeline, config });
    const changes: Change[] = [
      // A Claude Code session: two turns, Bash and Read, a subagent, token data.
      { type: 'session_upserted', session: session('claude-1', { title: '修 CI 超时' }) },
      { type: 'node_added', node: node('claude-1', 'c-p1', NOW - 9000, { kind: 'prompt', status: null, toolName: null, title: 'Prompt', summary: '帮我修 CI   超时' }), detail: {} },
      { type: 'node_added', node: node('claude-1', 'c-t1', NOW - 8000, { status: 'failed' }), detail: {} },
      { type: 'node_added', node: node('claude-1', 'c-r1', NOW - 7000, { toolName: 'Read', title: 'Read', files: touch('D:/w/tea-shop/src/ci.yml', 'read') }), detail: {} },
      { type: 'node_added', node: node('claude-1', 'c-s1', NOW - 6500, { kind: 'subagent', toolName: 'Task', title: 'Task', childAgentId: 'ag' }), detail: {} },
      { type: 'node_added', node: node('claude-1', 'c-x1', NOW - 6000, { kind: 'text', status: null, toolName: null, messageId: 'm1', usage: { inputTokens: 100, cachedInputTokens: 900, outputTokens: 20 } }), detail: {} },
      { type: 'node_added', node: node('claude-1', 'c-p2', NOW - 5000, { kind: 'prompt', status: null, toolName: null, turnId: 'T2', summary: 'second' }), detail: {} },
      { type: 'node_added', node: node('claude-1', 'c-e2', NOW - 4000, { turnId: 'T2', toolName: 'Edit', title: 'Edit', files: touch('D:/w/tea-shop/src/ci.yml', 'edit') }), detail: {} },
      // A Codex session in the same project: other tool names, no token data.
      { type: 'session_upserted', session: session('codex-1', { origin: 'codex', title: null }) },
      { type: 'node_added', node: node('codex-1', 'x-p1', NOW - 9000, { kind: 'prompt', status: null, toolName: null, summary: '帮我修 CI 超时' }), detail: {} },
      { type: 'node_added', node: node('codex-1', 'x-t1', NOW - 8000, { toolName: 'exec_command', title: 'exec_command' }), detail: {} },
      { type: 'node_added', node: node('codex-1', 'x-a1', NOW - 7000, { toolName: 'apply_patch', title: 'apply_patch', files: touch('D:/w/tea-shop/src/ci.yml', 'edit') }), detail: {} },
      { type: 'node_added', node: node('codex-1', 'x-a2', NOW - 6000, { toolName: 'apply_patch', title: 'apply_patch', files: touch('D:/w/tea-shop/README.md', 'write') }), detail: {} },
    ];
    store.applyChanges(changes);
  });
  afterEach(async () => {
    await app.close();
    store.close();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  });

  test('both found: the two sides, tools paired by name, turns by index, files by relative path', async () => {
    const res = await get('/api/compare?a=claude-1&b=codex-1');
    expect(res.statusCode).toBe(200);
    const body = res.json() as CompareResponse;
    expect(body.sameSession).toBe(false);
    expect(body.left).toMatchObject({
      sessionId: 'claude-1', title: '修 CI 超时', origin: 'claude', projectId: P, cwd: 'D:\\w\\tea-shop', status: 'idle',
      turns: 2, steps: 7, toolCalls: 4, failed: 1, subagents: 1, tokens: { input: 100, cachedInput: 900, output: 20 },
    });
    expect(body.right).toMatchObject({ sessionId: 'codex-1', title: 'codex-1', origin: 'codex', turns: 1, steps: 4, toolCalls: 3, failed: 0, subagents: 0, tokens: null });
    expect(body.tools.map((t) => [t.toolName, t.left?.calls ?? null, t.right?.calls ?? null])).toEqual([
      // Equal sums by name, code units (as the stats page orders names).
      ['apply_patch', null, 2], ['Bash', 1, null], ['Edit', 1, null], ['Read', 1, null], ['Task', 1, null], ['exec_command', null, 1],
    ]);
    expect(body.turns).toEqual([
      {
        index: 1,
        left: { promptNodeId: 'c-p1', promptHead: '帮我修 CI 超时', activeMs: 3000, toolCalls: 3, tokens: 120 },
        right: { promptNodeId: 'x-p1', promptHead: '帮我修 CI 超时', activeMs: 3000, toolCalls: 3, tokens: null },
      },
      { index: 2, left: { promptNodeId: 'c-p2', promptHead: 'second', activeMs: 1000, toolCalls: 1, tokens: 0 }, right: null },
    ]);
    expect(body.files).toEqual({
      both: [{ path: 'src/ci.yml', left: { reads: 1, changes: 1 }, right: { reads: 0, changes: 1 } }],
      onlyLeft: [],
      onlyRight: [{ path: 'README.md', left: null, right: { reads: 0, changes: 1 } }],
      more: { both: 0, onlyLeft: 0, onlyRight: 0 },
      cwdsDiffer: false,
    });
    expect(body.otherTools).toBeNull();
    expect(body.turnsTruncated).toBe(false);
    // Tool inputs and replies never leave the server (only prompt heads, titles and paths do).
    expect(res.body).not.toMatch(/SECRET/);
  });

  test('one missing: that side null, the other as usual (200)', async () => {
    const res = await get('/api/compare?a=nope&b=codex-1');
    expect(res.statusCode).toBe(200);
    const body = res.json() as CompareResponse;
    expect(body.left).toBeNull();
    expect(body.right?.sessionId).toBe('codex-1');
    expect(body.sameSession).toBe(false);
    expect(body.tools.every((t) => t.left === null)).toBe(true);
    expect(body.turns.every((t) => t.left === null)).toBe(true);
    expect(body.files.onlyRight.map((f) => f.path)).toEqual(['README.md', 'src/ci.yml']);
  });

  test('the same id twice: sameSession, both sides equal (Review Focus 1)', async () => {
    const res = await get('/api/compare?a=claude-1&b=claude-1');
    expect(res.statusCode).toBe(200);
    const body = res.json() as CompareResponse;
    expect(body.sameSession).toBe(true);
    expect(body.left).toEqual(body.right);
    for (const row of [...body.tools, ...body.turns, ...body.files.both]) expect(row.left).toEqual(row.right);
    expect(body.files.onlyLeft).toEqual([]);
    expect(body.files.onlyRight).toEqual([]);
  });

  test('a missing, empty or repeated parameter: 400', async () => {
    for (const url of [
      '/api/compare',
      '/api/compare?a=claude-1',
      '/api/compare?b=claude-1',
      '/api/compare?a=&b=claude-1',
      '/api/compare?a=claude-1&b=',
      '/api/compare?a=claude-1&a=codex-1&b=codex-1',
      '/api/compare?a=claude-1&b=codex-1&b=claude-1',
    ]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(400);
      expect((res.json() as { error: string }).error, url).toMatch(/\b[ab]\b/);
    }
  });
});
