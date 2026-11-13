import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { EXPORT_TEMPLATE_PLACEHOLDER, type ExportBundle } from '@agent-canvas/shared';
import { contentDisposition, exportFileName } from '../src/export/filename.js';
import { embedJson, fillTemplate, findViewerTemplate, viewerTemplateCandidates } from '../src/export/html.js';
import { EXPORT_SETTINGS_FILE, loadExportSettings, saveExportSettings } from '../src/export/settings.js';
import { homeUsersOf } from '../src/export/assemble.js';
import { truncateUtf8 } from '../src/export/truncate.js';

// ---- truncation ----

test('不超过上限时不截断', () => {
  expect(truncateUtf8('abc', 3)).toBeNull();
});

test('按 UTF-8 字节截断在字符边界上，记下原始大小', () => {
  expect(truncateUtf8('abcdef', 4)).toEqual({ text: 'abcd', originalBytes: 6 });
  // 中 is 3 bytes: 5 bytes fit one character only.
  expect(truncateUtf8('中文字', 5)).toEqual({ text: '中', originalBytes: 9 });
  // 😀 is 4 bytes (a surrogate pair): never split.
  expect(truncateUtf8('a😀b', 3)).toEqual({ text: 'a', originalBytes: 6 });
  expect(truncateUtf8('a😀b', 5)).toEqual({ text: 'a😀', originalBytes: 6 });
});

test('截断点落在占位符里时截在占位符之前', () => {
  const ph = '‹已遮蔽·OpenAI key#1›';
  const text = `abc${ph}tail`;
  const cut = truncateUtf8(text, 3 + 6);
  expect(cut).toEqual({ text: 'abc', originalBytes: Buffer.byteLength(text) });
  // A cut right after the placeholder keeps it whole.
  expect(truncateUtf8(text, 3 + Buffer.byteLength(ph))!.text).toBe(`abc${ph}`);
});

test('原文里单独的 ‹ 不影响截断', () => {
  expect(truncateUtf8('a‹bcdefgh', 6)!.text).toBe('a‹bc');
});

// ---- HTML embedding ----

const hostile = '</script><script>alert(1)</script> <!-- ]]> \u2028\u2029 \ud800 lone \udc00 $& $1 $$ $` $\' & > <';

test('embedJson：转义 < > & U+2028 U+2029，仍是合法的 JSON，解析回原值', () => {
  const value = { text: hostile, n: 1 };
  const json = embedJson(value);
  expect(json).not.toMatch(/[<>&\u2028\u2029]/);
  expect(JSON.parse(json)).toEqual(value);
});

test('fillTemplate：只替换一次占位符，$ 模式不被解释，数据不能结束脚本块', () => {
  const template = `<!doctype html><html><head><script id="agent-canvas-export" type="application/json">${EXPORT_TEMPLATE_PLACEHOLDER}</script></head><body>${EXPORT_TEMPLATE_PLACEHOLDER}</body></html>`;
  const bundle = { session: { title: hostile } } as unknown as ExportBundle;
  const html = fillTemplate(template, bundle);
  const start = html.indexOf('type="application/json">') + 'type="application/json">'.length;
  const end = html.indexOf('</script>', start);
  const embedded = html.slice(start, end);
  expect(JSON.parse(embedded)).toEqual(bundle);
  expect(embedded).not.toContain('<');
  // The second placeholder (outside the script element) is untouched; nothing after the data was changed.
  expect(html.slice(end)).toBe(`</script></head><body>${EXPORT_TEMPLATE_PLACEHOLDER}</body></html>`);
  expect(html.match(/<\/script>/g)!.length).toBe(1);
});

test('fillTemplate：模板里没有占位符的脚本块时报错', () => {
  expect(() => fillTemplate('<html></html>', {} as ExportBundle)).toThrow();
});

