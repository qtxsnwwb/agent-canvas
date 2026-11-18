// Exports a synthetic session as HTML through a real server and checks the file, in a browser when one is found.
//
// Used by scripts/check-release.mjs (with the packed CLI); can be run on its own against the workspace build:
//   node scripts/export-smoke.mjs [--cli packages/server/dist/cli.js] [--out <file.html>] [--screenshots <dir>]
//
// Everything runs in temp directories: a fresh data directory, a projects directory holding one synthetic Claude Code
// transcript, a home directory for the server (HOME / USERPROFILE), a Chrome profile. The server listens on a port the
// system picks (never 4317) and is stopped at the end. The transcript carries hostile content (script end tags, markup,
// a comment opener, U+2028, a javascript: link, a remote image) and a fake key (assembled here) for the mask report.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The placeholder and the data block of the template (packages/server/src/export/html.ts TEMPLATE_SLOT). */
export const PLACEHOLDER = '__AGENT_CANVAS_EXPORT__';
const DATA_OPEN = '<script id="agent-canvas-export" type="application/json">';

/**
 * URL-shaped strings the viewer's code holds without requesting them: the same list as ALLOWED_URLS in
 * packages/web/src/viewer/inline.ts (XML / EMF namespace names, library error-message text, React Flow's attribution
 * link, which the viewer does not render).
 */
const ALLOWED_URLS = [
  /^http:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xlink|1999\/xhtml|1998\/Math\/MathML|XML\/1998\/namespace|2000\/xmlns\/)$/,
  /^http:\/\/www\.w3\.org\/2001\/XMLSchema#[a-zA-Z]+$/,
  /^http:\/\/www\.eclipse\.org\/(?:elk\/ElkGraph|emf\/2002\/Ecore|emf\/2003\/XMLType)$/,
  /^http:\/\/\/org\/eclipse\/emf\/ecore\/util\/ExtendedMetaData$/,
  /^https:\/\/reactjs\.org\/docs\/error-decoder\.html\?invariant=$/,
  /^https:\/\/\$\{[a-z]\}flow\.dev\/error#\d+$/,
  /^https:\/\/reactflow\.dev\?utm_source=attribution$/,
];

export const SESSION_ID = 'e0e0e0e0-0000-4000-8000-00000000c0de';
export const TOOL_NODE = 'tool:toolu_smoke_1';
const LS = String.fromCharCode(0x2028);
/** Hostile text, as a reader of the session would see it. */
export const HOSTILE = {
  prompt: `修复登录 </script><script>window.__pwned=1</script> <!-- ${LS} 看 [链接](javascript:window.__pwned=2) ![t](https://example.invalid/track.png)`,
  command: "echo '<img src=x onerror=window.__pwned=3>'",
  output: `</script><script>window.__pwned=4</script><img src=x onerror=window.__pwned=5><!--${LS}done`,
  reply: '完成。见 https://example.invalid/track.png 和 javascript:window.__pwned=6',
};
/** A fake OpenAI-style key, assembled so the source holds no key-shaped literal. */
const FAKE_KEY = 'sk-' + 'proj-' + 'Q7w8'.repeat(12);

function transcript() {
  const t0 = Date.parse('2026-11-01T10:00:00.000Z');
  let tick = 0;
  const base = (type, uuid, parentUuid) => ({
    type, uuid, parentUuid, timestamp: new Date(t0 + ++tick * 1000).toISOString(), sessionId: SESSION_ID,
    cwd: '/work/demo', gitBranch: 'main', isSidechain: false,
  });
  const lines = [
    { ...base('user', 'u1', null), message: { role: 'user', content: `${HOSTILE.prompt} key=${FAKE_KEY}` } },
    {
      ...base('assistant', 'a1', 'u1'),
      message: {
        id: 'msg-a1', role: 'assistant', stop_reason: null, usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: 'tool_use', id: 'toolu_smoke_1', name: 'Bash', input: { command: HOSTILE.command } }],
      },
    },
    {
      ...base('user', 'u2', 'a1'),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_smoke_1', content: HOSTILE.output }] },
    },
    {
      ...base('assistant', 'a2', 'u2'),
      message: {
        id: 'msg-a2', role: 'assistant', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: 'text', text: HOSTILE.reply }],
      },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Every variable that names a tool directory this service reads, besides Claude Code's projects directory (which the
 * scripts point at a temp directory). Set to the empty string, each turns its tool off: nothing is read from the real
 * Codex, Cursor, Gemini CLI, Grok, Copilot CLI, DeepSeek Harness, WorkBuddy, CodeBuddy, Doubao or Qwen Code directories,
 * including the ones whose defaults do not come from the home directory (Cursor's `%APPDATA%`, Doubao's `%LOCALAPPDATA%`)
 * or that the tools' own variables (`DSH_HOME`, `WORKBUDDY_CONFIG_DIR`, `QWEN_RUNTIME_DIR`, ...) would name.
 */
