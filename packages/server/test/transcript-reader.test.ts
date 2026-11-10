import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyPath } from '../src/sources/transcript/paths.js';
import { readNewLines } from '../src/sources/transcript/reader.js';

let dir: string;
let f: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-reader-'));
  f = path.join(dir, 't.jsonl');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

test.each([
  ['proj/abc.jsonl', { kind: 'session', projectId: 'proj', sessionId: 'abc' }],
  ['proj/abc/subagents/agent-a1.jsonl', { kind: 'agent', projectId: 'proj', sessionId: 'abc', agentId: 'a1' }],
  ['proj\\abc\\subagents\\agent-a1.meta.json', { kind: 'agent_meta', projectId: 'proj', sessionId: 'abc', agentId: 'a1' }],
  ['proj/abc/custom-title.json', { kind: 'title', projectId: 'proj', sessionId: 'abc' }],
  ['proj/abc/subagents/agent-a1.prefix.json', null],
  ['proj/abc/tool-results/x.jpg', null],
])('classifyPath %s', (rel, expected) => {
  expect(classifyPath('/root', path.join('/root', rel))).toEqual(expected);
});

test('读出完整行并给出偏移', async () => {
  await fs.writeFile(f, 'aa\nbbb\n');
  expect(await readNewLines(f, 0)).toEqual({
    lines: [
      { offset: 0, text: 'aa' },
      { offset: 3, text: 'bbb' },
    ],
    newOffset: 7,
    truncated: false,
  });
});
test('半行不返回，补全后再读到', async () => {
  await fs.writeFile(f, 'aa\nbb');
  const r1 = await readNewLines(f, 0);
  expect(r1.lines.map((l) => l.text)).toEqual(['aa']);
  expect(r1.newOffset).toBe(3);
  await fs.appendFile(f, 'b\n');
  const r2 = await readNewLines(f, r1.newOffset);
  expect(r2.lines).toEqual([{ offset: 3, text: 'bbb' }]);
});
test('多字节字符跨读取块边界不乱码', async () => {
  const line = '中'.repeat(40_000);
  await fs.writeFile(f, line + '\n你好\n');
  const r = await readNewLines(f, 0);
  expect(r.lines[0].text).toBe(line);
  expect(r.lines[1].text).toBe('你好');
});
test('文件变短时标记 truncated 并从头读', async () => {
  await fs.writeFile(f, 'x\n');
  const r = await readNewLines(f, 500);
  expect(r.truncated).toBe(true);
  expect(r.lines.map((l) => l.text)).toEqual(['x']);
});
test('maxBytes 在行边界停下，可续读', async () => {
  await fs.writeFile(f, 'a'.repeat(100) + '\n' + 'b'.repeat(100) + '\n');
  const r1 = await readNewLines(f, 0, 150);
  expect(r1.lines).toHaveLength(1);
  expect(r1.newOffset).toBe(101);
  expect((await readNewLines(f, r1.newOffset, 150)).lines).toHaveLength(1);
});
test('单行超过 maxBytes 仍完整读出', async () => {
  await fs.writeFile(f, 'a'.repeat(5000) + '\n');
  expect((await readNewLines(f, 0, 100)).lines[0].text).toHaveLength(5000);
});
test('文件不存在时返回空结果', async () => {
  expect(await readNewLines(path.join(dir, 'nope'), 0)).toEqual({ lines: [], newOffset: 0, truncated: false });
});
