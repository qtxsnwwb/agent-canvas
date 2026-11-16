import { describe, expect, test } from 'vitest';
import { applyChanges, costBaseline, emptyGraph, type Change, type GraphNode, type Session, type SessionAnomaliesResponse } from '@agent-canvas/shared';
import { AnomaliesService, type AnomaliesSource } from '../src/anomalies/service.js';
import { CopilotNormalizer } from '../src/normalize/copilot.js';
import { ev, startLine, transcript } from './copilot-fixtures.js';

// Spec (more sources) section 6: Copilot sessions take no part in the `cost` anomaly kind; the other kinds still apply,
// and the other origins' results do not change.

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const MIN = 60_000;
const DAY = 24 * 3600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

class Source implements AnomaliesSource {
  seq = 1;
  readonly data = new Map<string, { session: Session; nodes: GraphNode[] }>();
  set(session: Session, nodes: GraphNode[]): void {
    this.data.set(session.id, { session, nodes });
    this.seq++;
  }
  sessions(): Session[] {
    return [...this.data.values()].map((d) => d.session);
  }
  async readSession(sessionId: string) {
    const d = this.data.get(sessionId);
    return d ? { session: d.session, nodes: [...d.nodes], seq: this.seq } : null;
  }
}
const make = (src: AnomaliesSource): AnomaliesService => new AnomaliesService(src, { now: () => NOW, answerWaitMs: 5000, liveDelayMs: 0, liveCostFactor: 0 });
const kinds = async (svc: AnomaliesService, id: string): Promise<string[]> => ((await svc.session(id)) as SessionAnomaliesResponse).anomalies.map((a) => `${a.kind}:${a.basis ?? ''}`);

/** A Copilot session through the real normalizer: a prompt, one bash call (`activeMs`), a shutdown with `tokens` input. */
function copilotSession(id: string, at: number, tokens: number, activeMs: number, extra: string[] = []): { session: Session; nodes: GraphNode[] } {
  const lines = [
    startLine(),
    ev('user.message', { content: 'run the tests' }, { at: iso(at) }),
    ev('tool.execution_start', { toolCallId: 'b1', toolName: 'bash', arguments: { command: 'npm test' } }, { at: iso(at + 1000) }),
    ev('tool.execution_complete', { toolCallId: 'b1', success: true, result: { content: 'ok' } }, { at: iso(at + 1000 + activeMs) }),
    ...extra,
    ev('session.shutdown', { shutdownType: 'routine', modelMetrics: { m: { usage: { inputTokens: tokens, outputTokens: 1000 } } } }, { at: iso(at + 2000 + activeMs) }),
  ];
  const n = new CopilotNormalizer();
  const changes: Change[] = [];
  let session: Session | null = null;
  for (const e of transcript(lines, { sessionId: id, projectId: 'p1' })) {
    for (const c of n.apply(e, 'p1').changes) {
      changes.push(c);
      if (c.type === 'session_upserted') session = c.session;
    }
  }
  return { session: { ...session!, status: 'ended' }, nodes: Object.values(applyChanges(emptyGraph(), changes).nodes) };
}

