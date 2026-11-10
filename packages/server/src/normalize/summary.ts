import { SUMMARY_MAX } from '@claude-canvas/shared';

/** One-line preview of any value: whitespace collapsed, capped at SUMMARY_MAX characters. */
export function summarize(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  const collapsed = text.replace(/\s+/g, ' ');
  return collapsed.length > SUMMARY_MAX ? `${collapsed.slice(0, SUMMARY_MAX - 1)}…` : collapsed;
}