test('findViewerTemplate：按候选顺序找第一个存在的文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-export-tpl-'));
  try {
    const here = path.join(dir, 'packages', 'server', 'src', 'export');
    fs.mkdirSync(here, { recursive: true });
    const candidates = viewerTemplateCandidates(here);
    expect(candidates).toContain(path.join(dir, 'packages', 'web', 'dist', 'viewer-template.html'));
    expect(findViewerTemplate(here)).toBeNull();
    fs.mkdirSync(path.join(dir, 'packages', 'web', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'packages', 'web', 'dist', 'viewer-template.html'), 'x');
    expect(findViewerTemplate(here)).toBe(path.join(dir, 'packages', 'web', 'dist', 'viewer-template.html'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- file name ----

const DAY = new Date(2026, 10, 13, 15, 0, 0);

test('文件名：标题的安全形式、日期、扩展名', () => {
  expect(exportFileName('修复 登录/页面 bug!', DAY, 'md')).toEqual({
    utf8: 'agent-canvas-修复-登录-页面-bug-20261113.md',
    ascii: 'agent-canvas-bug-20261113.md',
  });
  expect(exportFileName(null, DAY, 'html').utf8).toBe('agent-canvas-session-20261113.html');
  expect(exportFileName('...', DAY, 'html').utf8).toBe('agent-canvas-session-20261113.html');
});

test('文件名：没有路径分隔符、控制字符、双向控制符、两端的点，最多 40 个字符', () => {
  const name = exportFileName('..\\..\\etc/passwd\u0000\u202e\u2066txt.exe\r\n' + 'x'.repeat(100), DAY, 'html');
  for (const n of [name.utf8, name.ascii]) {
    expect(n).not.toMatch(/[\\/\u0000-\u001f\u202a-\u202e\u2066-\u2069:*?"<>|]/);
    expect(n.startsWith('agent-canvas-')).toBe(true);
    expect(n.endsWith('-20261113.html')).toBe(true);
  }
  const slug = name.utf8.slice('agent-canvas-'.length, -'-20261113.html'.length);
  expect([...slug].length).toBeLessThanOrEqual(40);
});

test('Content-Disposition：ASCII 后备名加 RFC 5987 的 UTF-8 名', () => {
  const header = contentDisposition(exportFileName('修复 "登录"', DAY, 'md'));
  expect(header).toBe(
    `attachment; filename="agent-canvas-session-20261113.md"; filename*=UTF-8''${encodeURIComponent('agent-canvas-修复-登录-20261113.md')}`,
  );
  expect(header).not.toMatch(/[^\x20-\x7e]/);
});

// ---- settings ----

let dataDir: string;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-export-settings-'));
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('设置：没有文件时为空', () => {
  expect(loadExportSettings(dataDir)).toEqual({ customTerms: [], settingsError: null });
});

test('设置：保存后读回；写入是原子的（不留临时文件）', () => {
  saveExportSettings(path.join(dataDir, 'nested'), { customTerms: ['acme', '项目代号'] });
  expect(loadExportSettings(path.join(dataDir, 'nested'))).toEqual({ customTerms: ['acme', '项目代号'], settingsError: null });
  expect(fs.readdirSync(path.join(dataDir, 'nested'))).toEqual([EXPORT_SETTINGS_FILE]);
});

test.each([
  ['不是 JSON', '{nope'],
  ['不是对象', '[]'],
  ['词不合法', JSON.stringify({ customTerms: ['ab'] })],
  ['词不是数组', JSON.stringify({ customTerms: 'acme' })],
])('设置文件损坏（%s）时按没有自定义词处理，并说明原因', (_name, content) => {
  fs.writeFileSync(path.join(dataDir, EXPORT_SETTINGS_FILE), content);
  const r = loadExportSettings(dataDir);
  expect(r.customTerms).toEqual([]);
  expect(r.settingsError).toMatch(/导出设置/);
});

// ---- home users ----

test('从工作目录取用户名', () => {
  expect(homeUsersOf('C:\\Users\\alice\\proj')).toEqual(['alice']);
  expect(homeUsersOf('d:/users/bob')).toEqual(['bob']);
  expect(homeUsersOf('/Users/carol/x')).toEqual(['carol']);
  expect(homeUsersOf('/home/dave')).toEqual(['dave']);
  expect(homeUsersOf('/srv/app')).toEqual([]);
  expect(homeUsersOf(null)).toEqual([]);
});
