import { expect, test } from 'vitest';
import type { ExportBundle, ExportOptions } from '@agent-canvas/shared';
import { bannerModel, EXPORT_CAUTION } from '../src/viewer/banner';
import { baseSession } from './helpers';

const options = (o: Partial<ExportOptions> = {}): ExportOptions => ({
  format: 'html', scope: { kind: 'session' }, thinking: true, subagents: true, output: 'head',
  mask: { credential: true, assignment: true, personal: false, custom: false }, ...o,
});

function bundle(o: Partial<ExportBundle> = {}): ExportBundle {
  return {
    version: 1, tool: { name: 'Agent Canvas', version: '0.1.0' },
    // Local time, so the formatted text does not depend on the machine's time zone.
    exportedAt: new Date(2026, 10, 13, 9, 5, 7).toISOString(),
    options: options(), report: { total: 0, byType: {} }, session: { ...baseSession, title: '修登录' },
    nodes: [], edges: [], details: {}, truncations: {}, unreadable: [], ...o,
  };
}

test('标题行：导出的只读快照 · 导出时间 · 会话标题', () => {
  const m = bannerModel(bundle());
  expect(m.headline).toBe('Agent Canvas 导出的只读快照 · 导出于 2026-11-13 09:05 · 修登录');
  expect(m.caution).toBe(EXPORT_CAUTION);
  expect(EXPORT_CAUTION).toContain('内容可能仍含敏感信息');
});

test('标题行：没有标题时用会话 id 的前 8 位；时间无法解析时原样显示', () => {
  const m = bannerModel(bundle({ exportedAt: 'later', session: { ...baseSession, id: '0123456789abc', title: null } }));
  expect(m.headline).toBe('Agent Canvas 导出的只读快照 · 导出于 later · 01234567');
});

test('遮蔽报告：每个类型一个标签（中文名：处数），按报告顺序', () => {
  const m = bannerModel(bundle({
    report: { total: 6, byType: { email: { occurrences: 2, distinct: 1 }, 'openai-key': { occurrences: 3, distinct: 2 }, assignment: { occurrences: 1, distinct: 1 } } },
  }));
  expect(m.chips).toEqual([
    { label: 'OpenAI key', count: 3 },
    { label: '密钥/密码', count: 1 },
    { label: '邮箱', count: 2 },
  ]);
  expect(m.maskLine).toBe('遮蔽了 6 处');
});

test('遮蔽报告：全部类别关闭时是“未遮蔽”；开着但没找到时说没有找到', () => {
  const off = bannerModel(bundle({ options: options({ mask: { credential: false, assignment: false, personal: false, custom: false } }) }));
  expect(off.chips).toEqual([]);
  expect(off.maskLine).toBe('未遮蔽');
  const none = bannerModel(bundle());
  expect(none.chips).toEqual([]);
  expect(none.maskLine).toBe('遮蔽已开启，没有找到需要遮蔽的内容');
});

test('遮蔽报告：类型名不认识或数量不对的条目被跳过', () => {
  const m = bannerModel(bundle({
    report: { total: 1, byType: { nope: { occurrences: 5, distinct: 1 }, jwt: { occurrences: -1 }, bearer: { occurrences: 1, distinct: 1 } } as never },
  }));
  expect(m.chips).toEqual([{ label: 'Bearer 令牌', count: 1 }]);
});

test('选项写成文字：范围和内容', () => {
  expect(bannerModel(bundle()).optionsLine).toBe('范围：整个会话 · 包含思考 · 包含子代理内部步骤 · 工具输出：每步前 8 KB');
  const turn = bannerModel(bundle({
    options: options({ scope: { kind: 'turn', turnKey: 'k' }, thinking: false, subagents: false, output: 'full' }), turnNumber: 3,
  }));
  expect(turn.optionsLine).toBe('范围：第 3 轮 · 不含思考 · 不含子代理内部步骤 · 工具输出：全部');
  const noNumber = bannerModel(bundle({ options: options({ scope: { kind: 'turn', turnKey: 'k' }, output: 'none' }) }));
  expect(noNumber.optionsLine).toBe('范围：一轮 · 包含思考 · 包含子代理内部步骤 · 工具输出：不含');
});
