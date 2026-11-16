/**
 * Turns Vite's output for viewer.html into the single-file export template, and checks the result. Pure string work (the
 * build's Vite plugin in vite.viewer.config.ts calls it; no Node or DOM API here), so it is unit-tested directly.
 *
 * The template: the CSP meta first in <head>, the stylesheet inlined in a <style>, the export slot (exactly once), then
 * the app as one inline module script at the end of <body>. Nothing refers to another file or URL.
 */

/** The element the server fills (packages/server/src/export/html.ts TEMPLATE_SLOT; the contract of Task 1). */
export const EXPORT_SLOT = '<script id="agent-canvas-export" type="application/json">__AGENT_CANVAS_EXPORT__</script>';

/**
 * The content security policy: nothing may be loaded or connected to; the one app script runs by its hash (the data
 * block is not a script that runs, so it is not covered and may hold any text); styles and `style` attributes inline;
 * images and fonts only as data: URLs.
 */
export function viewerCsp(scriptHash: string): string {
  return `default-src 'none'; script-src '${scriptHash}'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'`;
}

/**
 * The app's code made safe inside a <script> element: `</script` and `<!--` (which would end the element, or change how
 * the HTML parser looks for its end) get their `<` written as `\x3C`, which means `<` in JS strings, template literals,
 * regular expressions and comments, the only places minified module code can hold them. A backslash right before one of
 * them would turn the replacement into something else, so that fails the build instead.
 */
export function escapeInlineScript(code: string): string {
  return code.replace(/<(\/script|!--)/gi, (m, rest: string, at: number) => {
    if (at > 0 && code[at - 1] === '\\') throw new Error(`viewer build: cannot escape "\\${m}" in the inlined script`);
    return `\\x3C${rest}`;
  });
}

/** The stylesheet inside <style>: `</style` cannot be escaped in CSS without changing it, so it fails the build. */
export function escapeInlineStyle(css: string): string {
  if (/<\/style/i.test(css)) throw new Error('viewer build: the stylesheet contains "</style"');
  return css;
}

const SCRIPT_TAG = /<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>\s*/gi;
const STYLE_LINK = /<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/gi;
const fileKey = (src: string): string => src.replace(/^\.?\//, '');

/**
 * Vite's viewer.html (module scripts and stylesheets by URL) → the template. `assets` maps output file names to their
 * text; `hash` gives the CSP source of the inline script (`sha256-<base64>` of its exact text). Throws when the page
 * refers to a file that is not in `assets` or has no export slot.
 */
export function inlineViewerHtml(
  html: string,
  assets: { scripts: Record<string, string>; styles: Record<string, string> },
  hash: (code: string) => string,
): string {
  if (!html.includes(EXPORT_SLOT)) throw new Error(`viewer build: viewer.html has no ${EXPORT_SLOT} element`);
  const get = (map: Record<string, string>, src: string): string => {
    const key = fileKey(src);
    if (!Object.prototype.hasOwnProperty.call(map, key)) throw new Error(`viewer build: ${src} is not in the build output`);
    return map[key]!;
  };
  const code: string[] = [];
  let out = html.replace(SCRIPT_TAG, (_m, src: string) => {
    code.push(get(assets.scripts, src));
    return '';
  });
  out = out.replace(STYLE_LINK, (_m, href: string) => `<style>${escapeInlineStyle(get(assets.styles, href))}</style>`);
  if (code.length !== 1) throw new Error(`viewer build: expected one entry script, found ${code.length}`);
  const app = escapeInlineScript(code[0]!);
  const csp = `<meta http-equiv="Content-Security-Policy" content="${viewerCsp(hash(app))}">`;
  out = out.replace(/<head\b[^>]*>/i, (m) => `${m}\n    ${csp}`);
  const end = out.lastIndexOf('</body>');
  if (end < 0) throw new Error('viewer build: viewer.html has no </body>');
  return `${out.slice(0, end)}<script type="module">${app}</script>\n  ${out.slice(end)}`;
}

/** Contents of every <script> element (attributes and text), and the markup with those contents taken out. */
function splitScripts(html: string): { markup: string; scripts: { attrs: string; text: string; at: number }[] } {
  const scripts: { attrs: string; text: string; at: number }[] = [];
  let markup = '';
  let i = 0;
  const open = /<script\b([^>]*)>/gi;
  for (;;) {
    open.lastIndex = i;
    const m = open.exec(html);
    if (m === null) break;
    const start = m.index + m[0].length;
    const close = html.toLowerCase().indexOf('</script', start);
    const stop = close < 0 ? html.length : close;
    markup += html.slice(i, start);
    scripts.push({ attrs: m[1]!, text: html.slice(start, stop), at: m.index });
    i = stop;
  }
  markup += html.slice(i);
  return { markup, scripts };
}

/**
 * URL-shaped strings the libraries' code holds without ever requesting them (checked one by one; keep in step with
 * scripts/check-release.mjs). Everything else that looks like a URL is a problem.
 * - XML namespace names: React creates SVG elements with them; elkjs's EMF model names XML Schema types with them.
 * - elkjs's EMF package namespace names (identifiers of its model, never fetched).
 * - Text of React's and React Flow's error messages (console only).
 * - React Flow's attribution link: never rendered in the viewer (Canvas `attribution` is false for a snapshot).
 */
export const ALLOWED_URLS: readonly RegExp[] = [
  /^http:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xlink|1999\/xhtml|1998\/Math\/MathML|XML\/1998\/namespace|2000\/xmlns\/)$/,
  /^http:\/\/www\.w3\.org\/2001\/XMLSchema#[a-zA-Z]+$/,
  /^http:\/\/www\.eclipse\.org\/(?:elk\/ElkGraph|emf\/2002\/Ecore|emf\/2003\/XMLType)$/,
  /^http:\/\/\/org\/eclipse\/emf\/ecore\/util\/ExtendedMetaData$/,
  /^https:\/\/reactjs\.org\/docs\/error-decoder\.html\?invariant=$/,
  /^https:\/\/\$\{[a-z]\}flow\.dev\/error#\d+$/,
  /^https:\/\/reactflow\.dev\?utm_source=attribution$/,
];

