import { beforeEach, expect, test } from 'vitest';
import type { Change } from '@agent-canvas/shared';
import { Normalizer } from '../src/normalize/normalizer.js';
import { hook, rawLine, run, userPrompt } from './fixtures.js';

let n: Normalizer;
beforeEach(() => {
  n = new Normalizer();
});

const finalTitle = (changes: Change[]) => {
  const last = changes.filter((c) => c.type === 'session_upserted').at(-1);
  return last?.type === 'session_upserted' ? last.session.title : undefined;
};
const imagePrompt = (uuid: string, parent: string | null, ...blocks: object[]) =>
  userPrompt(uuid, parent, '', { message: { role: 'user', content: blocks } });

test('首条提示只有空白：不产生标题，第二条提示也不会成为标题', () => {
  const { changes } = run(n, [userPrompt('u1', null, '  \n\t '), userPrompt('u2', 'u1', '第二条')]);
  expect(finalTitle(changes)).toBeNull();
});

test('首条提示只有图片占位：不产生标题，之后的提示也不会成为标题', () => {
  const { changes } = run(n, [imagePrompt('u1', null, { type: 'image', source: {} }), userPrompt('u2', 'u1', '第二条')]);
  expect(finalTitle(changes)).toBeNull();
});

test('提示标题：去掉首尾空白，换行（含 CRLF、单独的 CR）折成单个空格，再取前 60 个码点', () => {
  const a = run(n, [userPrompt('u1', null, '  第一行\r\n第二行\n第三行\r第四行  ')]);
  expect(finalTitle(a.changes)).toBe('第一行 第二行 第三行 第四行');
  const b = run(new Normalizer(), [userPrompt('u1', null, '😀'.repeat(80))]);
  expect(Array.from(finalTitle(b.changes)!)).toHaveLength(60);
});

test('系统包装的“提示”从不成为标题', () => {
  for (const text of ['<system-reminder>x</system-reminder>', '<local-command-stdout>out</local-command-stdout>']) {
    const { changes } = run(new Normalizer(), [userPrompt('u1', null, text)]);
    expect(finalTitle(changes)).toBeNull();
  }
});

test('custom / agentName 的空值或纯空白不会清掉已有的 hook 或 prompt 标题', () => {
  const { changes } = run(n, [
    userPrompt('u1', null, '提示标题'),
    rawLine('custom-title', { customTitle: '' }),
    rawLine('agent-name', { agentName: '   ' }),
  ]);
  expect(finalTitle(changes)).toBe('提示标题');
  const h = run(new Normalizer(), [
    hook('UserPromptSubmit', { prompt: 'p', session_title: 'hook 标题' }),
    rawLine('custom-title', { customTitle: '' }),
    rawLine('agent-name', { agentName: '' }),
  ]);
  expect(finalTitle(h.changes)).toBe('hook 标题');
});

test('子代理文件里的 custom-title / agent-name 被静默忽略：不是标题，也不计入未识别', () => {
  const { changes, unknown } = run(n, [
    userPrompt('u1', null, '主线'),
    rawLine('custom-title', { customTitle: '子代理标题', agentId: 'ag1' }),
    rawLine('agent-name', { agentName: '子代理名', agentId: 'ag1' }),
  ]);
  expect(finalTitle(changes)).toBe('主线');
  expect(unknown).toEqual([]);
});
