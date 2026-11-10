import { sizeOf } from './sizes';
import type { CanvasSnapshot } from './useCanvas';

/** 最新节点的中心点；该节点还没有位置时返回 null。 */
export function followTarget(snapshot: Pick<CanvasSnapshot, 'view' | 'positions'>): { x: number; y: number } | null {
  const id = snapshot.view.latestNodeId;
  if (id === null) return null;
  const pos = snapshot.positions[id];
  const vn = snapshot.view.nodes.get(id);
  if (!pos || !vn) return null;
  const { width, height } = sizeOf(vn);
  return { x: pos.x + width / 2, y: pos.y + height / 2 };
}
