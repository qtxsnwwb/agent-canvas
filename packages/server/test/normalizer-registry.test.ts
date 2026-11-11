import { describe, expect, test } from 'vitest';
import type { Origin } from '@claude-canvas/shared';
import { NormalizerRegistry } from '../src/normalize/registry.js';
import type { AgentNormalizer, NormalizeResult } from '../src/normalize/types.js';
import type { RawEvent } from '../src/store/store.js';

/** A normalizer that records what it was asked and answers from a fixed per-session state. */
class FakeNormalizer implements AgentNormalizer {
  readonly applied: { file: string; projectId: string }[] = [];
  readonly dropped: string[] = [];
  readonly restored: { sessionId: string; files: string[] }[] = [];
  readonly sessions = new Set<string>();
  readonly preSession = new Set<string>();
  readonly toolInputs = new Map<string, number>();
  constructor(readonly name: string) {}
  apply(event: RawEvent, projectId: string): NormalizeResult {
    this.applied.push({ file: event.source === 'hook' ? `hook:${event.eventName}` : event.file, projectId });
    return { changes: [], unknownRecordType: this.name };
  }
  dropSession(sessionId: string): void {
    this.dropped.push(sessionId);
    this.sessions.delete(sessionId);
  }
  needsPreSessionReplay(sessionId: string): boolean {
    return this.preSession.has(sessionId);
  }
  restorePreSession(sessionId: string, events: Iterable<RawEvent>): void {
    this.restored.push({ sessionId, files: [...events].map((e) => (e.source === 'hook' ? `hook:${e.eventName}` : e.file)) });
  }
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }
  sessionCount(): number {
    return this.sessions.size;
  }
  toolInputCount(sessionId: string): number {
    return this.toolInputs.get(sessionId) ?? 0;
  }
}

const meta = (file: string, origin?: Origin): RawEvent => ({
  source: 'meta',
  ...(origin === undefined ? {} : { origin }),
  file,
  sessionId: 's',
  agentId: null,
  payload: '{}',
});

function twoFakes(): { claude: FakeNormalizer; codex: FakeNormalizer; registry: NormalizerRegistry } {
  const claude = new FakeNormalizer('claude');
  const codex = new FakeNormalizer('codex');
  return { claude, codex, registry: new NormalizerRegistry({ claude: () => claude, codex: () => codex }) };
}

describe('NormalizerRegistry', () => {
  test('apply 按事件的 origin 路由；没有 origin 视为 claude', () => {
    const { claude, codex, registry } = twoFakes();
    expect(registry.apply(meta('a', 'claude'), 'p1')).toEqual({ changes: [], unknownRecordType: 'claude' });
    expect(registry.apply(meta('b', 'codex'), 'p2')).toEqual({ changes: [], unknownRecordType: 'codex' });
    expect(registry.apply(meta('c'), 'p3')).toEqual({ changes: [], unknownRecordType: 'claude' });
    const hook: RawEvent = { source: 'hook', origin: 'codex', receivedAt: 't', eventName: 'Stop', sessionId: 's', payload: '{}' };
    registry.apply(hook, 'p4');
    expect(claude.applied).toEqual([
      { file: 'a', projectId: 'p1' },
      { file: 'c', projectId: 'p3' },
    ]);
    expect(codex.applied).toEqual([
      { file: 'b', projectId: 'p2' },
      { file: 'hook:Stop', projectId: 'p4' },
    ]);
  });

  test('没有工厂的 origin：apply 不产生变化也不计未识别，会话级调用只问有归一器的', () => {
    const claude = new FakeNormalizer('claude');
    const registry = new NormalizerRegistry({ claude: () => claude, codex: null });
    expect(registry.apply(meta('x', 'codex'), 'p')).toEqual({ changes: [] });
    expect(claude.applied).toEqual([]);
    claude.sessions.add('s1');
    claude.preSession.add('s2');
    claude.toolInputs.set('s1', 3);
    expect(registry.hasSession('s1')).toBe(true);
    expect(registry.needsPreSessionReplay('s2')).toBe(true);
    expect(registry.sessionCount()).toBe(1);
    expect(registry.toolInputCount('s1')).toBe(3);
    registry.dropSession('s1');
    expect(claude.dropped).toEqual(['s1']);
  });

  test('没有任何工厂时一切为空', () => {
    const registry = new NormalizerRegistry({ claude: null, codex: null });
    expect(registry.apply(meta('x'), 'p')).toEqual({ changes: [] });
    expect(registry.hasSession('s')).toBe(false);
    expect(registry.needsPreSessionReplay('s')).toBe(false);
    expect(registry.sessionCount()).toBe(0);
    expect(registry.toolInputCount('s')).toBe(0);
    registry.restorePreSession('s', [meta('x')]);
    registry.dropSession('s');
  });

  test('会话级调用覆盖所有 origin：hasSession / needsPreSessionReplay 任一，计数求和，dropSession 全部', () => {
    const { claude, codex, registry } = twoFakes();
    claude.sessions.add('c1');
    codex.sessions.add('x1');
    codex.sessions.add('x2');
    codex.preSession.add('x3');
    claude.toolInputs.set('c1', 2);
    codex.toolInputs.set('c1', 5);
    expect(registry.hasSession('c1')).toBe(true);
    expect(registry.hasSession('x2')).toBe(true);
    expect(registry.hasSession('nope')).toBe(false);
    expect(registry.needsPreSessionReplay('x3')).toBe(true);
    expect(registry.needsPreSessionReplay('c1')).toBe(false);
    expect(registry.sessionCount()).toBe(3);
    expect(registry.toolInputCount('c1')).toBe(7);
    registry.dropSession('x1');
    expect(claude.dropped).toEqual(['x1']);
    expect(codex.dropped).toEqual(['x1']);
    expect(registry.sessionCount()).toBe(2);
  });

  test('restorePreSession 只交给需要的归一器，且只给它自己 origin 的事件（按顺序）', () => {
    const { claude, codex, registry } = twoFakes();
    const events = [meta('a', 'claude'), meta('b', 'codex'), meta('c'), meta('d', 'codex')];
    codex.preSession.add('s');
    registry.restorePreSession('s', events);
    expect(codex.restored).toEqual([{ sessionId: 's', files: ['b', 'd'] }]);
    expect(claude.restored).toEqual([]);

    claude.preSession.add('s');
    // A one-shot iterable: with two targets the registry must read it once and give each its share.
    let reads = 0;
    function* once(): Generator<RawEvent> {
      reads += 1;
      yield* events;
    }
    registry.restorePreSession('s', once());
    expect(reads).toBe(1);
    expect(claude.restored).toEqual([{ sessionId: 's', files: ['a', 'c'] }]);
    expect(codex.restored.at(-1)).toEqual({ sessionId: 's', files: ['b', 'd'] });
  });

  test('restorePreSession 在没有归一器需要时不读事件', () => {
    const { registry } = twoFakes();
    let reads = 0;
    function* never(): Generator<RawEvent> {
      reads += 1;
      yield meta('a');
    }
    registry.restorePreSession('s', never());
    expect(reads).toBe(0);
  });
});