export const TOOL_DIR_VARS = [
  'AGENT_CANVAS_CODEX_DIR',
  'AGENT_CANVAS_CURSOR_DB',
  'AGENT_CANVAS_GEMINI_DIR',
  'AGENT_CANVAS_GROK_DIR',
  'AGENT_CANVAS_COPILOT_DIR',
  'AGENT_CANVAS_DSH_DIR',
  'AGENT_CANVAS_WORKBUDDY_DIR',
  'AGENT_CANVAS_CODEBUDDY_DIR',
  'AGENT_CANVAS_DOUBAO_DIR',
  'AGENT_CANVAS_QWEN_DIR',
];

/**
 * The environment for a CLI process these scripts start: the caller's environment with every tool directory turned
 * off (TOOL_DIR_VARS), the data and projects directories under `tmp`, and a home directory (`HOME` / `USERPROFILE`)
 * under `tmp`, created here.
 */
export function isolatedServerEnv(tmp, extra = {}) {
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  return {
    ...process.env,
    ...Object.fromEntries(TOOL_DIR_VARS.map((name) => [name, ''])),
    AGENT_CANVAS_DATA_DIR: path.join(tmp, 'data'),
    AGENT_CANVAS_PROJECTS_DIR: path.join(tmp, 'projects'),
    HOME: home,
    USERPROFILE: home,
    ...extra,
  };
}

/** What a server's diagnostics show that it may read besides the projects directory (an empty list when nothing). */
export function toolSourceProblems(diagnostics) {
  const problems = [];
  if (diagnostics.codex?.sessionsDir !== null) problems.push(`codex: ${diagnostics.codex?.sessionsDir}`);
  if (diagnostics.cursor?.dbPath !== null) problems.push(`cursor: ${diagnostics.cursor?.dbPath}`);
  const sources = diagnostics.sources ?? {};
  const origins = ['gemini', 'grok', 'copilot', 'deepseek', 'workbuddy', 'codebuddy', 'doubao', 'qwen'];
  for (const origin of origins) {
    const s = sources[origin];
    if (s === undefined) problems.push(`${origin}: missing from the diagnostics`);
    else if (s.dir !== null || s.present || s.reading || (s.dirs ?? []).length > 0) problems.push(`${origin}: ${JSON.stringify(s)}`);
  }
  return problems;
}

/** Starts `node <cli> start --port 0` on temp directories; resolves with its URL once it listens. */
function startServer(cli, tmp, nodeModulesHint) {
  const env = isolatedServerEnv(tmp, { AGENT_CANVAS_STATS_WARMUP: '0' });
  const child = spawn(process.execPath, [cli, 'start', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: nodeModulesHint ?? tmp });
  let out = '';
  const url = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start in 60 s: ${out}`)), 60_000);
    const onData = (d) => {
      out += d;
      const m = /agent-canvas listening on (http:\/\/127\.0\.0\.1:(\d+))/.exec(out);
      if (m !== null) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}): ${out}`)); });
  });
  return { child, url };
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill(); // TerminateProcess on Windows, SIGTERM elsewhere
  await Promise.race([exited, sleep(10_000)]);
}

/** The file without the data block's content: what the checks for external references look at. */
export function withoutData(html) {
  const at = html.indexOf(DATA_OPEN);
  if (at < 0) return html;
  const end = html.indexOf('</script>', at + DATA_OPEN.length);
  return html.slice(0, at + DATA_OPEN.length) + html.slice(end);
}

