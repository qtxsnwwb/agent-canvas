import { expect, test } from 'vitest';
import { CUSTOM_TERMS_MAX, EXPORT_MAX_BYTES, maskWarnings } from '@agent-canvas/shared';
import {
  DEFAULT_DIALOG_OPTIONS, EXPORT_CAUTION, EXPORT_OPTIONS_KEY, buildExportOptions, createLatest, exportErrorText, fallbackFileName,
  fileNameFromDisposition, maskOffWarning, parseDialogOptions, previewView, serializeDialogOptions, settingsErrorText, settingsView,
  termsToText, validateTermsText,
} from '../src/export';

test('选项存在一个带版本的键里；读回时逐项校验，坏的项用默认值', () => {
  expect(EXPORT_OPTIONS_KEY).toBe('agent-canvas:export-options');
  expect(parseDialogOptions(null)).toEqual(DEFAULT_DIALOG_OPTIONS);
  expect(parseDialogOptions('{bad')).toEqual(DEFAULT_DIALOG_OPTIONS);
  expect(parseDialogOptions('{"v":2,"format":"md"}')).toEqual(DEFAULT_DIALOG_OPTIONS);
  const o = { ...DEFAULT_DIALOG_OPTIONS, format: 'md' as const, scope: 'turn' as const, thinking: false, output: 'none' as const,
    mask: { credential: false, assignment: true, personal: true, custom: false } };
  expect(parseDialogOptions(serializeDialogOptions(o))).toEqual(o);
  const mixed = parseDialogOptions(JSON.stringify({ v: 1, format: 'pdf', scope: 'turn', thinking: 'yes', subagents: false, output: 'all', mask: { credential: 0, custom: true } }));
  expect(mixed).toEqual({ ...DEFAULT_DIALOG_OPTIONS, scope: 'turn', subagents: false, mask: { ...DEFAULT_DIALOG_OPTIONS.mask, custom: true } });
});

test('默认值：HTML、整个会话、含思考和子代理、每步前 8 KB、凭据和赋值开、个人信息关、自定义词有词就开', () => {
  expect(DEFAULT_DIALOG_OPTIONS).toEqual({
    format: 'html', scope: 'session', thinking: true, subagents: true, output: 'head',
    mask: { credential: true, assignment: true, personal: false, custom: null },
  });
  const turn = { key: 't1', label: '第 1 轮' };
  expect(buildExportOptions(DEFAULT_DIALOG_OPTIONS, null, true).mask.custom).toBe(true);
  expect(buildExportOptions(DEFAULT_DIALOG_OPTIONS, null, false).mask.custom).toBe(false);
  expect(buildExportOptions(DEFAULT_DIALOG_OPTIONS, turn, true).scope).toEqual({ kind: 'session' });
  expect(buildExportOptions({ ...DEFAULT_DIALOG_OPTIONS, scope: 'turn' }, turn, true).scope).toEqual({ kind: 'turn', turnKey: 't1' });
  // No selected turn: the whole session, whatever was remembered.
  expect(buildExportOptions({ ...DEFAULT_DIALOG_OPTIONS, scope: 'turn' }, null, true).scope).toEqual({ kind: 'session' });
  expect(buildExportOptions(DEFAULT_DIALOG_OPTIONS, null, false)).toEqual({
    format: 'html', scope: { kind: 'session' }, thinking: true, subagents: true, output: 'head',
    mask: { credential: true, assignment: true, personal: false, custom: false },
  });
});

