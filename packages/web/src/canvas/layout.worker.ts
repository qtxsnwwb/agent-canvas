import ELK from 'elkjs/lib/elk.bundled.js';
import { layoutTurn, type TurnLayoutInput } from './layout';

// Request { id, input } -> reply { id, layout } | { id, error }.
const elk = new ELK();
const ctx = self as unknown as {
  onmessage: ((ev: { data: { id: number; input: TurnLayoutInput } }) => void) | null;
  postMessage(msg: unknown): void;
};

ctx.onmessage = (ev) => {
  const { id, input } = ev.data;
  layoutTurn(elk, input).then(
    (layout) => ctx.postMessage({ id, layout }),
    (err: unknown) => ctx.postMessage({ id, error: err instanceof Error ? err.message : String(err) }),
  );
};