/** Problems of an exported HTML file (an empty list when fine). */
export function exportedFileProblems(html) {
  const problems = [];
  if (html.includes(PLACEHOLDER)) problems.push('the placeholder is still in the file');
  if (!/<head>\s*<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-[A-Za-z0-9+/=]+'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'">/.test(html)) {
    problems.push('the CSP meta is missing or not first in <head>');
  }
  if (html.split(DATA_OPEN).length !== 2) problems.push('expected exactly one data block');
  const rest = withoutData(html);
  for (const m of rest.matchAll(/https?:\/\/[^\s"'`)<>\\]*/gi)) {
    if (!ALLOWED_URLS.some((re) => re.test(m[0]))) problems.push(`URL outside the data block: ${m[0].slice(0, 100)}`);
  }
  for (const m of rest.matchAll(/\b(?:src|href)\s*=\s*["']?(?!data:)[^\s"'>]/gi)) {
    // Inside the app script, "src=" only occurs in code text; a real attribute would be in the markup before it.
    const before = rest.slice(0, m.index);
    if (!before.includes('<script type="module">')) problems.push(`external src/href in the markup: ${m[0]}`);
  }
  if (rest.includes('__pwned')) problems.push('hostile text outside the data block');
  const data = html.slice(html.indexOf(DATA_OPEN) + DATA_OPEN.length, html.indexOf('</script>', html.indexOf(DATA_OPEN)));
  if (/[<>&\u2028\u2029]/.test(data)) problems.push('the data block holds an unescaped <, >, &, U+2028 or U+2029');
  return problems;
}

/**
 * Starts the server (`cli`), seeds the transcript, exports the session as HTML and checks the file. Returns the HTML.
 * `cwd`: where the server process runs (its dependencies must resolve from the CLI's own location anyway).
 */
export async function exportSynthetic({ cli, log = console.log }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-export-smoke-'));
  let server = null;
  try {
    const dir = path.join(tmp, 'projects', 'demo-proj');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SESSION_ID}.jsonl`), transcript());
    server = startServer(cli, tmp);
    const base = await server.url;
    const port = Number(new URL(base).port);
    if (port === 4317) throw new Error('the server took port 4317');
    // The server reads no tool directory but the temp projects directory.
    const diag = await (await fetch(`${base}/api/diagnostics`)).json();
    const reads = toolSourceProblems(diag);
    if (reads.length > 0) throw new Error(`the server would read real tool directories:\n  ${reads.join('\n  ')}`);
    log(`isolation: codex, cursor and ${Object.keys(diag.sources).length} file sources disabled (no directory, not present, not reading)`);
    // Wait for the transcript to be read.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const res = await fetch(`${base}/api/sessions/${SESSION_ID}/graph`).catch(() => null);
      if (res !== null && res.ok) {
        const g = await res.json();
        if (g.nodes.some((n) => n.id === TOOL_NODE && n.status === 'succeeded') && g.nodes.some((n) => n.kind === 'text')) break;
      }
      if (Date.now() > deadline) throw new Error('the synthetic session was not read in 30 s');
      await sleep(200);
    }
    const options = {
      format: 'html', scope: { kind: 'session' }, thinking: true, subagents: true, output: 'head',
      mask: { credential: true, assignment: true, personal: false, custom: false },
    };
    const res = await fetch(`${base}/api/sessions/${SESSION_ID}/export`, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify(options),
    });
    const html = await res.text();
    if (res.status !== 200) throw new Error(`export answered ${res.status}: ${html.slice(0, 300)}`);
    if (html.includes(FAKE_KEY)) throw new Error('the fake key is in the exported file');
    const problems = exportedFileProblems(html);
    if (problems.length > 0) throw new Error(`exported file:\n  ${problems.join('\n  ')}`);
    log(`export: HTML ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB from a server on port ${port}; placeholder filled, CSP first, no external reference`);
    return html;
  } finally {
    if (server !== null) await stopServer(server.child);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

// ---- the browser check (Chrome over the DevTools protocol) ----

const CHROME_CANDIDATES = [
  process.env.AGENT_CANVAS_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((p) => typeof p === 'string' && p !== '');

export function findChrome() {
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
}

/** A small DevTools protocol client over the WebSocket Node has built in. */
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('DevTools connection failed')); });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(`${msg.error.message}`)); else p?.resolve(msg.result);
    } else {
      for (const l of listeners) l(msg);
    }
  };
  return {
    send(method, params = {}, sessionId) {
      const n = ++id;
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((resolve, reject) => pending.set(n, { resolve, reject }));
    },
    on(fn) { listeners.push(fn); },
    close() { ws.close(); },
  };
}

/**
 * Opens `file` (an exported HTML file on disk) in headless Chrome and checks it: turn cards drawn, a step's detail
 * opens (by clicking its waterfall row, and by the `#n/<id>` address), the hostile scripts did not run, no image or
 * link, no request other than the file itself, no exception or console error (a CSP violation is one). Screenshots
 * at 1280 and 375 px wide when `screenshots` names a directory. Returns null when Chrome is not found.
 */
export async function checkInBrowser(file, { screenshots = null, log = console.log } = {}) {
  const chrome = findChrome();
  if (chrome === null) return null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-chrome-'));
  const netLog = path.join(profile, 'net-log.json');
  const proc = spawn(chrome, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-default-apps', '--metrics-recording-only', `--log-net-log=${netLog}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let client = null;
  try {
    let err = '';
    const wsUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Chrome did not start: ${err}`)), 30_000);
      proc.stderr.on('data', (d) => {
        err += d;
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
        if (m !== null) { clearTimeout(timer); resolve(m[1]); }
      });
      proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome exited (${code}): ${err}`)); });
    });
    client = await cdp(wsUrl);
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => client.send(method, params, sessionId);
    const requests = [];
    const errors = [];
    client.on((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Network.requestWillBeSent') requests.push(msg.params.request.url);
      if (msg.method === 'Runtime.exceptionThrown') errors.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push(`log: ${msg.params.entry.text}`);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(`console: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    });
    await send('Network.enable');
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.text}`);
      return r.result.value;
    };
    const waitFor = async (expression, what, ms = 20_000) => {
      const end = Date.now() + ms;
      for (;;) {
        if (await evaluate(expression)) return;
        if (Date.now() > end) throw new Error(`browser: timed out waiting for ${what}`);
        await sleep(100);
      }
    };
    const fileUrl = pathToFileURL(file).href;
    const open = async (width, height, hash = '') => {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
      await send('Page.navigate', { url: 'about:blank' });
      await send('Page.navigate', { url: fileUrl + hash });
      await waitFor("document.querySelectorAll('.cc-turn-summary').length > 0", 'the turn cards');
    };

    await open(1280, 800);
    const state = await evaluate(`({
      pwned: typeof window.__pwned,
      title: document.title,
      banner: document.querySelector('.viewer-banner')?.textContent ?? '',
      cards: document.querySelectorAll('.cc-turn-summary').length,
      images: document.querySelectorAll('img').length,
      links: document.querySelectorAll('a[href]').length,
      scripts: document.querySelectorAll('script').length,
    })`);
    const problems = [];
    if (state.pwned !== 'undefined') problems.push(`window.__pwned is ${state.pwned}`);
    if (!state.title.endsWith(' · Agent Canvas 导出')) problems.push(`document title: ${state.title}`);
    if (!state.banner.includes('Agent Canvas 导出的只读快照') || !state.banner.includes('内容可能仍含敏感信息')) problems.push('banner text');
    if (!/OpenAI key：[1-9]/.test(state.banner)) problems.push(`the mask report chip: ${state.banner}`);
    if (state.images !== 0) problems.push(`${state.images} <img> elements`);
    if (state.links !== 0) problems.push(`${state.links} links`);
    if (state.scripts !== 2) problems.push(`${state.scripts} script elements (expected the data block and the app)`);

    // A step's detail: its waterfall row (the panel follows the latest turn), then the drawer.
    await waitFor(`!!document.querySelector('.cc-wf-row[data-id="${TOOL_NODE}"]')`, 'the waterfall row');
    await evaluate(`document.querySelector('.cc-wf-row[data-id="${TOOL_NODE}"]').click(), true`);
    await waitFor("!!document.querySelector('aside.cc-drawer pre')", 'the drawer');
    const drawer = await evaluate("document.querySelector('aside.cc-drawer').textContent");
    if (!drawer.includes('<img src=x onerror=window.__pwned=5>')) problems.push('the drawer does not show the output as text');
    if (screenshots !== null) await shoot(send, path.join(screenshots, 'export-1280.png'));

    // The node address inside the file opens the same step.
    await open(1280, 800, `#n/${encodeURIComponent(TOOL_NODE)}`);
    await waitFor("!!document.querySelector('aside.cc-drawer pre')", 'the drawer opened by #n/<id>');

    await open(375, 812);
    if (screenshots !== null) await shoot(send, path.join(screenshots, 'export-375.png'));
    if ((await evaluate('typeof window.__pwned')) !== 'undefined') problems.push('window.__pwned set');

    const outside = requests.filter((u) => !u.startsWith(fileUrl) && !u.startsWith('data:') && u !== 'about:blank');
    if (outside.length > 0) problems.push(`requests: ${outside.join(', ')}`);
    if (errors.length > 0) problems.push(...errors);
    if (problems.length > 0) throw new Error(`browser:\n  ${problems.join('\n  ')}`);
    log(`browser: ${path.basename(chrome)} opened the file: ${state.cards} turn card(s), a step's detail opened (row and #n/ address), scripts in the data did not run, 0 requests besides the file`);
    return { requests, netLog };
  } finally {
    try { await client?.send('Browser.close'); } catch { /* already gone */ }
    client?.close();
    await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(5_000)]);
    if (proc.exitCode === null) proc.kill();
    await sleep(300);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function shoot(send, file) {
  await sleep(500); // let the canvas settle
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
}

// ---- run directly ----

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const cli = path.resolve(arg('--cli') ?? path.join(root, 'packages/server/dist/cli.js'));
  const out = arg('--out');
  const shots = arg('--screenshots');
  const html = await exportSynthetic({ cli });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-export-file-'));
  const file = out !== undefined ? path.resolve(out) : path.join(tmp, 'export.html');
  fs.writeFileSync(file, html);
  try {
    const r = await checkInBrowser(file, { screenshots: shots !== undefined ? path.resolve(shots) : null });
    if (r === null) console.log('browser: Chrome not found (set AGENT_CANVAS_CHROME); skipped');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
