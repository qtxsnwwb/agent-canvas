export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}分${String(total % 60).padStart(2, '0')}秒`;
}

/** Keys that activate a focused canvas node (open its detail, expand a folded turn). */
export function isActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Spacebar';
}

/** Accessible name of a node from [kind, title, status...]: "kind：title，status", empty parts skipped. */
export function nodeAriaLabel([kind, ...rest]: (string | null | undefined)[]): string {
  const parts = rest.map((x) => x?.trim() ?? '').filter((x) => x !== '');
  return parts.length > 0 ? `${kind ?? ''}：${parts.join('，')}` : kind ?? '';
}

/** A node's accessible name, with "，在推理链上" appended when it is on the causal chain of the selection. */
export function chainAriaLabel(label: string, onChain: boolean): string {
  return onChain ? `${label}，在推理链上` : label;
}
