import { MASK_TYPE_LABELS, MASK_TYPES, type ExportBundle, type GraphNode, type NodeDetail, type NodeStatus, type Origin } from '@agent-canvas/shared';
import { buildStructure, type DocStep } from './structure.js';

/**
 * The Markdown export (spec 4.5): a header (title, origin, times, export info, mask report, caution line), a section per
 * main-thread turn, each step in reading order (structure.ts). Everything in the bundle is already masked.
 *
 * How session text is written, by kind:
 * - free text (prompts, replies, system notes, titles in headings, header fields): escaped Markdown — every character
 *   that could start emphasis, code, a link or image, raw HTML, an entity, a table or strikethrough is
 *   backslash-escaped, `://`, `www.` and `@` are broken up so renderers do not autolink them, and line starts that would
 *   make a heading, list, quote or rule are escaped; line breaks are kept as hard breaks;
 * - code-like content (thinking, tool input and output): fenced code blocks, the fence one backtick longer than the
 *   longest backtick run inside (at least three), so nothing inside can end the block or be rendered (a `</details>` in
 *   it stays text);
 * - bidirectional control characters (U+202A–U+202E, U+2066–U+2069) are replaced by U+FFFD everywhere.
 * Nodes left out by the options leave no trace except the options line of the header.
 */

const CAUTION = '导出内容可能仍含敏感信息，分享前请自己再看一遍。';
const ORIGIN_LABELS: Record<Origin, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
const STATUS_LABELS: Record<NodeStatus, string> = {
  running: '运行中',
  awaiting_permission: '等待授权',
  succeeded: '成功',
  failed: '失败',
  denied: '被拒绝',
};
const OUTPUT_LABELS = { head: '每步前 8 KB', full: '全部', none: '不含' } as const;
const CATEGORY_LABELS = { credential: '固定格式的凭据', assignment: '赋值形式', personal: '个人信息', custom: '自定义词' } as const;

const BIDI = /[\u202a-\u202e\u2066-\u2069]/g;
const noBidi = (s: string): string => s.replace(BIDI, '\ufffd');

/** One line of free text, escaped (see the module comment). */
function escapeLine(line: string): string {
  let s = noBidi(line)
    .replace(/[\\`*_[\]<>&|~#!@]/g, (c) => `\\${c}`)
    .replace(/:\/\//g, '\\://')
    .replace(/(w)(ww)\./gi, '$1$2\\.');
  // Line starts: list markers, setext underlines, ordered lists.
  s = s.replace(/^(\s*)([-+=])/, '$1\\$2').replace(/^(\s*\d{1,9})([.)])/, '$1\\$2');
  return s;
}

/** Free text as Markdown paragraphs: blank lines separate paragraphs, other line breaks are hard breaks. */
function paragraphs(text: string, prefix = ''): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') {
      out.push(prefix.trimEnd());
      continue;
    }
    const nextBlank = i + 1 >= lines.length || lines[i + 1]!.trim() === '';
    out.push(prefix + escapeLine(line) + (nextBlank ? '' : '\\'));
  }
  // No leading/trailing empty lines; collapse runs of empty lines.
  const joined: string[] = [];
  for (const l of out) {
    if (l === prefix.trimEnd() && (joined.length === 0 || joined[joined.length - 1] === prefix.trimEnd())) continue;
    joined.push(l);
  }
  while (joined.length > 0 && joined[joined.length - 1] === prefix.trimEnd()) joined.pop();
  return joined.join('\n');
}

/** A single-line escaped text (for headings and list items). */
function inline(text: string): string {
  return escapeLine(text.replace(/[\r\n]+/g, ' '));
}

/** A fenced code block whose fence is longer than any backtick run in the content. */
export function fence(content: string, info = ''): string {
  let longest = 0;
  for (const m of content.matchAll(/`+/g)) if (m[0].length > longest) longest = m[0].length;
  const f = '`'.repeat(Math.max(3, longest + 1));
  const body = noBidi(content).replace(/\r\n?/g, '\n');
  return `${f}${info}\n${body}${body.endsWith('\n') || body === '' ? '' : '\n'}${f}`;
}

function duration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} 秒`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${Math.round(s - m * 60)} 秒`;
}

function valueBlock(value: unknown, info: string): string {
  if (typeof value === 'string') return fence(value, 'text');
  let json: string | undefined;
  try {
    json = JSON.stringify(value, null, 2);
  } catch {
    json = undefined;
  }
  return fence(json ?? String(value), info);
}

interface Ctx {
  details: Record<string, NodeDetail>;
  truncations: Record<string, { originalBytes: number }>;
  unreadable: Set<string>;
}

function stepHeading(node: GraphNode, level: number): string {
  const name = node.kind === 'subagent' ? `子代理：${node.title}` : node.toolName ?? node.title;
  const parts = [inline(name)];
  if (node.status !== null) parts.push(STATUS_LABELS[node.status] ?? inline(String(node.status)));
  const d = duration(node.durationMs);
  if (d !== null) parts.push(d);
  return `${'#'.repeat(Math.min(6, level))} ${parts.join(' · ')}`;
}

