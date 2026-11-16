import { describe, expect, test } from 'vitest';
import { applyGeminiOps, emptyGeminiState, reduceGemini, reduceGeminiLegacy, type GeminiThreadState } from '../src/normalize/gemini-reduce.js';
import { legacyJson, m2, m4, M1, M2, M4, M5, m5, metaLine, SID, userMsg } from './gemini-fixtures.js';

/** Feeds lines in order; returns the state and every op. */
function feed(lines: unknown[], state: GeminiThreadState = emptyGeminiState()) {
  const ops = [];
  for (const line of lines) {
    const out = reduceGemini(state, typeof line === 'string' ? line : JSON.stringify(line));
    ops.push(...out);
    applyGeminiOps(state, out);
  }
  return { state, ops };
}
const ids = (s: GeminiThreadState): string[] => [...s.order];

describe('reduceGemini: the five record kinds', () => {
  test('metadata line → setMeta', () => {
    const { state, ops } = feed([metaLine()]);
    expect(ops).toEqual([{ op: 'setMeta', meta: expect.objectContaining({ sessionId: SID, kind: 'main' }) }]);
    expect(state.meta.sessionId).toBe(SID);
  });

  test('message (string id) → upsertMessage', () => {
    const { state, ops } = feed([userMsg(M1, 'hi')]);
    expect(ops).toEqual([{ op: 'upsertMessage', id: M1, message: userMsg(M1, 'hi') }]);
    expect(ids(state)).toEqual([M1]);
  });

  test('$set merges metadata; $set.messages replaces all messages', () => {
    const { state, ops } = feed([userMsg(M1, 'a'), { $set: { summary: 'T', lastUpdated: 'x' } }, { $set: { messages: [m5, userMsg(M1, 'b')] } }]);
    expect(state.meta).toMatchObject({ summary: 'T', lastUpdated: 'x' });
    expect(ops.some((o) => o.op === 'replaceAll')).toBe(true);
    expect(ids(state)).toEqual([M5, M1]);
    expect(state.messages.get(M1)!.content).toEqual([{ text: 'b' }]);
    expect('messages' in state.meta).toBe(false);
  });

  test('$rewindTo a known id removes it and every message after it', () => {
    const { state, ops } = feed([userMsg(M1, 'a'), m2(0), m4(), m5, { $rewindTo: M2 }]);
    expect(ids(state)).toEqual([M1]);
    expect(ops[ops.length - 1]).toEqual({ op: 'removeMessages', ids: [M2, M4, M5] });
  });

  test('$rewindTo an unknown id removes every message', () => {
    const { state } = feed([userMsg(M1, 'a'), m2(0), { $rewindTo: 'nope' }]);
    expect(ids(state)).toEqual([]);
  });

  test('$patch toolCalls[{id, result}] sets only that call’s result', () => {
    const msg = { ...m4(), toolCalls: [{ id: 'c1', name: 'x', args: {}, status: 'scheduled' }, { id: 'c2', name: 'y', args: { a: 1 }, status: 'scheduled' }] };
    const { state } = feed([msg, { $patch: { id: M4, toolCalls: [{ id: 'c2', result: [{ functionResponse: { response: { output: 'ok' } } }] }] } }]);
    const calls = state.messages.get(M4)!.toolCalls as Record<string, unknown>[];
    expect(calls[0]).toEqual({ id: 'c1', name: 'x', args: {}, status: 'scheduled' });
    expect(calls[1]).toEqual({ id: 'c2', name: 'y', args: { a: 1 }, status: 'scheduled', result: [{ functionResponse: { response: { output: 'ok' } } }] });
  });

  test('$patch id+content and updates[] change content; unknown ids are ignored; orderIds is ignored', () => {
    const { state } = feed([
      userMsg(M1, 'a'),
      m5,
      { $patch: { id: M1, content: 'new a' } },
      { $patch: { updates: [{ id: M5, content: 'new 5' }, { id: 'ghost', content: 'x' }], orderIds: [M5, M1] } },
    ]);
    expect(state.messages.get(M1)!.content).toBe('new a');
    expect(state.messages.get(M5)!.content).toBe('new 5');
    expect(ids(state)).toEqual([M1, M5]);
    expect(state.messages.has('ghost')).toBe(false);
  });

  test('$patch removeIds removes those messages', () => {
    const { state, ops } = feed([userMsg(M1, 'a'), m5, m4(), { $patch: { removeIds: [M5, 'ghost'] } }]);
    expect(ids(state)).toEqual([M1, M4]);
    expect(ops[ops.length - 1]).toEqual({ op: 'removeMessages', ids: [M5] });
  });
});

describe('reduceGemini: repeated ids, unknown and malformed lines', () => {
  test('the same id twice → one message, the last content, the first position', () => {
    const { state } = feed([userMsg(M1, 'a'), m2(0), m5, m2(2)]);
    expect(ids(state)).toEqual([M1, M2, M5]);
    expect(state.messages.get(M2)!.toolCalls).toBeDefined();
  });

  test('a line with an unknown $-key reports gemini:$<key>', () => {
    const { ops, state } = feed([userMsg(M1, 'a'), { $compact: { x: 1 } }]);
    expect(ops[ops.length - 1]).toEqual({ op: 'unknown', type: 'gemini:$compact' });
    expect(ids(state)).toEqual([M1]);
  });

  test('a JSON array, a number, a malformed line, an empty object: no throw, reported, state unchanged', () => {
    const state = emptyGeminiState();
    for (const line of ['[1,2]', '42', '{"id":', 'null', '"str"', '{}']) {
      let ops: ReturnType<typeof reduceGemini> = [];
      expect(() => {
        ops = reduceGemini(state, line);
        applyGeminiOps(state, ops);
      }).not.toThrow();
      expect(ops).toHaveLength(1);
      expect(ops[0]!.op).toBe('unknown');
    }
    expect(ids(state)).toEqual([]);
  });

  test('a non-string $rewindTo is reported and removes nothing', () => {
    const { state, ops } = feed([userMsg(M1, 'a'), { $rewindTo: 7 }]);
    expect(ids(state)).toEqual([M1]);
    expect(ops[ops.length - 1]).toEqual({ op: 'unknown', type: 'gemini:$rewindTo' });
  });
});

describe('reduceGeminiLegacy', () => {
  test('a whole .json object → setMeta (without messages) + replaceAll', () => {
    const ops = reduceGeminiLegacy(legacyJson([userMsg(M1, 'a'), m5], { summary: 'Legacy' }));
    expect(ops.map((o) => o.op)).toEqual(['setMeta', 'replaceAll']);
    const state = emptyGeminiState();
    applyGeminiOps(state, ops);
    expect(ids(state)).toEqual([M1, M5]);
    expect(state.meta).toMatchObject({ sessionId: SID, summary: 'Legacy' });
  });

  test('a truncated .json (non-atomic rewrite seen mid-write) → reported, nothing applied', () => {
    const text = legacyJson([userMsg(M1, 'a')]);
    expect(reduceGeminiLegacy(text.slice(0, text.length - 10))).toEqual([{ op: 'unknown', type: 'gemini:invalid-json' }]);
  });
});
