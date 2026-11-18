import { describe, expect, test } from 'vitest';
import { qwenUsage } from '../src/normalize/qwen-usage.js';

// Spec 4.5 / format reference 3.3: cached = cachedContentTokenCount; input = prompt − cached; output = derived
// (total − prompt) when total > 0 and candidates ≤ derived ≤ candidates + thoughts, else candidates for the OpenAI
// family (OpenAI-compatible, OpenAI Responses, Qwen OAuth) and candidates + thoughts otherwise.

const um = (prompt: number, candidates: number, cached: number, thoughts: number | undefined, total: number) => ({
  promptTokenCount: prompt,
  candidatesTokenCount: candidates,
  cachedContentTokenCount: cached,
  ...(thoughts !== undefined ? { thoughtsTokenCount: thoughts } : {}),
  totalTokenCount: total,
});

describe('qwenUsage', () => {
  test('OpenAI-compatible / Qwen OAuth row: completion includes reasoning; total = prompt + completion: derived', () => {
    // prompt 18230 (17408 cached), completion 212 of which 96 reasoning, total 18442.
    expect(qwenUsage(um(18230, 212, 17408, 96, 18442), 'qwen-oauth')).toEqual({ inputTokens: 822, cachedInputTokens: 17408, outputTokens: 212 });
  });

  test('Anthropic row: no thoughts; total = prompt + output: derived equals candidates', () => {
    expect(qwenUsage(um(5000, 300, 4000, undefined, 5300), 'anthropic')).toEqual({ inputTokens: 1000, cachedInputTokens: 4000, outputTokens: 300 });
  });

  test('Gemini row: candidates exclude thoughts; total covers both: derived = candidates + thoughts', () => {
    expect(qwenUsage(um(1000, 50, 0, 70, 1120), 'gemini-api-key')).toEqual({ inputTokens: 1000, cachedInputTokens: 0, outputTokens: 120 });
  });

  test('derived outside the interval: the auth type decides', () => {
    const over = um(1000, 50, 0, 70, 1500); // derived 500 > 120
    expect(qwenUsage(over, 'openai')?.outputTokens).toBe(50);
    expect(qwenUsage(over, 'openai-responses')?.outputTokens).toBe(50);
    expect(qwenUsage(over, 'qwen-oauth')?.outputTokens).toBe(50);
    expect(qwenUsage(over, 'gemini-api-key')?.outputTokens).toBe(120);
    expect(qwenUsage(over, 'anthropic')?.outputTokens).toBe(120);
    expect(qwenUsage(over, null)?.outputTokens).toBe(120); // unknown: the "other" rule
    const under = um(1000, 50, 0, 70, 1020); // derived 20 < 50
    expect(qwenUsage(under, 'openai')?.outputTokens).toBe(50);
    expect(qwenUsage(under, null)?.outputTokens).toBe(120);
  });

  test('derived at both ends of the interval is taken', () => {
    expect(qwenUsage(um(100, 10, 0, 5, 110), null)?.outputTokens).toBe(10);
    expect(qwenUsage(um(100, 10, 0, 5, 115), 'openai')?.outputTokens).toBe(15);
  });

  test('totalTokenCount 0 or absent: never derived', () => {
    expect(qwenUsage(um(0, 0, 0, 0, 0), 'openai')).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
    expect(qwenUsage({ promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 5 }, 'openai')?.outputTokens).toBe(10);
    expect(qwenUsage({ promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 5 }, null)?.outputTokens).toBe(15);
  });

  test('cached larger than prompt: input is never negative', () => {
    expect(qwenUsage(um(10, 1, 20, 0, 11), null)?.inputTokens).toBe(0);
  });

  test('not an object, or no numeric count: null', () => {
    expect(qwenUsage(undefined, null)).toBeNull();
    expect(qwenUsage(null, null)).toBeNull();
    expect(qwenUsage('100', null)).toBeNull();
    expect(qwenUsage([], null)).toBeNull();
    expect(qwenUsage({}, null)).toBeNull();
    expect(qwenUsage({ promptTokenCount: '5', trafficType: 'x' }, null)).toBeNull();
    expect(qwenUsage({ candidatesTokenCount: 3 }, null)).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 3 });
  });
});
