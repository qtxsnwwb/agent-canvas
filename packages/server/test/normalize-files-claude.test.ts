import { expect, test } from 'vitest';
import { Normalizer } from '../src/normalize/normalizer.js';
import { assistantBlock, hook, run, toolResult, userPrompt } from './fixtures.js';

const use = (uuid: string, parent: string, id: string, name: string, input: unknown, over: { agentId?: string } = {}) =>
  assistantBlock(uuid, parent, { type: 'tool_use', id, name, input }, over);

test('Claude Code: Read / Edit / Write / NotebookEdit / MultiEdit carry files; other tools none', () => {
  const { graph } = run(new Normalizer(), [
    userPrompt('u1', null, 'x'),
    use('a1', 'u1', 't1', 'Read', { file_path: 'D:\\proj\\src\\a.ts' }),
    use('a2', 'a1', 't2', 'Edit', { file_path: 'd:/proj/./src/a.ts', old_string: 'a', new_string: 'b' }),
    use('a3', 'a2', 't3', 'Write', { file_path: '/work/demo/new.ts', content: 'x' }),
    use('a4', 'a3', 't4', 'NotebookEdit', { notebook_path: 'nb/n.ipynb', new_source: 'x' }),
    use('a5', 'a4', 't5', 'MultiEdit', { file_path: '/work/demo/m.ts', edits: [] }),
    use('a6', 'a5', 't6', 'Bash', { command: 'cat /work/demo/a.ts' }),
    use('a7', 'a6', 't7', 'Grep', { pattern: 'x', path: '/work/demo' }),
    use('a8', 'a7', 't8', 'Read', { file_path: 7 }),
    use('a9', 'a8', 't9', 'Edit', { file_path: '' }),
  ]);
  expect(graph.nodes['tool:t1']!.files).toEqual([{ path: 'D:/proj/src/a.ts', action: 'read' }]);
  expect(graph.nodes['tool:t2']!.files).toEqual([{ path: 'D:/proj/src/a.ts', action: 'edit' }]);
  expect(graph.nodes['tool:t3']!.files).toEqual([{ path: '/work/demo/new.ts', action: 'write' }]);
  // Relative: resolved against the session's working directory (the records' cwd).
  expect(graph.nodes['tool:t4']!.files).toEqual([{ path: '/work/demo/nb/n.ipynb', action: 'edit' }]);
  expect(graph.nodes['tool:t5']!.files).toEqual([{ path: '/work/demo/m.ts', action: 'edit' }]);
  for (const id of ['tool:t6', 'tool:t7', 'tool:t8', 'tool:t9', 'u1']) {
    expect(graph.nodes[id]).not.toHaveProperty('files');
    expect(graph.nodes[id]).not.toHaveProperty('filesTruncated');
  }
  for (const id of ['tool:t1', 'tool:t2']) expect(graph.nodes[id]).not.toHaveProperty('filesTruncated');
});

test('Claude Code: subagent tool calls carry files too', () => {
  const { graph } = run(new Normalizer(), [
    userPrompt('u1', null, 'x'),
    use('a1', 'u1', 'tA', 'Agent', { description: 'd', prompt: 'p' }),
    userPrompt('s1', null, 'sub', { agentId: 'ag1', isSidechain: true }),
    use('s2', 's1', 'tS', 'Edit', { file_path: '/work/demo/sub.ts' }, { agentId: 'ag1' }),
  ]);
  expect(graph.nodes['tool:tS']).toMatchObject({ agentId: 'ag1', files: [{ path: '/work/demo/sub.ts', action: 'edit' }] });
});

test('Claude Code: a PreToolUse placeholder carries files; the transcript record keeps them; replay equals live', () => {
  const events = [
    userPrompt('u1', null, 'x'),
    hook('PreToolUse', { tool_name: 'Write', tool_input: { file_path: '/work/demo/a.ts', content: '' }, tool_use_id: 't1' }),
    use('a1', 'u1', 't1', 'Write', { file_path: '/work/demo/a.ts', content: '' }),
    toolResult('u2', 'a1', 't1', 'ok'),
  ];
  const live = new Normalizer();
  const first = run(live, events.slice(0, 2));
  expect(first.graph.nodes['tool:t1']!.files).toEqual([{ path: '/work/demo/a.ts', action: 'write' }]);
  const all = run(new Normalizer(), events);
  expect(all.graph.nodes['tool:t1']!.files).toEqual([{ path: '/work/demo/a.ts', action: 'write' }]);
  expect(run(new Normalizer(), events).graph).toEqual(all.graph);
});

test('Claude Code: a record applied twice changes nothing about files', () => {
  const n = new Normalizer();
  const rec = use('a1', 'u1', 't1', 'Read', { file_path: '/work/demo/a.ts' });
  const once = run(n, [userPrompt('u1', null, 'x'), rec]);
  const again = run(n, [rec]);
  expect(once.graph.nodes['tool:t1']!.files).toEqual([{ path: '/work/demo/a.ts', action: 'read' }]);
  for (const c of again.changes) {
    if (c.type === 'node_updated') expect(c.patch).not.toHaveProperty('files');
    if (c.type === 'node_added') expect(c.node.id).not.toBe('tool:t1');
  }
});
