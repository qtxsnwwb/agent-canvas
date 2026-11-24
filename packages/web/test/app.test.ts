import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test, vi } from 'vitest';
import { parseHash } from '../src/route';

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

test('parseHash("#/attention") 是待处理页', () => {
  expect(parseHash('#/attention')).toEqual({ page: 'attention' });
  expect(parseHash('#/attention/x')).toEqual({ page: 'home', projectId: null });
});

afterEach(() => { vi.unstubAllGlobals(); });

test('header: the 今天 item sits right after 待处理', async () => {
  vi.stubGlobal('location', { hash: '#/stats', protocol: 'http:', host: '127.0.0.1:1' });
  const { App } = await import('../src/App');
  const html = renderToStaticMarkup(createElement(App));
  const header = /<header>([\s\S]*?)<\/header>/.exec(html)?.[1] ?? '';
  const links = [...header.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1]);
  expect(links.slice(0, 4)).toEqual(['#/', '#/attention', '#/stats', '#/stats']);
  expect(header).toMatch(/aria-label="待处理"[^>]*>待处理<\/a><a class="header-link header-link-next header-today"/);
});
