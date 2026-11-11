import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { main } from '../src/cli.js';
import { FORWARD_TIMEOUT_MS, parseForwardArgs, runHookForward } from '../src/hook-forward.js';

interface Received { url: string; method: string; contentType: string | undefined; body: Buffer }

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/** A local HTTP server on an ephemeral port; `respond: false` accepts the request and never answers. */
async function listen(respond = true): Promise<{ port: number; received: Received[] }> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ url: req.url ?? '', method: req.method ?? '', contentType: req.headers['content-type'], body: Buffer.concat(chunks) });
      if (respond) res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { port: (server.address() as AddressInfo).port, received };
}

/** A port nothing listens on (a server that was opened and closed again). */
async function deadPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const stdinOf = (data: string | Buffer): Readable => Readable.from(data.length === 0 ? [] : [Buffer.from(data)]);

test('parseForwardArgs：默认 codex / 4317；--origin claude；非法值回到默认', () => {
  expect(parseForwardArgs([])).toEqual({ origin: 'codex', port: 4317 });
  expect(parseForwardArgs(['--origin', 'claude', '--port', '4400'])).toEqual({ origin: 'claude', port: 4400 });
  expect(parseForwardArgs(['--origin=codex', '--port=5000'])).toEqual({ origin: 'codex', port: 5000 });
  expect(parseForwardArgs(['--origin', 'evil', '--port', 'abc'])).toEqual({ origin: 'codex', port: 4317 });
  expect(parseForwardArgs(['--port', '70000', '--whatever', 'x'])).toEqual({ origin: 'codex', port: 4317 });
  expect(parseForwardArgs(['--port'])).toEqual({ origin: 'codex', port: 4317 });
});

test('请求体原样到达 /hooks?origin=codex，content-type 为 application/json', async () => {
  const { port, received } = await listen();
  const payload = '{"hook_event_name":"PreToolUse","session_id":"s1","tool_input":{"cmd":"échö \\u0000"}}\n';
  expect(await runHookForward(['--origin', 'codex', '--port', String(port)], { stdin: stdinOf(payload) })).toBe(0);
  expect(received).toHaveLength(1);
  expect(received[0]!.method).toBe('POST');
  expect(received[0]!.url).toBe('/hooks?origin=codex');
  expect(received[0]!.contentType).toBe('application/json');
  expect(received[0]!.body.equals(Buffer.from(payload))).toBe(true);
});

test('--origin claude 发到 ?origin=claude', async () => {
  const { port, received } = await listen();
  await runHookForward(['--origin', 'claude', '--port', String(port)], { stdin: stdinOf('{}') });
  expect(received[0]!.url).toBe('/hooks?origin=claude');
});

test('输入不是 JSON：仍原样转发，返回 0', async () => {
  const { port, received } = await listen();
  const garbage = Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x7b]);
  expect(await runHookForward(['--port', String(port)], { stdin: stdinOf(garbage) })).toBe(0);
  expect(received[0]!.body.equals(garbage)).toBe(true);
});

test('输入为空：不发请求，返回 0', async () => {
  const { port, received } = await listen();
  expect(await runHookForward(['--port', String(port)], { stdin: stdinOf('') })).toBe(0);
  expect(received).toEqual([]);
});

test('服务没启动：立刻返回 0', async () => {
  const port = await deadPort();
  const started = performance.now();
  expect(await runHookForward(['--port', String(port)], { stdin: stdinOf('{"a":1}') })).toBe(0);
  expect(performance.now() - started).toBeLessThan(FORWARD_TIMEOUT_MS);
});

test('服务不回应：在超时界限内返回 0', async () => {
  const { port, received } = await listen(false);
  const started = performance.now();
  expect(await runHookForward(['--port', String(port)], { stdin: stdinOf('{"a":1}'), timeoutMs: 200 })).toBe(0);
  const elapsed = performance.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(150);
  expect(elapsed).toBeLessThan(1000);
  expect(received).toHaveLength(1);
  expect(FORWARD_TIMEOUT_MS).toBe(1000);
});

test('stdin 出错：返回 0，不抛', async () => {
  const stdin = new Readable({ read() { this.destroy(new Error('EPIPE')); } });
  expect(await runHookForward(['--port', String(await deadPort())], { stdin })).toBe(0);
});

test('cli main 的 hook-forward 子命令走同一条路径，返回 0', async () => {
  const { port, received } = await listen();
  expect(await main(['hook-forward', '--origin', 'codex', '--port', String(port)], { stdin: stdinOf('{"x":2}') })).toBe(0);
  expect(received[0]!.body.toString()).toBe('{"x":2}');
});

test('转发程序不依赖服务端其余代码：hook-forward.ts 只导入 node 内置模块；cli.ts 不静态导入重模块', () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const importsOf = (file: string): string[] =>
    [...fs.readFileSync(path.join(src, file), 'utf8').matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]!);
  expect(importsOf('hook-forward.ts').every((m) => m.startsWith('node:'))).toBe(true);
  const cliImports = importsOf('cli.ts');
  for (const heavy of ['fastify', 'better-sqlite3', 'chokidar', './api/server.js', './pipeline.js', './store/store.js', './cli-commands.js']) {
    expect(cliImports).not.toContain(heavy);
  }
  expect(cliImports.every((m) => m.startsWith('node:') || m === './hook-forward.js')).toBe(true);
});
