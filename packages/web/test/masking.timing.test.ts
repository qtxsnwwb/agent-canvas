import { expect, test } from 'vitest';
import type { GraphNode, NodeDetail } from '@agent-canvas/shared';
import { createMaskedSource, createPageMasker } from '../src/masking';
import type { SessionSource } from '../src/sessionSource';
import { baseSession, mkNode } from './helpers';

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

// A detail that teaches a new value makes the session page mask its node texts again, once.
test('5000 个节点：详情认出新值后重新遮蔽一遍卡片的耗时', async () => {
  const secret = 'Zq9' + 'xY7wV5' + 'uT3sR1';
  const nodes: Record<string, GraphNode> = {};
  for (let i = 0; i < 5000; i++) {
    nodes[`n${i}`] = { ...mkNode(`n${i}`), kind: 'tool', title: 'Bash', toolName: 'Bash',
      summary: `{"command":"cd /work/project-${i} && npm run build -- --filter pkg-${i % 37} ${i % 1000 === 0 ? secret : ''}"}` };
  }
  const detail: NodeDetail = { nodeId: 'n1', input: { password: secret }, output: null, text: null, raw: null };
  const source: SessionSource = {
    getSession: () => baseSession, getGraph: () => ({ nodes, edges: {} }), subscribe: () => () => {}, live: true,
    nodeDetail: async () => ({ detail, outputOriginalBytes: null }), files: null, anomalies: null,
    createLayoutClient: () => { throw new Error('unused'); },
  };
  const ms = createMaskedSource(source, createPageMasker({ customTerms: ['FalconProject'], numbered: true }));
  const t0 = performance.now();
  const first = ms.getGraph();
  const firstMs = performance.now() - t0;
  expect(JSON.stringify(first)).toContain(secret);
  await ms.nodeDetail('n1');
  const t1 = performance.now();
  const remasked = ms.getGraph();
  const remaskMs = performance.now() - t1;
  const again = JSON.stringify(remasked);
  console.log(`5000 nodes: first masking ${firstMs.toFixed(0)} ms, re-mask after a learned value ${remaskMs.toFixed(0)} ms`);
  expect(again).not.toContain(secret);
  expect(remaskMs).toBeLessThan(60);
});
