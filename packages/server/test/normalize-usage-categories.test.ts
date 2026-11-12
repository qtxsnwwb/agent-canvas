import { beforeEach, describe, expect, test } from 'vitest';
import { Normalizer } from '../src/normalize/normalizer.js';
import { CodexNormalizer } from '../src/normalize/codex.js';
import { assistantBlock, run, userPrompt } from './fixtures.js';
import { CodexThread, run as runCodex } from './codex-fixtures.js';

/*
 * One token definition for every origin (fix wave of the stats work):
 * - inputTokens: input the model processed that was NOT read from cache ("新输入");
 * - cachedInputTokens: input read from cache ("缓存读取");
 * - outputTokens: output (Codex: reasoning included).
 * Claude's `input_tokens` excludes cache reads and cache writes (separate fields); Codex's `input_tokens` includes its
 * cached input (`cached_input_tokens` is a subset; total_tokens = input_tokens + output_tokens).
 */

describe('Claude Code usage categories', () => {
  let n: Normalizer;
  beforeEach(() => {
    n = new Normalizer();
  });
  const text = (usage: Record<string, unknown>) =>
    run(n, [userPrompt('u1', null, 'x'), assistantBlock('a1', 'u1', { type: 'text', text: 'hi' }, { usage })]).graph.nodes;
  const textNode = (nodes: ReturnType<typeof text>) => Object.values(nodes).find((x) => x.kind === 'text')!;

  test('new input = input_tokens + cache_creation_input_tokens; cached = cache_read_input_tokens', () => {
    const node = textNode(text({ input_tokens: 3, cache_creation_input_tokens: 400, cache_read_input_tokens: 25_000, output_tokens: 90 }));
    expect(node.usage).toEqual({ inputTokens: 403, cachedInputTokens: 25_000, outputTokens: 90 });
  });

  test('missing cache fields count as 0', () => {
    expect(textNode(text({ input_tokens: 10, output_tokens: 5 })).usage).toEqual({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 });
  });

  test('a missing input or output count is 0; non-numeric or negative values are 0; no count at all: no usage', () => {
    expect(textNode(text({ output_tokens: 7, cache_read_input_tokens: 'x' })).usage).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 7 });
    expect(textNode(text({ input_tokens: -4, cache_read_input_tokens: 12 })).usage).toEqual({ inputTokens: 0, cachedInputTokens: 12, outputTokens: 0 });
    expect(textNode(text({ service_tier: 'standard' })).usage).toBeNull();
  });
});

describe('Codex usage categories', () => {
  let n: CodexNormalizer;
  beforeEach(() => {
    n = new CodexNormalizer();
  });
  const usageAfter = (tokens: Parameters<CodexThread['usage']>[0]) => {
    const root = new CodexThread({ id: 'root1' });
    const r = runCodex(n, [root.meta(), root.started('t1'), root.user('u1', 'hi'), ...root.assistant('m1', 'hello'), root.usage(tokens), root.complete()]);
    return r.graph.nodes['text:m1']!.usage;
  };

  test('new input = input_tokens − cached_input_tokens; cached = cached_input_tokens; output = output_tokens', () => {
    // A real-shaped record: cache writes are part of input_tokens too, reasoning is part of output_tokens.
    expect(usageAfter({ input: 50_000, cached: 48_000, cacheWrite: 1_500, output: 600, reasoning: 400 })).toEqual({
      inputTokens: 2_000, cachedInputTokens: 48_000, outputTokens: 600,
    });
  });

  test('new input is never negative; cached is kept as reported', () => {
    expect(usageAfter({ input: 100, cached: 150, output: 1 })).toEqual({ inputTokens: 0, cachedInputTokens: 150, outputTokens: 1 });
  });

  test('a missing or invalid cached count is 0', () => {
    expect(usageAfter({ input: 100, cached: 'n/a', output: 1 })).toEqual({ inputTokens: 100, cachedInputTokens: 0, outputTokens: 1 });
  });

  test('two records on one node add up in every category', () => {
    const root = new CodexThread({ id: 'root1' });
    const r = runCodex(n, [
      root.meta(), root.started('t1'), root.user('u1', 'hi'), ...root.assistant('m1', 'hello'),
      root.usage({ input: 1_000, cached: 900, output: 10 }),
      root.usage({ input: 2_000, cached: 1_500, output: 20 }),
      root.complete(),
    ]);
    const carriers = Object.values(r.graph.nodes).filter((x) => x.usage !== null);
    const sum = carriers.reduce(
      (s, x) => ({ i: s.i + x.usage!.inputTokens, c: s.c + (x.usage!.cachedInputTokens ?? 0), o: s.o + x.usage!.outputTokens }),
      { i: 0, c: 0, o: 0 },
    );
    expect(sum).toEqual({ i: 600, c: 2_400, o: 30 });
  });
});
