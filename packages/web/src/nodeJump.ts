/**
 * Opening a session at a node (`#/s/<id>/n/<nodeId>`): what the session page does with the address. Pure, so the
 * "once per navigation, only when the graph is there" rule can be tested without a component.
 */
export interface NodeTarget {
  id: string;
  /** Grows with every navigation to a node, so the same node asked for again (after another one) is shown again. */
  seq: number;
}

/** The target after the address changed to `nodeId` (null: the address has no node): a new object only for a new id. */
export function nextNodeTarget(prev: NodeTarget | null, nodeId: string | null): NodeTarget | null {
  if (nodeId === null) return null;
  if (prev !== null && prev.id === nodeId) return prev;
  return { id: nodeId, seq: (prev?.seq ?? 0) + 1 };
}

export type NodeJumpAction =
  /** Nothing to do: no target, or this navigation was handled already. */
  | 'idle'
  /** The canvas model does not exist yet; ask again when it does. */
  | 'wait'
  /** The session has no such node: show the note and stay on the session. */
  | 'missing'
  /** Select it and bring it into view. */
  | 'show';

/** `handledSeq`: the seq of the last target already acted on (0 for none). Graph updates never reset it. */
export function nodeJumpAction(
  target: NodeTarget | null,
  handledSeq: number,
  ready: boolean,
  hasNode: (id: string) => boolean,
): NodeJumpAction {
  if (target === null || target.seq <= handledSeq) return 'idle';
  if (!ready) return 'wait';
  return hasNode(target.id) ? 'show' : 'missing';
}

export const NODE_MISSING_NOTE = '没找到这一步，可能已经不在这个会话里了';
