import { describe, expect, test } from 'vitest';
import { attentionKey, type Origin, type Session, type SessionStatus } from '@agent-canvas/shared';
import { decideAttention, type SessionMarks } from '../src/attention/decide.js';

const T0 = Date.parse('2026-11-20T10:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const MIN = 60_000;

function session(status: SessionStatus, over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    projectId: 'D--w-tea-shop',
    origin: 'claude',
    cwd: 'D:\\w\\tea-shop',
    title: '修一下登录页',
    gitBranch: null,
    status,
    sourceDeleted: false,
    startedAt: iso(T0 - 3_600_000),
    lastActivityAt: iso(T0),
    ...over,
  };
}

/**
 * A turn asked at T0 - 10 min whose last main-thread node is at T0 - 1 min (a reply). The session's lastActivityAt is
 * that of the last main-thread node unless given.
 */
function marks(status: SessionStatus, over: Partial<SessionMarks> = {}, sessionOver: Partial<Session> = {}): SessionMarks {
  const lastActivityAt = over.lastMainNode?.timestamp ?? iso(T0 - MIN);
  return {
    session: session(status, { lastActivityAt, ...sessionOver }),
    lastPromptAt: iso(T0 - 10 * MIN),
    errorAt: null,
    errorNode: null,
    waitingNode: null,
    lastMainNode: { id: 'r1', timestamp: iso(T0 - MIN), text: 'Text' },
    lastReply: { id: 'r1', text: '已经改好，测试全部通过' },
    ...over,
  };
}

describe('decideAttention: each kind', () => {
  test('awaiting_permission -> permission, since = the waiting node, explanation = its tool and summary', () => {
    const item = decideAttention(
      marks('awaiting_permission', { waitingNode: { id: 'tool:t1', timestamp: iso(T0 - 2 * MIN), text: 'Bash · npm publish ./release' } }),
      T0,
      15,
    );
    expect(item).toEqual({
      key: attentionKey('s1', 'permission', iso(T0 - 2 * MIN)),
      sessionId: 's1',
      kind: 'permission',
      since: iso(T0 - 2 * MIN),
      title: '修一下登录页',
      origin: 'claude',
      projectId: 'D--w-tea-shop',
      cwd: 'D:\\w\\tea-shop',
      explanation: 'Bash · npm publish ./release',
      nodeId: 'tool:t1',
    });
  });

  test('awaiting_permission without a waiting node (a Notification hook alone): since = the last main-thread node', () => {
    const item = decideAttention(marks('awaiting_permission'), T0, 15)!;
    expect(item).toMatchObject({ kind: 'permission', since: iso(T0 - MIN), nodeId: 'r1', explanation: null });
  });

  test.each(['idle', 'awaiting_input'] as const)('%s with an error marker -> error, since = the marker', (status) => {
    const item = decideAttention(marks(status, { errorAt: iso(T0 - 30_000), errorNode: { id: 'x1', text: 'Turn failed: 请求超时' } }), T0, 15)!;
    expect(item).toMatchObject({ kind: 'error', since: iso(T0 - 30_000), nodeId: 'x1', explanation: 'Turn failed: 请求超时' });
    expect(item.key).toBe(attentionKey('s1', 'error', iso(T0 - 30_000)));
  });

  test('an error known from a hook only (no node): explanation null, the click target is the last main-thread node', () => {
    const item = decideAttention(marks('idle', { errorAt: iso(T0 - 5_000) }), T0, 15)!;
    expect(item).toMatchObject({ kind: 'error', since: iso(T0 - 5_000), explanation: null, nodeId: 'r1' });
  });

  test('running and quiet for longer than stuckMinutes -> stuck, since = the last main-thread node', () => {
    const item = decideAttention(marks('running', { lastMainNode: { id: 'tool:t9', timestamp: iso(T0 - 20 * MIN), text: 'Bash' } }), T0, 15)!;
    expect(item).toMatchObject({ kind: 'stuck', since: iso(T0 - 20 * MIN), explanation: 'Bash', nodeId: 'tool:t9' });
  });

  test.each(['idle', 'awaiting_input'] as const)('%s without an error -> finished, since = the last main-thread node', (status) => {
    const item = decideAttention(marks(status), T0, 15)!;
    expect(item).toMatchObject({ kind: 'finished', since: iso(T0 - MIN), explanation: '已经改好，测试全部通过', nodeId: 'r1' });
  });

  test('running and recently active -> nothing', () => {
    expect(decideAttention(marks('running'), T0, 15)).toBeNull();
  });
});