/** 25 finished one-minute turns with 100k tokens, then one of 30 minutes and 900k (as the anomaly service tests do). */
function heavy(id: string, origin: Session['origin']): { session: Session; nodes: GraphNode[] } {
  const nodes: GraphNode[] = [];
  const node = (nid: string, ms: number, o: Partial<GraphNode>): GraphNode => ({
    id: nid, sessionId: id, turnId: null, agentId: null, parentId: null, kind: 'tool', status: 'succeeded', timestamp: iso(ms), confirmed: true, title: 'Bash',
    summary: '', toolName: 'Bash', toolUseId: null, messageId: null, durationMs: 1000, usage: null, systemSubtype: null, childAgentId: null, endedAt: iso(ms + 1000), ...o,
  });
  const turn = (t: string, ms: number, activeMs: number, tokens: number): void => {
    nodes.push(node(`${id}-${t}-p`, ms, { kind: 'prompt', status: null, toolName: null, turnId: t, durationMs: null, endedAt: null, usage: { inputTokens: tokens - 1000, outputTokens: 1000 }, messageId: `${id}-${t}-m` }));
    nodes.push(node(`${id}-${t}-c`, ms + 1000, { turnId: t, durationMs: activeMs, endedAt: iso(ms + 1000 + activeMs), inputKey: `k-${t}` }));
  };
  for (let i = 0; i < 25; i++) turn(`T${String(i).padStart(2, '0')}`, NOW - 2 * DAY + i * 10 * MIN, MIN, 100_000);
  turn('T99', NOW - DAY, 30 * MIN, 900_000);
  const session: Session = { id, projectId: 'p1', origin, cwd: null, title: id, gitBranch: null, status: 'idle', sourceDeleted: false, startedAt: iso(NOW - 3 * DAY), lastActivityAt: iso(NOW) };
  return { session, nodes };
}

describe('Copilot sessions and the cost anomaly', () => {
  test('25 Copilot sessions in one project, one with 50× the tokens and 30× the time: no cost anomaly', async () => {
    const src = new Source();
    for (let i = 0; i < 25; i++) {
      const big = i === 24;
      const s = copilotSession(`sess-${i}`, NOW - 2 * DAY + i * 20 * MIN, big ? 5_000_000 : 100_000, big ? 30 * MIN : MIN);
      src.set(s.session, s.nodes);
    }
    // The shutdown usage is on the graph (stats count it), but cost does not judge it.
    expect(src.data.get('sess-24')!.nodes.find((n) => n.systemSubtype === 'shutdown')!.usage).toMatchObject({ inputTokens: 5_000_000 });
    const svc = make(src);
    for (let i = 0; i < 25; i++) expect(await kinds(svc, `sess-${i}`), `sess-${i}`).toEqual([]);
    expect(costBaseline([{ sessionId: 'x', turnKey: 'k', finished: true, activeMs: 1, tokens: 1, firstNodeId: 'a', lastNodeId: 'a', at: iso(NOW) } as never], { origin: 'copilot' })).toEqual({ activeP95: null, tokensP95: null });
  });

  test('the other kinds still apply to Copilot: a loop of the same failing call', async () => {
    const fails = [1, 2, 3, 4].flatMap((k) => [
      ev('tool.execution_start', { toolCallId: `f${k}`, toolName: 'bash', arguments: { command: 'make' } }, { at: iso(NOW - DAY + 10_000 * k) }),
      ev('tool.execution_complete', { toolCallId: `f${k}`, success: false, error: { message: 'exit 2' } }, { at: iso(NOW - DAY + 10_000 * k + 1000) }),
    ]);
    const s = copilotSession('loopy', NOW - DAY, 100_000, MIN, fails);
    const src = new Source();
    src.set(s.session, s.nodes);
    const found = await kinds(make(src), 'loopy');
    expect(found.some((k) => k.startsWith('loop:'))).toBe(true);
    expect(found.some((k) => k.startsWith('cost:'))).toBe(false);
  });

  test('Claude, Codex and Cursor results are unchanged next to Copilot sessions', async () => {
    const src = new Source();
    for (const [id, origin] of [['claude', 'claude'], ['codex', 'codex'], ['cursor', 'cursor'], ['copilot', 'copilot']] as const) {
      const h = heavy(id, origin);
      src.set(h.session, h.nodes);
    }
    const svc = make(src);
    expect(await kinds(svc, 'claude')).toEqual(['cost:time', 'cost:tokens']);
    expect(await kinds(svc, 'codex')).toEqual(['cost:time', 'cost:tokens']);
    expect(await kinds(svc, 'cursor')).toEqual(['cost:time']);
    expect(await kinds(svc, 'copilot')).toEqual([]);
  });
});