test('扫描结果：每个类型一行“<名称>：N 处（M 个不同的值）”，合计、节点数、大小', () => {
  const v = previewView({
    report: { total: 5, byType: { 'openai-key': { occurrences: 3, distinct: 1 }, email: { occurrences: 2, distinct: 2 } } },
    estimatedBytes: 3.25 * 1024 * 1024, nodeCount: 120, tooLarge: false,
  }, { kind: 'session' });
  expect(v.rows).toEqual(['OpenAI key：3 处（1 个不同的值）', '邮箱：2 处（2 个不同的值）']);
  expect(v.total).toBe('共 5 处');
  expect(v.nodes).toBe('120 个节点');
  expect(v.size).toBe('约 3.3 MB');
  expect(v.tooLarge).toBeNull();
  const none = previewView({ report: { total: 0, byType: {} }, estimatedBytes: 1000, nodeCount: 1, tooLarge: false }, { kind: 'session' });
  expect(none.rows).toEqual([]);
  expect(none.total).toBe('没有找到需要遮蔽的内容');
  expect(none.size).toBe('不到 0.1 MB');
  const failed = previewView({ report: { total: 1, byType: { failed: { occurrences: 1, distinct: 0 } } }, estimatedBytes: 0, nodeCount: 0, tooLarge: false }, { kind: 'session' });
  expect(failed.rows).toEqual(['处理失败：1 处']);
});

test('超过上限：不能导出；整个会话在不含工具输出时仍超过，就说整个会话导不了，建议只导出一轮', () => {
  const big = { report: { total: 0, byType: {} }, estimatedBytes: EXPORT_MAX_BYTES + 1, nodeCount: 9, tooLarge: true };
  expect(previewView(big, { kind: 'session' }, 'head').tooLarge).toBe('超过 50 MB，请只导出一轮或减少工具输出');
  expect(previewView(big, { kind: 'session' }, 'none').tooLarge).toBe('这个会话太大，整个会话无法导出（不含工具输出也超过 50 MB），请只导出一轮');
  expect(previewView(big, { kind: 'turn', turnKey: 'x' }, 'none').tooLarge).toBe('这一轮超过 50 MB，无法导出');
  expect(previewView(big, { kind: 'session' }).partial).toBe(true);
  // A stop in the first pass comes with an empty report; counts of a partial scan are not shown at all.
  const partial = previewView({ ...big, report: { total: 3, byType: { jwt: { occurrences: 3, distinct: 1 } } } }, { kind: 'session' });
  expect(partial.rows).toEqual([]);
  expect(partial.total).toBe('');
});

test('四类遮蔽都关时明确提示', () => {
  expect(maskOffWarning({ credential: false, assignment: false, personal: false, custom: false })).toBe('四类遮蔽都关了：导出的文件不会遮蔽任何内容。');
  expect(maskOffWarning({ credential: false, assignment: false, personal: false, custom: true })).toBeNull();
  expect(EXPORT_CAUTION).toBe('遮蔽不保证完整，分享前请自己再看一遍。');
});

test('错误：按状态码给出自己的话，不用服务端的文字', () => {
  expect(exportErrorText(400)).toContain('选项');
  expect(exportErrorText(403)).toContain('拒绝');
  expect(exportErrorText(404)).toBe('这个会话已经不存在了');
  expect(exportErrorText(409)).toContain('自定义词的设置文件已损坏');
  expect(exportErrorText(413)).toBe('超过 50 MB，请只导出一轮或减少工具输出');
  expect(exportErrorText(429)).toContain('稍后');
  expect(exportErrorText(501)).toBe('这个版本没有带 HTML 查看器，请改用 Markdown');
  expect(exportErrorText(500)).toContain('导出失败');
  expect(exportErrorText('network')).toContain('连不上');
  expect(exportErrorText(418)).toBe('导出失败（HTTP 418）');
  expect(settingsErrorText(400)).toContain('不符合要求');
  expect(settingsErrorText('network')).toContain('连不上');
});

