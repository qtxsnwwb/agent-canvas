import { describe, expect, test } from 'vitest';
import { buddyUsage } from '../src/normalize/buddy-usage.js';

// Format reference 6.3, with the project's convention (spec section 10 item 2): inputTokens = input not read from cache
// (cache writes stay in), cachedInputTokens = cache reads, outputTokens includes reasoning. `total` = the three summed.

const u = (inputTokens: number, cachedInputTokens: number, outputTokens: number) => ({
  usage: { inputTokens, cachedInputTokens, outputTokens },
  total: inputTokens + cachedInputTokens + outputTokens,
});

describe('buddyUsage: the shapes of format reference 6.3', () => {
  test('OpenAI-style raw usage: prompt_tokens includes the cached tokens', () => {
    expect(buddyUsage({ prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 600 } })).toEqual(u(400, 600, 50));
    // reasoning tokens are part of completion_tokens: not added again
    expect(buddyUsage({ prompt_tokens: 1000, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 20 } })).toEqual(u(1000, 0, 50));
  });

  test('DeepSeek-style raw usage: prompt_cache_hit_tokens are the cache reads; writes stay in the input', () => {
    expect(buddyUsage({ prompt_tokens: 140732, completion_tokens: 635, total_tokens: 141367, prompt_cache_hit_tokens: 76032 })).toEqual(u(64700, 76032, 635));
    expect(buddyUsage({ prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 700, prompt_cache_miss_tokens: 300, prompt_cache_write_tokens: 100 })).toEqual(u(300, 700, 10));
  });

  test('an inclusive prompt with cache writes (WorkBuddy): only the reads come off', () => {
    expect(buddyUsage({ prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 300 }, cache_creation_input_tokens: 400 })).toEqual(u(700, 300, 10));
  });

  test('the save-time message.usage mirror (snake_case): inclusive when total_tokens = input + output', () => {
    expect(buddyUsage({ input_tokens: 24486, output_tokens: 3, total_tokens: 24489, cache_read_input_tokens: 14720 })).toEqual(u(9766, 14720, 3));
  });

  test('Anthropic-style exclusive input (no proof of inclusion): cache writes are added, reads not subtracted', () => {
    expect(buddyUsage({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 500, cache_creation_input_tokens: 200 })).toEqual(u(300, 500, 20));
    // a total that is not input + output does not prove inclusion
    expect(buddyUsage({ input_tokens: 100, output_tokens: 20, total_tokens: 820, cache_read_input_tokens: 500, cache_creation_input_tokens: 200 })).toEqual(u(300, 500, 20));
  });

  test('SDK camelCase usage: inputTokensDetails (array or object) proves inclusion; totalTokens = input + output too', () => {
    expect(buddyUsage({ inputTokens: 24486, outputTokens: 3, totalTokens: 24489, inputTokensDetails: [{ cached_tokens: 14720 }] })).toEqual(u(9766, 14720, 3));
    expect(buddyUsage({ inputTokens: 2000, outputTokens: 5, inputTokensDetails: { cached_tokens: 1500 } })).toEqual(u(500, 1500, 5));
    expect(buddyUsage({ inputTokens: 2000, outputTokens: 5, inputTokensDetails: [{}, { cached_tokens: 0 }, { cached_tokens: 900 }] })).toEqual(u(1100, 900, 5));
    expect(buddyUsage({ inputTokens: 24486, outputTokens: 3, totalTokens: 24489 })).toEqual(u(24486, 0, 3));
  });

  test('camelCase cache keys without proof of inclusion: exclusive', () => {
    expect(buddyUsage({ inputTokens: 100, outputTokens: 7, cacheReadInputTokens: 400, cacheCreationInputTokens: 50 })).toEqual(u(150, 400, 7));
  });

  test('other aliases: promptTokens / completionTokens, cacheTokens / cache_tokens as cache reads', () => {
    expect(buddyUsage({ promptTokens: 300, completionTokens: 30 })).toEqual(u(300, 0, 30));
    expect(buddyUsage({ input_tokens: 80, output_tokens: 8, cacheTokens: 40 })).toEqual(u(80, 40, 8));
    expect(buddyUsage({ prompt_tokens: 80, completion_tokens: 8, cache_tokens: 40 })).toEqual(u(40, 40, 8));
  });

  test('the first positive cache-read alias wins, in the engine order', () => {
    expect(buddyUsage({ prompt_tokens: 500, completion_tokens: 1, cache_read_input_tokens: 0, prompt_tokens_details: { cached_tokens: 50 }, prompt_cache_hit_tokens: 70 })).toEqual(u(450, 50, 1));
    expect(buddyUsage({ prompt_tokens: 500, completion_tokens: 1, cache_read_input_tokens: 20, prompt_cache_hit_tokens: 70 })).toEqual(u(480, 20, 1));
  });

  test('more cache than prompt: input is 0, never negative', () => {
    expect(buddyUsage({ prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 300 })).toEqual(u(0, 300, 1));
  });

  test('output only, input only', () => {
    expect(buddyUsage({ completion_tokens: 5 })).toEqual(u(0, 0, 5));
    expect(buddyUsage({ prompt_tokens: 5 })).toEqual(u(5, 0, 0));
  });

  test('not a usage object: null', () => {
    for (const v of [undefined, null, 5, 'x', [], {}, { credit: 1.5 }, { total_tokens: 10 }, { prompt_tokens: 'many' }]) expect(buddyUsage(v)).toBeNull();
  });
});
