import { expect, test } from 'vitest';
import { parseHash } from '../src/App';

test('parseHash("#/diagnostics") 是诊断页；未知路径仍回首页', () => {
  expect(parseHash('#/diagnostics')).toEqual({ page: 'diagnostics' });
  expect(parseHash('#/nope')).toEqual({ page: 'home', projectId: null });
  expect(parseHash('')).toEqual({ page: 'home', projectId: null });
  expect(parseHash('#/s/abc')).toEqual({ page: 'session', sessionId: 'abc' });
  expect(parseHash('#/p/x%20y')).toEqual({ page: 'home', projectId: 'x y' });
});

test('parseHash("#/stats") 是统计页', () => {
  expect(parseHash('#/stats')).toEqual({ page: 'stats' });
});
