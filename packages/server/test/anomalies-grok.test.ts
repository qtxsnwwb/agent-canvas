import { describe, expect, test } from 'vitest';
import { applyChanges, emptyGraph, type Change, type GraphNode, type Session, type SessionAnomaliesResponse } from '@agent-canvas/shared';
import { AnomaliesService, type AnomaliesSource } from '../src/anomalies/service.js';
import { summarizeAnomalies } from '../src/anomalies/summary.js';
import { GrokNormalizer } from '../src/normalize/grok.js';
import { chunk, ext, transcript, upd } from './grok-fixtures.js';

// Spec (more sources) section 6: a Grok session without turn-completion records takes no part in the `cost` anomaly
// kind (neither judged nor in the baseline); one with per-turn usage does. Other origins' results do not change.

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

/** A Grok session through the real normalizer: 25 one-minute turns, then one of 30 minutes; usage per turn optional. */
function grokSession(id: string, withUsage: boolean): { session: Session; nodes: GraphNode[] } {
  const lines: string[] = [];
  const sec = (ms: number): number => Math.floor(ms / 1000);
  for (let i = 0; i < 26; i++) {
    const big = i === 25;
    const at = NOW - 2 * DAY + i * 40 * MIN;
    const active = big ? 30 * MIN : MIN;
    const p = `p${i}`;
    lines.push(chunk('user', `step ${i}`, { ts: sec(at), promptId: p }));
    lines.push(upd({ sessionUpdate: 'tool_call', toolCallId: `c${i}`, kind: 'execute', rawInput: { command: `make ${i}` } }, { ts: sec(at + 1000), meta: { promptId: p } }));
    lines.push(upd({ sessionUpdate: 'tool_call_update', toolCallId: `c${i}`, status: 'completed' }, { ts: sec(at + 1000 + active), meta: { promptId: p } }));
    lines.push(chunk('agent', 'done', { ts: sec(at + 2000 + active), promptId: p }));
    if (withUsage) lines.push(ext({ sessionUpdate: 'turn_completed', prompt_id: p, usage: { inputTokens: big ? 900_000 : 100_000, outputTokens: 1000 } }, { ts: sec(at + 3000 + active) }));
  }
  const n = new GrokNormalizer();
  const changes: Change[] = [];
  let session: Session | null = null;
  for (const e of transcript(lines, { sessionId: id, projectId: 'p1' })) {
    for (const c of n.apply(e, 'p1').changes) {
      changes.push(c);
      if (c.type === 'session_upserted') session = c.session;
    }
  }
  return { session: { ...session!, status: 'idle' }, nodes: Object.values(applyChanges(emptyGraph(), changes).nodes) };
}

/** 25 finished one-minute turns with 100k tokens, then one of 30 minutes and 900k (as the copilot test does). */
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

describe('Grok sessions and the cost anomaly', () => {
  test('without turn_completed: no turn costs, no cost anomaly (30× the time), not in the baseline', async () => {
    const s = grokSession('no-usage', false);
    expect(s.nodes.some((n) => n.usage !== null)).toBe(false);
    expect(summarizeAnomalies(s.session, s.nodes).costs).toEqual([]);
    const src = new Source();
    src.set(s.session, s.nodes);
    expect(await kinds(make(src), 'no-usage')).toEqual([]);
  });

  test('with per-turn usage: judged on time and tokens', async () => {
    const s = grokSession('with-usage', true);
    expect(summarizeAnomalies(s.session, s.nodes).costs).toHaveLength(26);
    const src = new Source();
    src.set(s.session, s.nodes);
    expect(await kinds(make(src), 'with-usage')).toEqual(['cost:time', 'cost:tokens']);
  });

  test('a usage-free Grok session takes no part in the baseline of the Grok sessions with usage', async () => {
    const src = new Source();
    const a = grokSession('with-usage', true);
    const b = grokSession('no-usage', false);
    src.set(a.session, a.nodes);
    src.set(b.session, b.nodes);
    const svc = make(src);
    expect(await kinds(svc, 'with-usage')).toEqual(['cost:time', 'cost:tokens']);
    expect(await kinds(svc, 'no-usage')).toEqual([]);
  });

  test('other origins unchanged next to Grok sessions', async () => {
    const src = new Source();
    for (const [id, origin] of [['claude', 'claude'], ['codex', 'codex'], ['cursor', 'cursor'], ['gemini', 'gemini'], ['copilot', 'copilot']] as const) {
      const h = heavy(id, origin);
      src.set(h.session, h.nodes);
    }
    const g = grokSession('grok', false);
    src.set(g.session, g.nodes);
    const svc = make(src);
    expect(await kinds(svc, 'claude')).toEqual(['cost:time', 'cost:tokens']);
    expect(await kinds(svc, 'codex')).toEqual(['cost:time', 'cost:tokens']);
    expect(await kinds(svc, 'cursor')).toEqual(['cost:time']);
    expect(await kinds(svc, 'gemini')).toEqual(['cost:time', 'cost:tokens']);
    expect(await kinds(svc, 'copilot')).toEqual([]);
    expect(await kinds(svc, 'grok')).toEqual([]);
  });
});