describe('decideAttention: priority and identity', () => {
  test('awaiting_permission wins over an error marker and over a long quiet stretch', () => {
    const m = marks('awaiting_permission', {
      errorAt: iso(T0 - 2 * MIN),
      errorNode: { id: 'x1', text: 'Interrupted' },
      lastMainNode: { id: 'tool:t1', timestamp: iso(T0 - 60 * MIN), text: 'Bash' },
      waitingNode: { id: 'tool:t1', timestamp: iso(T0 - 60 * MIN), text: 'Bash · rm -rf build' },
    });
    expect(decideAttention(m, T0, 15)!.kind).toBe('permission');
  });

  test('an error marker wins over finished', () => {
    expect(decideAttention(marks('idle', { errorAt: iso(T0) }), T0, 15)!.kind).toBe('error');
  });

  test('an error marker does not count while running (stuck or nothing)', () => {
    expect(decideAttention(marks('running', { errorAt: iso(T0 - MIN) }), T0, 15)).toBeNull();
    const quiet = marks('running', { errorAt: iso(T0 - 30 * MIN), lastMainNode: { id: 'n', timestamp: iso(T0 - 30 * MIN), text: 'T' } });
    expect(decideAttention(quiet, T0, 15)!.kind).toBe('stuck');
  });

  test('awaiting_input after idle keeps the kind and since (same key)', () => {
    const idle = decideAttention(marks('idle', {}, { lastActivityAt: iso(T0) }), T0, 15)!;
    const later = decideAttention(marks('awaiting_input', {}, { lastActivityAt: iso(T0 + 60_000) }), T0 + 60_000, 15)!;
    expect(later.kind).toBe('finished');
    expect(later.since).toBe(idle.since);
    expect(later.key).toBe(idle.key);
    const err = { errorAt: iso(T0 - 5_000), errorNode: { id: 'x1', text: 'Interrupted' } };
    expect(decideAttention(marks('awaiting_input', err), T0 + 60_000, 15)!.key).toBe(decideAttention(marks('idle', err), T0, 15)!.key);
  });

  test('an error marker counts only when the turn ended with it: a later main-thread node makes it finished (new key)', () => {
    // The marker is the last thing on the main thread (also when it is that node itself): error.
    const atEnd = decideAttention(marks('idle', { errorAt: iso(T0 - MIN), errorNode: { id: 'r1', text: 'Interrupted' } }), T0, 15)!;
    expect(atEnd.kind).toBe('error');
    // The main thread went on after it (e.g. a background task's completion, no new prompt) and stopped normally.
    const after = marks('idle', {
      errorAt: iso(T0 - 5 * MIN),
      errorNode: { id: 'x1', text: 'Interrupted' },
      lastMainNode: { id: 'r2', timestamp: iso(T0 - MIN), text: 'Text' },
      lastReply: { id: 'r2', text: '测试全部通过' },
    });
    const item = decideAttention(after, T0, 15)!;
    expect(item).toMatchObject({ kind: 'finished', since: iso(T0 - MIN), explanation: '测试全部通过', nodeId: 'r2' });
    expect(item.key).not.toBe(decideAttention({ ...after, lastMainNode: { id: 'x1', timestamp: iso(T0 - 5 * MIN), text: 'Interrupted' } }, T0, 15)!.key);
    // A hook marker later than the last node still ends the turn.
    expect(decideAttention(marks('idle', { errorAt: iso(T0 - MIN + 1) }), T0, 15)!.kind).toBe('error');
  });

  test('a later error marker turns finished into error with a new key', () => {
    const finished = decideAttention(marks('idle'), T0, 15)!;
    const error = decideAttention(marks('idle', { errorAt: iso(T0 + 1_000) }), T0 + 2_000, 15)!;
    expect(finished.kind).toBe('finished');
    expect(error.kind).toBe('error');
    expect(error.key).not.toBe(finished.key);
  });
});

