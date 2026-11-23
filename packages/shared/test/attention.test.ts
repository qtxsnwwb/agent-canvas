import { expect, test } from 'vitest';
import {
  ATTENTION_KIND_ORDER,
  ATTENTION_LIMITS,
  ATTENTION_UNDETERMINABLE_ORIGINS,
  attentionKey,
  sortAttention,
  validateAutoHideHours,
  type AttentionItem,
  type AttentionKind,
} from '../src/index.js';

function item(sessionId: string, kind: AttentionKind, since: string): AttentionItem {
  return {
    key: attentionKey(sessionId, kind, since),
    sessionId,
    kind,
    since,
    title: null,
    origin: 'claude',
    projectId: 'p',
    cwd: null,
    explanation: null,
    nodeId: null,
  };
}

test('常量：种类的先后、无法判断的来源、时限', () => {
  expect(ATTENTION_KIND_ORDER).toEqual(['permission', 'error', 'stuck', 'finished']);
  expect(ATTENTION_UNDETERMINABLE_ORIGINS).toEqual(['grok', 'copilot', 'doubao']);
  expect(ATTENTION_LIMITS).toEqual({ autoHideHours: { min: 1, max: 720, default: 24 }, keepDays: 30, explanationChars: 200 });
});

test('键是 会话 id|种类|since', () => {
  expect(attentionKey('s1', 'finished', '2026-11-23T01:02:03.000Z')).toBe('s1|finished|2026-11-23T01:02:03.000Z');
  expect(attentionKey('a-b', 'permission', 'x')).toBe('a-b|permission|x');
});

test('排序：先按种类（批准、出错、卡住、跑完），同类里 since 新的在前；不改原数组', () => {
  const input = [
    item('f-old', 'finished', '2026-11-23T01:00:00.000Z'),
    item('s', 'stuck', '2026-11-23T00:00:00.000Z'),
    item('f-new', 'finished', '2026-11-23T03:00:00.000Z'),
    item('e', 'error', '2026-11-22T00:00:00.000Z'),
    item('p-old', 'permission', '2026-11-20T00:00:00.000Z'),
    item('p-new', 'permission', '2026-11-23T05:00:00.000Z'),
  ];
  const copy = [...input];
  expect(sortAttention(input).map((x) => x.sessionId)).toEqual(['p-new', 'p-old', 'e', 's', 'f-new', 'f-old']);
  expect(input).toEqual(copy);
});

test('排序：since 的写法不同（带时区偏移）也按时间比', () => {
  const a = item('a', 'finished', '2026-11-23T10:00:00+08:00'); // 02:00Z
  const b = item('b', 'finished', '2026-11-23T03:00:00.000Z');
  expect(sortAttention([a, b]).map((x) => x.sessionId)).toEqual(['b', 'a']);
});

test('自动移出时限：1 到 720 的整数', () => {
  expect(validateAutoHideHours(1)).toEqual({ ok: true, value: 1 });
  expect(validateAutoHideHours(24)).toEqual({ ok: true, value: 24 });
  expect(validateAutoHideHours(720)).toEqual({ ok: true, value: 720 });
  for (const bad of [0, 721, 1.5, '24', null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const r = validateAutoHideHours(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('时限必须是 1 到 720 之间的整数（小时）');
  }
});
