import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  EXPORT_SLOT, escapeInlineScript, escapeInlineStyle, inlineViewerHtml, templateProblems, viewerCsp,
} from '../src/viewer/inline';

const sha = (code: string): string => `sha256-${createHash('sha256').update(code, 'utf8').digest('base64')}`;

/** What Vite writes for viewer.html (one module script, one stylesheet). */
const VITE_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Agent Canvas 导出</title>
    <script type="module" crossorigin src="./assets/viewer-AbC123.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/viewer-XyZ.css">
  </head>
  <body>
    <div id="root"></div>
    ${EXPORT_SLOT}
  </body>
</html>
`;

const assets = (js = 'console.log(1)', css = 'body{color:red}') => ({
  scripts: { 'assets/viewer-AbC123.js': js },
  styles: { 'assets/viewer-XyZ.css': css },
});

// ---- escaping ----

test('escapeInlineScript：脚本里不留下 </script 和 <!--（字符串、正则、注释里都等价）', () => {
  const code = 'a="</script>";b=/<\\/script>/;c="</SCRIPT >";d=`<!--`;/* </script */';
  const out = escapeInlineScript(code);
  expect(out).not.toMatch(/<\/script/i);
  expect(out).not.toContain('<!--');
  expect(out).toBe('a="\\x3C/script>";b=/<\\/script>/;c="\\x3C/SCRIPT >";d=`\\x3C!--`;/* \\x3C/script */');
  // The replacement means the same in a JS string.
  // eslint-disable-next-line no-new-func
  expect(new Function(`return ${escapeInlineScript('"</script><!--"')}`)()).toBe('</script><!--');
});

test('escapeInlineScript：反斜杠后面的 </script 无法安全改写，构建失败', () => {
  expect(() => escapeInlineScript('a="\\</script>"')).toThrow();
  expect(() => escapeInlineScript('a="\\<!--"')).toThrow();
});

test('escapeInlineStyle：样式里出现 </style 时构建失败', () => {
  expect(escapeInlineStyle('a{b:c}')).toBe('a{b:c}');
  expect(() => escapeInlineStyle('a{content:"</style>"}')).toThrow();
});

// ---- inlining ----

test('inlineViewerHtml：脚本和样式内联，CSP 是 head 的第一个元素，数据块在应用脚本之前且只有一个', () => {
  const html = inlineViewerHtml(VITE_HTML, assets('x="</script>"'), sha);
  expect(html).not.toMatch(/\bsrc=/);
  expect(html).not.toMatch(/<link\b/);
  expect(html).toContain('<style>body{color:red}</style>');
  const app = '<script type="module">x="\\x3C/script>"</script>';
  expect(html).toContain(app);
  expect(html.split(EXPORT_SLOT).length).toBe(2);
  expect(html.indexOf(EXPORT_SLOT)).toBeLessThan(html.indexOf(app));
  const head = html.slice(html.indexOf('<head>') + '<head>'.length).trimStart();
  expect(head.startsWith(`<meta http-equiv="Content-Security-Policy" content="${viewerCsp(sha('x="\\x3C/script>"'))}">`)).toBe(true);
  expect(templateProblems(html)).toEqual([]);
});

test('viewerCsp：只放行这一段内联脚本，其余全部禁止', () => {
  expect(viewerCsp('sha256-abc')).toBe(
    "default-src 'none'; script-src 'sha256-abc'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'",
  );
});

test('inlineViewerHtml：引用了构建产物里没有的文件时失败', () => {
  expect(() => inlineViewerHtml(VITE_HTML, { scripts: {}, styles: assets().styles }, sha)).toThrow(/viewer-AbC123\.js/);
  expect(() => inlineViewerHtml(VITE_HTML, { scripts: assets().scripts, styles: {} }, sha)).toThrow(/viewer-XyZ\.css/);
});

test('inlineViewerHtml：模板里没有数据块时失败', () => {
  expect(() => inlineViewerHtml(VITE_HTML.replace(EXPORT_SLOT, ''), assets(), sha)).toThrow(/agent-canvas-export/);
});

// ---- the external-reference detector ----

const ok = inlineViewerHtml(VITE_HTML, assets(), sha);
const withScript = (js: string) => inlineViewerHtml(VITE_HTML, assets(js), sha);
const withCss = (css: string) => inlineViewerHtml(VITE_HTML, assets('1', css), sha);
const withMarkup = (m: string) => ok.replace('<div id="root"></div>', `<div id="root"></div>${m}`);

test('templateProblems：标记里指向外部的 src / href / url(', () => {
  expect(templateProblems(withMarkup('<img src="https://example.invalid/a.png">')).length).toBeGreaterThan(0);
  expect(templateProblems(withMarkup("<img src='/a.png'>")).length).toBeGreaterThan(0);
  expect(templateProblems(withMarkup('<img src=a.png>')).length).toBeGreaterThan(0);
  expect(templateProblems(withMarkup('<a href="#x">x</a>')).length).toBeGreaterThan(0); // no links at all
  expect(templateProblems(withMarkup('<link rel="icon" href="data:image/svg+xml,x">'))).toEqual([]);
  expect(templateProblems(withMarkup('<img src="data:image/png;base64,AAAA">'))).toEqual([]);
  expect(templateProblems(withMarkup('<div style="background:url(/x.png)"></div>')).length).toBeGreaterThan(0);
});

test('templateProblems：样式里的 url( 只允许 data:', () => {
  expect(templateProblems(withCss('a{background:url(data:image/png;base64,AA)}'))).toEqual([]);
  expect(templateProblems(withCss("a{background:url('data:image/svg+xml,x')}"))).toEqual([]);
  expect(templateProblems(withCss('a{background:url(/x.png)}')).length).toBeGreaterThan(0);
  expect(templateProblems(withCss('@font-face{src:url("https://f.invalid/a.woff2")}')).length).toBeGreaterThan(0);
  expect(templateProblems(withCss('@import "x.css";')).length).toBeGreaterThan(0);
});

test('templateProblems：脚本里的网络接口和接口地址', () => {
  for (const js of [
    'fetch("/x")', 'window.fetch(u)', 'new WebSocket(u)', 'const u="/api/sessions"', 'new XMLHttpRequest',
    'new EventSource(u)', 'navigator.sendBeacon(u)', 'import("./chunk.js")', 'import ("./chunk.js")',
    'const u="https://example.invalid/x"', 'importScripts("w.js")',
  ]) {
    expect(templateProblems(withScript(js)), js).not.toEqual([]);
  }
  // Namespace URIs are identifiers, not requests.
  expect(templateProblems(withScript('a="http://www.w3.org/2000/svg";b="http://www.w3.org/1999/xlink"'))).toEqual([]);
  expect(templateProblems(withScript('a="http://www.eclipse.org/elk/ElkGraph";b="http://www.w3.org/2001/XMLSchema#int"'))).toEqual([]);
  // Only the exact strings: anything added to them is a problem.
  expect(templateProblems(withScript('a="http://www.eclipse.org/elk/ElkGraph/x"'))).not.toEqual([]);
  expect(templateProblems(withScript('a="https://reactflow.dev/x"'))).not.toEqual([]);
});

test('templateProblems：数据块不止一个、在应用脚本之后、CSP 不在最前面都算问题', () => {
  expect(templateProblems(withMarkup(EXPORT_SLOT)).length).toBeGreaterThan(0);
  const moved = ok.replace(EXPORT_SLOT, '').replace('</body>', `${EXPORT_SLOT}</body>`);
  expect(templateProblems(moved).length).toBeGreaterThan(0);
  const noCsp = ok.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
  expect(templateProblems(noCsp).length).toBeGreaterThan(0);
  const twoScripts = ok.replace('</body>', '<script>1</script></body>');
  expect(templateProblems(twoScripts).length).toBeGreaterThan(0);
  // The placeholder text anywhere else (e.g. in the app's code) would survive the export.
  expect(templateProblems(withScript('const p="__AGENT_CANVAS_EXPORT__"'))).toContain('the placeholder appears 2 times');
});
