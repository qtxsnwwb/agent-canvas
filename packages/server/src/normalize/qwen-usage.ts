import type { Usage } from '@agent-canvas/shared';

/*
 * Token usage of one Qwen Code assistant record (spec 4.5, docs/formats/qwen-code.md 3.3), the product's own rule
 * (gen-ai-usage.ts) mapped to this project's fields: cache reads = cachedContentTokenCount; input = prompt − cached
 * (cache writes are not saved, so not split out); output = total − prompt when that lies between candidates and
 * candidates + thoughts, else candidates for the OpenAI family (whose candidates include reasoning) and candidates +
 * thoughts for the others.
 */

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (v: unknown): number => (isNum(v) ? v : 0);

const FIELDS = ['promptTokenCount', 'candidatesTokenCount', 'cachedContentTokenCount', 'thoughtsTokenCount', 'totalTokenCount'];

/**
 * OpenAI-compatible (`openai`), OpenAI Responses (taken as any `openai…` value; its exact name was not traced) and Qwen
 * OAuth (`qwen-oauth`): their candidates count already includes the reasoning tokens.
 */
function candidatesIncludeThoughts(authType: string | null): boolean {
  if (authType === null) return false;
  const a = authType.toLowerCase();
  return a.startsWith('openai') || a === 'qwen-oauth';
}

/** Spec 4.5; authType null = unknown. Null when `usageMetadata` is not an object with a numeric count. */
export function qwenUsage(usageMetadata: unknown, authType: string | null): Usage | null {
  if (!isObject(usageMetadata) || !FIELDS.some((k) => isNum(usageMetadata[k]))) return null;
  const prompt = num(usageMetadata.promptTokenCount);
  const candidates = num(usageMetadata.candidatesTokenCount);
  const cached = num(usageMetadata.cachedContentTokenCount);
  const thoughts = num(usageMetadata.thoughtsTokenCount);
  const total = num(usageMetadata.totalTokenCount);
  const derived = total - prompt;
  const outputTokens =
    total > 0 && derived >= candidates && derived <= candidates + thoughts ? derived : candidatesIncludeThoughts(authType) ? candidates : candidates + thoughts;
  return { inputTokens: Math.max(0, prompt - cached), cachedInputTokens: cached, outputTokens };
}
