import { expect, test } from 'vitest';
import { sessionLoadState } from '../src/sessionLoad';

const live = (gone: boolean) => ({ isGone: () => gone });

test('还没有结果时是 loading；会话正常时是 ready', () => {
  expect(sessionLoadState(null, null)).toBe('loading');
  expect(sessionLoadState(null, live(false))).toBe('ready');
});

test('打开时 404 或重新同步发现会话已不存在：missing', () => {
  expect(sessionLoadState(Object.assign(new Error('HTTP 404'), { status: 404 }), null)).toBe('missing');
  expect(sessionLoadState(null, live(true))).toBe('missing');
});

test('其他错误：error', () => {
  expect(sessionLoadState(Object.assign(new Error('HTTP 500'), { status: 500 }), null)).toBe('error');
  expect(sessionLoadState(new Error('network'), null)).toBe('error');
  expect(sessionLoadState('boom', null)).toBe('error');
});