/** Network APIs and the app's own API paths: none of them may be in the viewer (they are never reachable from it). */
const NETWORK_MARKERS: [RegExp, string][] = [
  [/"\/api\//, '"/api/'],
  [/\bnew\s+WebSocket\b/, 'new WebSocket'],
  [/\bWebSocket\s*\(/, 'WebSocket('],
  [/\bfetch\s*\(/, 'fetch('],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bEventSource\b/, 'EventSource'],
  [/\bsendBeacon\b/, 'sendBeacon'],
  [/\bimportScripts\b/, 'importScripts'],
  [/(?<![\w$.])import\s*\(/, 'import('],
];

function urlProblems(text: string, where: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s"'`)<>\\]*/gi)) {
    if (!ALLOWED_URLS.some((re) => re.test(m[0]))) out.push(`${where}: URL ${m[0].slice(0, 80)}`);
  }
  return out;
}

function cssProblems(css: string, where: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]*)/gi)) {
    if (!/^data:/i.test(m[2]!.trim())) out.push(`${where}: url(${m[2]!.slice(0, 80)})`);
  }
  if (/@import\b/i.test(css)) out.push(`${where}: @import`);
  return out;
}

/**
 * Everything wrong with a template (an empty list when it is fine): an external reference in the markup (a `src` / `href`
 * other than a data: URL, any `<a href>`, a `url(` that is not data:, `@import`), a network API or URL in the script, a
 * script other than the slot and the one app script, the slot missing, repeated or after the app script, the CSP meta not
 * the first element of <head>, `</script` or `<!--` inside the app script.
 */
export function templateProblems(html: string): string[] {
  const problems: string[] = [];
  const { markup, scripts } = splitScripts(html);
  for (const m of markup.matchAll(/\b(src|href)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const value = (m[3] ?? m[4] ?? m[5] ?? '').trim();
    if (!/^data:/i.test(value)) problems.push(`markup: ${m[1]}="${value.slice(0, 80)}"`);
  }
  if (/<a\b/i.test(markup)) problems.push('markup: a link');
  if (/<link\b(?![^>]*\bhref\s*=\s*["']?data:)/i.test(markup)) problems.push('markup: <link> to a file');
  problems.push(...cssProblems(markup, 'markup'));
  problems.push(...urlProblems(markup, 'markup'));

  const slots = html.split(EXPORT_SLOT).length - 1;
  if (slots !== 1) problems.push(`the export slot appears ${slots} times`);
  // Nowhere else, so a filled file holds no placeholder at all.
  const placeholders = html.split('__AGENT_CANVAS_EXPORT__').length - 1;
  if (placeholders !== 1) problems.push(`the placeholder appears ${placeholders} times`);
  const apps = scripts.filter((s) => !/\bid="agent-canvas-export"/.test(s.attrs));
  if (apps.length !== 1 || !/^\s*type="module"\s*$/.test(apps[0]!.attrs)) {
    problems.push(`expected one inline module script besides the slot, found ${apps.length}`);
  }
  const app = apps[0];
  if (app !== undefined) {
    if (html.indexOf(EXPORT_SLOT) > app.at) problems.push('the export slot comes after the app script');
    if (/<\/script|<!--/i.test(app.text)) problems.push('the app script contains </script or <!--');
    for (const [re, name] of NETWORK_MARKERS) if (re.test(app.text)) problems.push(`app script: ${name}`);
    problems.push(...urlProblems(app.text, 'app script'));
  }
  const head = /<head\b[^>]*>\s*(<[^>]*>)/i.exec(html);
  if (head === null || !/^<meta http-equiv="Content-Security-Policy" content="default-src 'none'; /.test(head[1]!)) {
    problems.push('the CSP meta is not the first element of <head>');
  }
  return problems;
}
