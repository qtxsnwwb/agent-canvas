/**
 * The two error-marker judgements shared by the notification engine and the attention page (spec 4.1): a single node
 * that marks the current turn as failed or interrupted, and a hook that says so.
 */
import { describe, expect, test } from 'vitest';
import { ORIGINS, type GraphNode, type Origin } from '@agent-canvas/shared';
import { isErrorHook as engineIsErrorHook } from '../src/notify/engine.js';
import { isErrorHook, isErrorMarkerNode } from '../src/notify/markers.js';

type MarkerNode = Pick<GraphNode, 'kind' | 'systemSubtype' | 'status' | 'agentId'>;
const interrupt: MarkerNode = { kind: 'system', systemSubtype: 'interrupt', status: null, agentId: null };
const failedCall: MarkerNode = { kind: 'tool', systemSubtype: null, status: 'failed', agentId: null };
const never = (): boolean => {
  throw new Error('isAbortedCall must not be asked');
};

describe('isErrorMarkerNode', () => {
  test.each(ORIGINS)('%s：主线上的 interrupt 系统节点是出错标记', (origin) => {
    expect(isErrorMarkerNode(origin, interrupt, never)).toBe(true);
  });

  test.each(ORIGINS)('%s：子代理线程里的 interrupt 系统节点不是', (origin) => {
    expect(isErrorMarkerNode(origin, { ...interrupt, agentId: 'ag1' }, never)).toBe(false);
  });

  test('别的系统节点、主线的普通节点不是', () => {
    expect(isErrorMarkerNode('claude', { ...interrupt, systemSubtype: 'compact_boundary' }, never)).toBe(false);
    expect(isErrorMarkerNode('claude', { ...interrupt, systemSubtype: null }, never)).toBe(false);
    expect(isErrorMarkerNode('claude', { kind: 'text', systemSubtype: 'interrupt', status: null, agentId: null }, never)).toBe(false);
    expect(isErrorMarkerNode('claude', { kind: 'prompt', systemSubtype: null, status: null, agentId: null }, never)).toBe(false);
  });

  test('Cursor：主线调用变为 failed，只有因对话被中止时才算', () => {
    expect(isErrorMarkerNode('cursor', failedCall, () => true)).toBe(true);
    expect(isErrorMarkerNode('cursor', failedCall, () => false)).toBe(false);
  });

  test('Cursor：子代理的中止调用、未失败的调用不算，且不去问是否被中止', () => {
    expect(isErrorMarkerNode('cursor', { ...failedCall, agentId: 'ag1' }, never)).toBe(false);
    for (const status of ['running', 'awaiting_permission', 'succeeded', 'denied', null] as const) {
      expect(isErrorMarkerNode('cursor', { ...failedCall, status }, never)).toBe(false);
    }
  });

  test.each(ORIGINS.filter((o) => o !== 'cursor'))('%s：失败的调用不是出错标记，且不去问是否被中止', (origin) => {
    expect(isErrorMarkerNode(origin, failedCall, never)).toBe(false);
  });
});

describe('isErrorHook', () => {
  test('与通知引擎用的是同一个', () => {
    expect(isErrorHook).toBe(engineIsErrorHook);
  });

  test.each([
    ['claude', 'StopFailure', {}],
    ['claude', 'StopFailure', null],
    ['codex', 'Interrupt', {}],
    ['codex', 'Interrupt', null],
    ['cursor', 'stop', { status: 'aborted' }],
    ['cursor', 'stop', { status: 'error' }],
  ] as const)('%s %s %j：出错', (origin, event, payload) => {
    expect(isErrorHook(origin, event, payload)).toBe(true);
  });

  test.each([
    ['codex', 'Stop', {}],
    ['codex', 'StopFailure', {}],
    ['cursor', 'stop', { status: 'completed' }],
    ['cursor', 'stop', {}],
    ['cursor', 'stop', null],
    ['cursor', 'StopFailure', { status: 'error' }],
    ['claude', 'Stop', {}],
    ['claude', 'Interrupt', {}],
  ] as const)('%s %s %j：不算出错', (origin, event, payload) => {
    expect(isErrorHook(origin, event, payload)).toBe(false);
  });

  test.each(['gemini', 'grok', 'copilot', 'deepseek', 'workbuddy', 'codebuddy', 'doubao', 'qwen'] as Origin[])('%s：没有钩子，永远不算', (origin) => {
    for (const event of ['StopFailure', 'Interrupt', 'stop']) expect(isErrorHook(origin, event, { status: 'error' })).toBe(false);
  });
});