function renderSteps(steps: DocStep[], ctx: Ctx, level: number, out: string[]): void {
  for (const step of steps) {
    const node = step.node;
    const detail = ctx.details[node.id];
    const broken = ctx.unreadable.has(node.id);
    const text = detail?.text ?? null;
    switch (node.kind) {
      case 'prompt':
        out.push(`**提示**`, paragraphs(text ?? node.summary, '> '));
        break;
      case 'text':
        out.push(paragraphs(text ?? node.summary));
        break;
      case 'thinking':
        out.push(`<details><summary>思考</summary>\n\n${fence(text ?? node.summary, 'text')}\n\n</details>`);
        break;
      case 'tool':
      case 'subagent': {
        out.push(stepHeading(node, level));
        if (detail?.input !== null && detail?.input !== undefined) out.push('输入：', valueBlock(detail.input, 'json'));
        else if (node.summary !== '' && !broken) out.push(paragraphs(node.summary));
        if (detail?.output !== null && detail?.output !== undefined) {
          out.push('输出：', valueBlock(detail.output, 'json'));
          const cut = ctx.truncations[node.id];
          if (cut !== undefined) out.push(`（已截断，原始 ${Math.max(1, Math.ceil(cut.originalBytes / 1024))} KB）`);
        }
        if (text !== null && text !== '') out.push(paragraphs(text));
        break;
      }
      case 'system':
        out.push(`**系统：${inline(node.title)}**`);
        if ((text ?? node.summary) !== '') out.push(paragraphs(text ?? node.summary));
        break;
      default:
        out.push(`**${inline(node.title)}**`);
        if (node.summary !== '') out.push(paragraphs(node.summary));
    }
    if (broken) out.push('（详情已损坏）');
    if (step.agent !== null) {
      const inner: string[] = [];
      renderSteps(step.agent.steps, ctx, level + 1, inner);
      out.push(`<details><summary>子代理内部的步骤（${step.agent.steps.length} 步）</summary>`, ...inner, '</details>');
    }
  }
}

export function renderMarkdown(bundle: ExportBundle): string {
  const { session, options, report } = bundle;
  const out: string[] = [];
  out.push(`# ${session.title !== null && session.title.trim() !== '' ? inline(session.title) : '未命名会话'}`);
  const info: string[] = [`来源：${ORIGIN_LABELS[session.origin] ?? inline(String(session.origin))}`];
  info.push(`开始：${inline(session.startedAt)}`, `最后活动：${inline(session.lastActivityAt)}`);
  if (session.cwd !== null) info.push(`工作目录：${inline(session.cwd)}`);
  if (session.gitBranch !== null) info.push(`分支：${inline(session.gitBranch)}`);
  info.push(`会话：${inline(session.id)}`);
  info.push(`导出：${inline(`${bundle.tool.name} ${bundle.tool.version}`)}，${inline(bundle.exportedAt)}（导出的是开始导出时的内容）`);
  info.push(`范围：${options.scope.kind === 'session' ? '整个会话' : `第 ${bundle.turnNumber ?? '?'} 轮及其子代理`}`);
  info.push(
    `内容：${options.thinking ? '含思考' : '不含思考'}；${options.subagents ? '含子代理内部的步骤' : '不含子代理内部的步骤'}；工具输出：${OUTPUT_LABELS[options.output]}`,
  );
  const categories = (Object.keys(CATEGORY_LABELS) as (keyof typeof CATEGORY_LABELS)[]).filter((k) => options.mask[k]);
  const found = MASK_TYPES.filter((t) => (report.byType[t]?.occurrences ?? 0) > 0).map(
    (t) => `${MASK_TYPE_LABELS[t]} ${report.byType[t]!.occurrences} 处`,
  );
  info.push(
    categories.length === 0
      ? '遮蔽：未遮蔽'
      : `遮蔽：${categories.map((k) => CATEGORY_LABELS[k]).join('、')}；${found.length === 0 ? '没有找到需要遮蔽的内容' : `找到 ${found.join('，')}`}`,
  );
  out.push(info.map((l) => `- ${l}`).join('\n'));
  out.push(`> ${CAUTION}`);

  const ctx: Ctx = { details: bundle.details, truncations: bundle.truncations, unreadable: new Set(bundle.unreadable) };
  const structure = buildStructure(bundle.nodes);
  const first = options.scope.kind === 'turn' && bundle.turnNumber !== undefined ? bundle.turnNumber : 1;
  structure.turns.forEach((t, i) => {
    out.push(`## 第 ${first + i} 轮`);
    renderSteps(t.steps, ctx, 3, out);
  });
  if (structure.orphanAgents.length > 0) {
    out.push('## 其他子代理的步骤');
    for (const agent of structure.orphanAgents) {
      out.push(`### 子代理 ${inline(agent.agentId)}`);
      renderSteps(agent.steps, ctx, 4, out);
    }
  }
  return `${out.join('\n\n')}\n`;
}
