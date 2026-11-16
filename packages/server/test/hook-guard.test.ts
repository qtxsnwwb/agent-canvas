import { expect, test } from 'vitest';
import { isForeignHookPayload } from '../src/hook-guard.js';

// Spec section 7. Invented ids and paths only.
test('a Claude Code payload is never foreign', () => {
  const body = { session_id: 'c1', hook_event_name: 'PreToolUse', cwd: '/home/dev/demo', transcript_path: '/home/dev/t.jsonl' };
  expect(isForeignHookPayload('claude', body)).toBe(false);
  expect(isForeignHookPayload('cursor', body)).toBe(false);
});

test('a Cursor payload is never foreign (conversation_id, or session_id only on sessionStart)', () => {
  expect(isForeignHookPayload('cursor', { conversation_id: 'cv1', hook_event_name: 'stop', workspace_roots: ['/home/dev/demo'] })).toBe(false);
  expect(isForeignHookPayload('cursor', { session_id: 'cv1', hook_event_name: 'sessionStart' })).toBe(false);
  expect(isForeignHookPayload('cursor', { session_id: 'cv1' })).toBe(false);
});

test('a Grok payload (hookEventName) is foreign for claude and cursor', () => {
  const body = { hookEventName: 'PreToolUse', sessionId: 'g1', cwd: '/home/dev/demo', workspaceRoot: '/home/dev/demo' };
  expect(isForeignHookPayload('claude', body)).toBe(true);
  expect(isForeignHookPayload('cursor', body)).toBe(true);
});

test('a Copilot payload (sessionId without session_id / conversation_id) is foreign', () => {
  const body = { sessionId: 'cp1', timestamp: 1767225600000, cwd: '/home/dev/demo', toolName: 'bash' };
  expect(isForeignHookPayload('claude', body)).toBe(true);
  expect(isForeignHookPayload('cursor', body)).toBe(true);
});

test('hookEventName alone is foreign; sessionId next to session_id or conversation_id is not', () => {
  expect(isForeignHookPayload('claude', { hookEventName: 'Stop' })).toBe(true);
  expect(isForeignHookPayload('claude', { sessionId: 'x', session_id: 'x' })).toBe(false);
  expect(isForeignHookPayload('cursor', { sessionId: 'x', conversation_id: 'x' })).toBe(false);
  expect(isForeignHookPayload('claude', { hookEventName: 'Stop', session_id: 'x', hook_event_name: 'Stop' })).toBe(true);
});

test('anything that is not an object is not foreign (the existing invalid-payload path handles it)', () => {
  for (const body of [null, undefined, 'text', 42, true, ['sessionId'], [{ sessionId: 'x' }]]) {
    expect(isForeignHookPayload('claude', body)).toBe(false);
    expect(isForeignHookPayload('cursor', body)).toBe(false);
  }
  expect(isForeignHookPayload('claude', {})).toBe(false);
});

test('origin codex is never guarded', () => {
  expect(isForeignHookPayload('codex', { hookEventName: 'Stop', sessionId: 'g1' })).toBe(false);
  expect(isForeignHookPayload('codex', { sessionId: 'cp1', timestamp: 1, cwd: '/home/dev/demo', toolName: 'bash' })).toBe(false);
});