describe('decideAttention: no item', () => {
  test('no main-thread prompt -> null (e.g. Claude Code idle at SessionStart)', () => {
    expect(decideAttention(marks('idle', { lastPromptAt: null }), T0, 15)).toBeNull();
    expect(decideAttention(marks('awaiting_permission', { lastPromptAt: null }), T0, 15)).toBeNull();
    expect(decideAttention(marks('running', { lastPromptAt: null, lastMainNode: { id: 'n', timestamp: iso(T0 - 99 * MIN), text: 'T' } }), T0, 15)).toBeNull();
  });

  test.each(['idle', 'awaiting_input', 'awaiting_permission', 'running'] as const)('sourceDeleted (%s) -> null', (status) => {
    const old = { lastMainNode: { id: 'n', timestamp: iso(T0 - 99 * MIN), text: 'T' } };
    expect(decideAttention(marks(status, old, { sourceDeleted: true }), T0, 15)).toBeNull();
  });

  test('ended -> null, also with an error marker', () => {
    expect(decideAttention(marks('ended'), T0, 15)).toBeNull();
    expect(decideAttention(marks('ended', { errorAt: iso(T0) }), T0, 15)).toBeNull();
  });
});

describe('decideAttention: stuck threshold', () => {
  const quiet = (sinceMs: number): SessionMarks => marks('running', { lastMainNode: { id: 'n', timestamp: iso(sinceMs), text: 'Read' } });
  test('stuckMinutes - 1 s: nothing; + 1 s: stuck', () => {
    expect(decideAttention(quiet(T0 - 15 * MIN + 1_000), T0, 15)).toBeNull();
    expect(decideAttention(quiet(T0 - 15 * MIN - 1_000), T0, 15)!.kind).toBe('stuck');
  });
  test('quiet means the later of the last main-thread node and lastActivityAt (as the notifications); since stays the main node', () => {
    // A subagent kept the session active until 5 min ago while the main thread waited 20 min: not stuck.
    const busy = marks('running', { lastMainNode: { id: 'dispatch', timestamp: iso(T0 - 20 * MIN), text: 'Explore' } }, { lastActivityAt: iso(T0 - 5 * MIN) });
    expect(decideAttention(busy, T0, 15)).toBeNull();
    // Silence since then for stuckMinutes: stuck, since = the main-thread node (its key does not move with the subagent).
    expect(decideAttention(busy, T0 - 5 * MIN + 15 * MIN, 15)).toBeNull();
    expect(decideAttention(busy, T0 - 5 * MIN + 15 * MIN + 1, 15)).toMatchObject({ kind: 'stuck', since: iso(T0 - 20 * MIN), nodeId: 'dispatch' });
    // An unparsable lastActivityAt falls back to the main-thread node.
    expect(decideAttention({ ...busy, session: { ...busy.session, lastActivityAt: 'garbage' } }, T0, 15)!.kind).toBe('stuck');
  });

  test('the threshold follows the argument', () => {
    expect(decideAttention(quiet(T0 - 6 * MIN), T0, 5)!.kind).toBe('stuck');
    expect(decideAttention(quiet(T0 - 6 * MIN), T0, 10)).toBeNull();
  });
});

describe('decideAttention: explanation', () => {
  test('cut at 200 characters (code points, the cut marked)', () => {
    const long = '改'.repeat(150) + '\u{1F600}'.repeat(100);
    const item = decideAttention(marks('idle', { lastReply: { id: 'r1', text: long } }), T0, 15)!;
    const chars = [...item.explanation!];
    expect(chars).toHaveLength(200);
    expect(chars[199]).toBe('…');
    expect(item.explanation!.startsWith('改'.repeat(150) + '\u{1F600}')).toBe(true);
  });
  test('exactly 200 characters are kept whole; whitespace runs are collapsed; blank is null', () => {
    const exact = 'a'.repeat(200);
    expect(decideAttention(marks('idle', { lastReply: { id: 'r1', text: exact } }), T0, 15)!.explanation).toBe(exact);
    expect(decideAttention(marks('idle', { lastReply: { id: 'r1', text: '  第一行\n\n第二行  ' } }), T0, 15)!.explanation).toBe('第一行 第二行');
    expect(decideAttention(marks('idle', { lastReply: { id: 'r1', text: ' \n ' } }), T0, 15)!.explanation).toBeNull();
  });
  test('finished without any reply in the turn: no explanation, the click target is the last main-thread node', () => {
    expect(decideAttention(marks('idle', { lastReply: null }), T0, 15)).toMatchObject({ explanation: null, nodeId: 'r1' });
  });
  test('every origin is decided the same way (the undeterminable ones are filtered by the service)', () => {
    for (const origin of ['codex', 'grok', 'doubao'] as Origin[]) {
      expect(decideAttention(marks('idle', {}, { origin }), T0, 15)).toMatchObject({ kind: 'finished', origin });
    }
  });
});