test('文件名：优先 filename*（UTF-8 百分号编码），其次 filename，都没有时用默认名；去掉路径和控制字符', () => {
  expect(fileNameFromDisposition(`attachment; filename="agent-canvas-x-20261113.md"; filename*=UTF-8''agent-canvas-%E4%BF%AE%E7%99%BB%E5%BD%95-20261113.md`, 'md'))
    .toBe('agent-canvas-修登录-20261113.md');
  expect(fileNameFromDisposition('attachment; filename="agent-canvas-x-20261113.html"', 'html')).toBe('agent-canvas-x-20261113.html');
  expect(fileNameFromDisposition("attachment; filename*=utf-8''bad%E4%ZZ.md", 'md')).toBe(fallbackFileName('md'));
  expect(fileNameFromDisposition(null, 'html')).toBe('agent-canvas-export.html');
  expect(fileNameFromDisposition(`attachment; filename*=UTF-8''..%2F..%2Fevil%0A.md`, 'md')).toBe('.._.._evil_.md');
  // The extension must be the requested format's.
  expect(fileNameFromDisposition('attachment; filename="x.exe"', 'md')).toBe('agent-canvas-export.md');
});

test('自定义词：一行一个，按服务端的规则校验，错误带行号', () => {
  expect(validateTermsText('  alpha-1 \n\nbeta-two\n')).toEqual({ ok: true, terms: ['alpha-1', 'beta-two'] });
  const bad = validateTermsText('ok-term\nab\n' + 'x'.repeat(201));
  expect(bad.ok).toBe(false);
  if (!bad.ok) {
    expect(bad.errors[0]).toBe('第 2 行：自定义词至少 3 个字符');
    expect(bad.errors[1]).toBe('第 3 行：自定义词最多 200 个字符');
  }
  const many = validateTermsText(Array.from({ length: CUSTOM_TERMS_MAX + 1 }, (_, i) => `term-${i}`).join('\n'));
  expect(many.ok).toBe(false);
  if (!many.ok) expect(many.errors).toEqual([`最多 ${CUSTOM_TERMS_MAX} 个自定义词（现在 ${CUSTOM_TERMS_MAX + 1} 个）`]);
  const ctl = validateTermsText('abc\u0001def');
  expect(ctl.ok).toBe(false);
  // Invisible formatting characters (bidi overrides, zero-width) are refused like the server does.
  expect(validateTermsText('abc‮def').ok).toBe(false);
  expect(validateTermsText('abc​def').ok).toBe(false);
  // Case-insensitive duplicates are kept once (as the server does).
  expect(validateTermsText('Alpha\nALPHA')).toEqual({ ok: true, terms: ['Alpha'] });
  expect(termsToText(['a1', 'b2'])).toBe('a1\nb2');
});

test('设置的状态：正常、设置文件损坏、读取失败', () => {
  expect(settingsView({ customTerms: ['abc'], settingsError: null }, null)).toEqual({ state: 'ok', terms: ['abc'], note: null });
  expect(settingsView({ customTerms: [], settingsError: 'bad json' }, null)).toEqual({
    state: 'damaged', terms: [],
    note: '自定义词的设置文件已损坏：打开“自定义词”时导出会被拒绝，直到修好文件或在这里重新保存自定义词。',
  });
  expect(settingsView(null, 'network').state).toBe('error');
  expect(settingsView(null, null).state).toBe('loading');
});

test('只认最后一次请求：更早的晚到也被丢弃', () => {
  const latest = createLatest();
  const a = latest.next();
  const b = latest.next();
  expect(latest.isLatest(a)).toBe(false);
  expect(latest.isLatest(b)).toBe(true);
});

test('遮蔽达到上限时的提示：扫描结果里显示', () => {
  expect(maskWarnings({ total: 0, byType: {} })).toEqual([]);
  const w = maskWarnings({ total: 0, byType: {}, learnedCapped: true, learnedSkipped: 3, numberingCapped: true });
  expect(w).toHaveLength(3);
  expect(w[1]).toContain('3 段');
  const v = previewView({ report: { total: 1, byType: { jwt: { occurrences: 1, distinct: 1 } }, learnedSkipped: 2 }, estimatedBytes: 1, nodeCount: 1, tooLarge: false }, { kind: 'session' });
  expect(v.warnings).toEqual([maskWarnings({ total: 0, byType: {}, learnedSkipped: 2 })[0]]);
});
