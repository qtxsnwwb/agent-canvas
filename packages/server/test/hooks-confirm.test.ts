import { PassThrough } from 'node:stream';
import { expect, test } from 'vitest';
import { confirmOnStreams } from '../src/hooks-cli.js';

function ask(feed: (input: PassThrough) => void): { result: Promise<boolean>; output: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (c: Buffer) => (written += c.toString()));
  const result = confirmOnStreams('写入以上改动？(y/N) ', input, output);
  feed(input);
  return { result, output: () => written };
}

test.each([
  ['y\n', true],
  ['YES\n', true],
  ['yes\n', true],
  ['n\n', false],
  ['\n', false],
  ['maybe\n', false],
])('回答 %j => %s', async (line, expected) => {
  const { result } = ask((i) => i.write(line));
  expect(await result).toBe(expected);
});

test('输入结束且没有数据：false', async () => {
  const { result } = ask((i) => i.end());
  expect(await result).toBe(false);
});

test('问题文字写到输出', async () => {
  const { result, output } = ask((i) => i.write('n\n'));
  await result;
  expect(output()).toContain('写入以上改动？(y/N) ');
});
