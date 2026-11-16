import { expect, test } from 'vitest';
import {
  defaultExportOptions,
  exportMaskCategories,
  parseExportOptions,
  parseExportSettings,
  validateCustomTerms,
  type ExportOptions,
} from '../src/index.js';

const valid: ExportOptions = defaultExportOptions(false);

test('默认选项：HTML、整个会话、含思考和子代理、输出前 8 KB、凭据和赋值开，个人信息关，自定义词有词才开', () => {
  expect(valid).toEqual({
    format: 'html',
    scope: { kind: 'session' },
    thinking: true,
    subagents: true,
    output: 'head',
    mask: { credential: true, assignment: true, personal: false, custom: false },
  });
  expect(defaultExportOptions(true).mask.custom).toBe(true);
  expect(exportMaskCategories(valid.mask)).toEqual(['credential', 'assignment']);
});

test('合法的选项原样通过', () => {
  expect(parseExportOptions(valid)).toEqual({ ok: true, options: valid });
  const turn: ExportOptions = { ...valid, format: 'md', scope: { kind: 'turn', turnKey: 'T1' }, output: 'none' };
  expect(parseExportOptions(turn)).toEqual({ ok: true, options: turn });
});

test.each<[string, unknown]>([
  ['不是对象', null],
  ['数组', []],
  ['缺字段', { ...valid, thinking: undefined }],
  ['多余字段', { ...valid, extra: 1 }],
  ['format 不对', { ...valid, format: 'pdf' }],
  ['scope 不是对象', { ...valid, scope: 'session' }],
  ['scope.kind 不对', { ...valid, scope: { kind: 'all' } }],
  ['session scope 多余字段', { ...valid, scope: { kind: 'session', turnKey: 'x' } }],
  ['turn scope 没有 turnKey', { ...valid, scope: { kind: 'turn' } }],
  ['turnKey 为空', { ...valid, scope: { kind: 'turn', turnKey: '' } }],
  ['turnKey 不是字符串', { ...valid, scope: { kind: 'turn', turnKey: 1 } }],
  ['thinking 不是布尔', { ...valid, thinking: 'yes' }],
  ['subagents 不是布尔', { ...valid, subagents: 1 }],
  ['output 不对', { ...valid, output: 'some' }],
  ['mask 缺类别', { ...valid, mask: { credential: true, assignment: true, personal: false } }],
  ['mask 多余类别', { ...valid, mask: { ...valid.mask, phone: true } }],
  ['mask 不是布尔', { ...valid, mask: { ...valid.mask, custom: 'true' } }],
])('不合法的选项：%s', (_name, body) => {
  const r = parseExportOptions(body);
  expect(r.ok).toBe(false);
});

test('错误信息不回显请求里的字段名或值', () => {
  const r = parseExportOptions({ ...valid, 'evil-field-name': 'evil-value' });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).not.toContain('evil');
  const s = parseExportSettings({ customTerms: [], 'evil-field-name': 1 });
  if (!s.ok) expect(s.error).not.toContain('evil');
});

test('自定义词：去空白、去重（不分 ASCII 大小写）、去掉空的', () => {
  expect(validateCustomTerms(['  Acme  ', 'acme', '', '   ', 'Project X', '项目代号'])).toEqual({
    ok: true,
    terms: ['Acme', 'Project X', '项目代号'],
  });
});

test.each<[string, unknown]>([
  ['不是数组', 'acme'],
  ['有非字符串', ['acme', 1]],
  ['太短', ['ab']],
  ['太长', ['x'.repeat(201)]],
  ['控制字符', ['ac\nme']],
  ['双向控制字符', ['abc‮']],
  ['零宽字符', ['ab​c']],
  ['太多', Array.from({ length: 101 }, (_, i) => `term${i}`)],
])('不合法的自定义词：%s', (_name, terms) => {
  expect(validateCustomTerms(terms).ok).toBe(false);
});

test('设置的请求体只接受 customTerms', () => {
  expect(parseExportSettings({ customTerms: ['acme'] })).toEqual({ ok: true, settings: { customTerms: ['acme'] } });
  expect(parseExportSettings({ customTerms: ['acme'], x: 1 }).ok).toBe(false);
  expect(parseExportSettings({}).ok).toBe(false);
  expect(parseExportSettings(null).ok).toBe(false);
});
