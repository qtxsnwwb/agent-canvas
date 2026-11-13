import { expect, test } from 'vitest';
import type { NodeDetail } from '@agent-canvas/shared';
import { createMaskedSource, createPageMasker } from '../src/masking';
import type { SessionSource } from '../src/sessionSource';
import { baseSession } from './helpers';

// A 1 MB step detail with the switch on: masked once when it is loaded (learn + mask), then remembered.
test('1 MB 的详情：打开时遮蔽一次，之后不再遮', async () => {
  const key = 'sk-' + 'proj-' + 'TimingFAKE' + 'q'.repeat(10);
  const lines: string[] = [];
  for (let i = 0; i < 14_000; i++) lines.push(`line ${i} lorem ipsum token=${i % 500 === 0 ? key : 'none'} dolor sit amet`);
  const output = lines.join('\n');
  expect(output.length).toBeGreaterThan(600_000);
  const detail: NodeDetail = { nodeId: 'n', input: { command: 'cat big.log' }, output: `${output}\n${output.slice(0, 300_000)}`, text: null, raw: null };
  const source: SessionSource = {
    getSession: () => baseSession, getGraph: () => ({ nodes: {}, edges: {} }), subscribe: () => () => {}, live: true,
    nodeDetail: async () => ({ detail, outputOriginalBytes: null }), files: null, anomalies: null,
    createLayoutClient: () => { throw new Error('unused'); },
  };
  const ms = createMaskedSource(source, createPageMasker({ customTerms: ['FalconProject'], numbered: true }));
  const t0 = performance.now();
  const first = await ms.nodeDetail('n');
  const firstMs = performance.now() - t0;
  const t1 = performance.now();
  const again = await ms.nodeDetail('n');
  const againMs = performance.now() - t1;
  console.log(`1 MB detail: first open ${firstMs.toFixed(0)} ms, again ${againMs.toFixed(1)} ms`);
  expect(String(first.detail!.output)).not.toContain(key);
  expect(again.detail).toBe(first.detail);
  expect(firstMs).toBeLessThan(3_000);
  expect(againMs).toBeLessThan(50);
});
