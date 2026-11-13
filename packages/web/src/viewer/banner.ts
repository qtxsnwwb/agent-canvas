import { MASK_TYPE_LABELS, MASK_TYPES, type ExportBundle } from '@agent-canvas/shared';
import { maskWarnings } from '../export';
import { sessionName } from './data';

/** The banner at the top of an exported file: what it is, the mask report, the options, the caution line. */

export const EXPORT_CAUTION = '内容可能仍含敏感信息：遮蔽不保证完整，转发前请自己再看一遍。';

export interface BannerModel {
  /** “Agent Canvas 导出的只读快照 · 导出于 <time> · <session title>” */
  headline: string;
  /** One chip per masked type, in the report's order. */
  chips: { label: string; count: number }[];
  /** “未遮蔽”, “遮蔽了 N 处”, or masking on with nothing found. */
  maskLine: string;
  /** The scope and content options in words. */
  optionsLine: string;
  /** Masking limits the export reached (learned values capped / skipped, numbering capped). */
  warnings: string[];
  caution: string;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local `YYYY-MM-DD HH:mm`; the text as it is when it is not a time. */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const OUTPUT_TEXT = { head: '每步前 8 KB', full: '全部', none: '不含' } as const;

export function bannerModel(bundle: ExportBundle): BannerModel {
  const { options, report } = bundle;
  const chips: BannerModel['chips'] = [];
  const byType = report.byType as Record<string, { occurrences?: unknown } | undefined>;
  for (const type of MASK_TYPES) {
    const entry = Object.prototype.hasOwnProperty.call(byType, type) ? byType[type] : undefined;
    const count = entry?.occurrences;
    if (typeof count === 'number' && Number.isInteger(count) && count > 0) chips.push({ label: MASK_TYPE_LABELS[type], count });
  }
  const anyOn = Object.values(options.mask).some((v) => v === true);
  const total = chips.reduce((n, c) => n + c.count, 0);
  const maskLine = !anyOn && total === 0 ? '未遮蔽' : total === 0 ? '遮蔽已开启，没有找到需要遮蔽的内容' : `遮蔽了 ${total} 处`;
  const scope = options.scope.kind === 'session'
    ? '整个会话'
    : typeof bundle.turnNumber === 'number' ? `第 ${bundle.turnNumber} 轮` : '一轮';
  const output = Object.prototype.hasOwnProperty.call(OUTPUT_TEXT, options.output)
    ? OUTPUT_TEXT[options.output]
    : String(options.output);
  const optionsLine = [
    `范围：${scope}`,
    options.thinking ? '包含思考' : '不含思考',
    options.subagents ? '包含子代理内部步骤' : '不含子代理内部步骤',
    `工具输出：${output}`,
  ].join(' · ');
  return {
    headline: `Agent Canvas 导出的只读快照 · 导出于 ${formatTime(bundle.exportedAt)} · ${sessionName(bundle.session)}`,
    chips,
    maskLine,
    optionsLine,
    warnings: maskWarnings(report),
    caution: EXPORT_CAUTION,
  };
}
