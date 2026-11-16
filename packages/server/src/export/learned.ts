import { performance } from 'node:perf_hooks';
import { createMasker, MASK_LEARN_CAP, type Change, type LearnedValue, type MaskCategory } from '@agent-canvas/shared';
import { sessionIdOfChange } from '../stats/session-cache.js';
import { learnNode, readDetail, titleOptions, type ExportSource } from './assemble.js';

/**
 * POST /api/sessions/:id/mask/learned (spec 5): the secret values the export's first pass learns from a whole session,
 * for the page's masking switch. The page masks what it shows from summaries and the details it has opened; without
 * this list a value recognised in a detail the user has not opened (`{"password": "…"}` in a tool output) would still
 * show where it recurs elsewhere (a thinking text, a reply). The list holds secret values, so the route is as guarded as
 * the export routes (loopback, same-Origin, JSON body), answers with `Cache-Control: no-store` and is never logged; it
 * returns nothing the detail routes do not already return to the same page.
 */

export interface LearnedResponse {
  values: LearnedValue[];
  /** The scan stopped early (MASK_LEARN_CAP values, or the time budget): later values are not in the list. */
  capped: boolean;
}

/** The categories the route accepts (custom terms are never learned: accepted and ignored). */
export const LEARNED_CATEGORIES: readonly MaskCategory[] = ['credential', 'assignment', 'custom'];

/** Strict validation of the body `{ categories }`. */
export function parseLearnedBody(body: unknown): { ok: true; categories: MaskCategory[] } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: '请求体必须是一个对象' };
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'categories') return { ok: false, error: '只接受 categories 字段' };
  const categories = (body as { categories: unknown }).categories;
  if (!Array.isArray(categories) || categories.some((c) => typeof c !== 'string' || !(LEARNED_CATEGORIES as readonly string[]).includes(c))) {
    return { ok: false, error: 'categories 只能包含 credential、assignment、custom' };
  }
  return { ok: true, categories: [...new Set(categories as MaskCategory[])] };
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export interface LearnedServiceOptions {
  /** Stop after this long with capped: true (default 10 s). */
  timeBudgetMs?: number;
  yieldAfterMs?: number;
  pageSize?: number;
}

/**
 * Computes and caches the learned values per session and categories; an entry is dropped when a change for its session
 * is reported (noteChanges). Concurrent requests for the same entry share one computation.
 */
export class LearnedValuesService {
  private readonly cache = new Map<string, Promise<LearnedResponse | null>>();

  constructor(
    private readonly source: ExportSource,
    private readonly options: LearnedServiceOptions = {},
  ) {}

  noteChanges(changes: readonly Change[]): void {
    const ids = new Set(changes.map(sessionIdOfChange));
    for (const key of [...this.cache.keys()]) if (ids.has(key.slice(0, key.indexOf('\u0000')))) this.cache.delete(key);
  }

  /** null: no such session. */
  get(sessionId: string, categories: MaskCategory[]): Promise<LearnedResponse | null> {
    const key = `${sessionId}\u0000${[...categories].sort().join(',')}`;
    let entry = this.cache.get(key);
    if (entry === undefined) {
      entry = this.compute(sessionId, categories);
      this.cache.set(key, entry);
      entry.catch(() => this.cache.delete(key));
    }
    return entry;
  }

  private async compute(sessionId: string, categories: MaskCategory[]): Promise<LearnedResponse | null> {
    const session = this.source.getSession(sessionId);
    if (session === null) return null;
    const learning = categories.filter((c) => c === 'credential' || c === 'assignment');
    if (learning.length === 0) return { values: [], capped: false };
    const masker = createMasker({ categories: learning });
    const budget = performance.now() + (this.options.timeBudgetMs ?? 10_000);
    const yieldAfter = this.options.yieldAfterMs ?? 15;
    const pageSize = this.options.pageSize ?? 2000;
    let lastYield = performance.now();
    let capped = false;
    if (session.title !== null) masker.learn(session.title, titleOptions(session.title));
    for (const s of [session.cwd, session.gitBranch]) if (s !== null) masker.learn(s);
    outer: for (let after: string | null = null; ; ) {
      const page = this.source.nodePage(sessionId, after, pageSize);
      for (const { node } of page) {
        learnNode(masker, node, readDetail(this.source, sessionId, node.id), true);
        if (masker.learnedCount() >= MASK_LEARN_CAP || performance.now() > budget) {
          capped = true;
          break outer;
        }
        if (performance.now() - lastYield >= yieldAfter) {
          await turn();
          lastYield = performance.now();
        }
      }
      if (page.length < pageSize) break;
      after = page[page.length - 1]!.node.id;
    }
    return { values: masker.learnedValues(), capped: capped || masker.report().learnedCapped === true };
  }
}
