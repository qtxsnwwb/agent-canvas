import type { UpstreamChain } from './chain';
import type { CanvasView } from './view';

export const THINKING_NOT_RECORDED = '思考内容未记录';
export const NO_REASONING = '这一步之前没有记录到思考或回复';

/**
 * One row of the drawer's "推理链" list. `time`: the node's ISO timestamp (formatted by the drawer). `missing`: a
 * thinking node whose content was not recorded (`text` is then THINKING_NOT_RECORDED, shown grey); `durationMs` is set
 * only for such a row (the duration stands in for the missing text). `current`: the selected node itself.
 */
export interface ReasoningRow {
  id: string;
  kind: 'thinking' | 'text';
  label: '思考' | '回复';
  time: string;
  text: string;
  missing: boolean;
  durationMs: number | null;
  current: boolean;
}

/** The rows for `chain.reasoning`, in its order; ids that are not graph nodes of kind thinking / text in `view` are skipped. */
export function reasoningRows(view: CanvasView, chain: UpstreamChain, selectedId: string | null): ReasoningRow[] {
  const rows: ReasoningRow[] = [];
  for (const id of chain.reasoning) {
    const vn = view.nodes.get(id);
    if (vn?.type !== 'node') continue;
    const { node } = vn;
    if (node.kind !== 'thinking' && node.kind !== 'text') continue;
    const thinking = node.kind === 'thinking';
    const missing = thinking && node.summary === '';
    rows.push({
      id,
      kind: node.kind,
      label: thinking ? '思考' : '回复',
      time: node.timestamp,
      text: missing ? THINKING_NOT_RECORDED : node.summary,
      missing,
      durationMs: missing ? node.durationMs : null,
      current: id === selectedId,
    });
  }
  return rows;
}
