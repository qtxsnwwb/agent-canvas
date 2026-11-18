import { describe, expect, test } from 'vitest';
import { classifyUser, promptText } from '../src/normalize/qwen-prompt.js';

// Spec 4.3 / format reference 3.4 (the product's display rule) and spec 4.1 (user record kinds).

const HOOK = '<qwen:user-prompt-submit-context>\nbranch: main\n</qwen:user-prompt-submit-context>';
const user = (parts: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'user', message: { role: 'user', parts }, ...extra });
const image = { inlineData: { mimeType: 'image/png', data: 'AAAA' } };

describe('promptText', () => {
  test('rule 1: systemPayload.displayText when hookContext is a string', () => {
    const rec = user([{ text: 'fix it\n\n--- Content from referenced files ---\nlots' }, { text: HOOK }], { systemPayload: { displayText: 'fix it @a.ts', hookContext: 'branch: main' } });
    expect(promptText(rec)).toEqual({ text: 'fix it @a.ts', images: 0 });
  });

  test('rule 1: displayText when the last part is a complete hook-context part (no hookContext)', () => {
    const rec = user([{ text: 'expanded' }, { text: HOOK }], { systemPayload: { displayText: 'typed' } });
    expect(promptText(rec)).toEqual({ text: 'typed', images: 0 });
  });

  test('rule 1: an empty displayText counts (no fall back to the parts); images are the non-text parts', () => {
    const rec = user([{ text: 'expanded' }, image, { text: HOOK }], { systemPayload: { displayText: '', hookContext: '' } });
    expect(promptText(rec)).toEqual({ text: '', images: 1 });
  });

  test('rule 1 does not apply without hookContext and without a hook part: the parts as they are (rule 3)', () => {
    const rec = user([{ text: 'as sent' }], { systemPayload: { displayText: 'typed' } });
    expect(promptText(rec)).toEqual({ text: 'as sent', images: 0 });
  });

  test('rule 2: no systemPayload and several parts ending in a complete hook part: that part left out', () => {
    const rec = user([{ text: 'one ' }, image, { text: 'two' }, { text: HOOK }]);
    expect(promptText(rec)).toEqual({ text: 'one two', images: 1 });
  });

  test('rule 2 needs a complete hook part and more than one part', () => {
    expect(promptText(user([{ text: HOOK }]))).toEqual({ text: HOOK, images: 0 });
    const open = '<qwen:user-prompt-submit-context>\nunclosed';
    expect(promptText(user([{ text: 'a' }, { text: open }]))).toEqual({ text: `a${open}`, images: 0 });
  });

  test('rule 3: old records: every text part, thought parts left out, images counted', () => {
    expect(promptText(user([{ text: 'a' }, { text: 'hidden', thought: true }, image, { text: 'b' }]))).toEqual({ text: 'ab', images: 1 });
  });

  test('a record without parts, or not an object, is empty', () => {
    expect(promptText({ type: 'user' })).toEqual({ text: '', images: 0 });
    expect(promptText(null)).toEqual({ text: '', images: 0 });
    expect(promptText(user(['bare string part' as unknown]))).toEqual({ text: '', images: 0 });
  });
});

describe('classifyUser (spec 4.1)', () => {
  test('each kind', () => {
    expect(classifyUser({ type: 'user' })).toBe('prompt');
    expect(classifyUser({ type: 'user', provenance: 'real_user' })).toBe('prompt');
    expect(classifyUser({ type: 'user', provenance: 'mod_prompt' })).toBe('mod-prompt');
    expect(classifyUser({ type: 'user', subtype: 'mid_turn_user_message' })).toBe('mid-turn-prompt');
    expect(classifyUser({ type: 'user', subtype: 'realtime_message' })).toBe('realtime-prompt');
    expect(classifyUser({ type: 'user', subtype: 'notification', provenance: 'system' })).toBe('notice');
    expect(classifyUser({ type: 'user', subtype: 'cron' })).toBe('notice');
    for (const s of ['goal_runtime', 'agent_mention', 'agent_message']) expect(classifyUser({ type: 'user', subtype: s })).toBe('hidden');
    expect(classifyUser({ type: 'user', subtype: 'something_new' })).toBe('unknown');
    expect(classifyUser({ type: 'user', subtype: 7 })).toBe('unknown');
    expect(classifyUser({ type: 'user', subtype: null })).toBe('prompt');
  });
});
