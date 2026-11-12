import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, expect, test } from 'vitest';
import { FORWARD_TIMEOUT_MS, parseForwardArgs, runHookForward } from '../src/hook-forward.js';

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

async function listen(respond = true): Promise<{ port: number; received: { url: string; body: string }[] }> {
  const received: { url: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push({ url: req.url ?? '', body });
      if (respond) res.end('{"continue":false,"ignored":true}');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { port: (server.address() as AddressInfo).port, received };
}

async function deadPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const stdinOf = (data: string | Buffer): Readable => Readable.from(data.length === 0 ? [] : [Buffer.from(data)]);

/** A stdout that records what is written. */
function sink(): { stdout: { write(chunk: string, cb?: (err?: Error | null) => void): boolean }; text: () => string } {
  const chunks: string[] = [];
  return {
    stdout: {
      write(chunk, cb) {
        chunks.push(chunk);
        cb?.(null);
        return true;
      },
    },
    text: () => chunks.join(''),
  };
}

const payload = (event: string): string =>
  JSON.stringify({ conversation_id: 'c1', generation_id: 'g1', hook_event_name: event, workspace_roots: ['/w'], user_email: 'a@b.c' });

test('parseForwardArgs：--origin cursor', () => {
  expect(parseForwardArgs(['--origin', 'cursor', '--port', '4400'])).toEqual({ origin: 'cursor', port: 4400 });
  expect(parseForwardArgs(['--origin=cursor'])).toEqual({ origin: 'cursor', port: 4317 });
});

test('beforeSubmitPrompt：stdout 恰好是 {"continue":true}；请求体原样到达 /hooks?origin=cursor', async () => {
  const { port, received } = await listen();
  const out = sink();
  const body = payload('beforeSubmitPrompt');
  expect(await runHookForward(['--origin', 'cursor', '--port', String(port)], { stdin: stdinOf(body), stdout: out.stdout })).toBe(0);
  expect(out.text()).toBe('{"continue":true}');
  expect(received).toEqual([{ url: '/hooks?origin=cursor', body }]);
});

test.each(['sessionStart', 'stop', 'subagentStop', 'sessionEnd', 'somethingNew'])('%s：stdout 什么都不写', async (event) => {
  const { port, received } = await listen();
  const out = sink();
  expect(await runHookForward(['--origin', 'cursor', '--port', String(port)], { stdin: stdinOf(payload(event)), stdout: out.stdout })).toBe(0);
  expect(out.text()).toBe('');
  expect(received).toHaveLength(1);
});

test('服务没启动：beforeSubmitPrompt 仍输出 {"continue":true}，返回 0', async () => {
  const out = sink();
  expect(await runHookForward(['--origin', 'cursor', '--port', String(await deadPort())], { stdin: stdinOf(payload('beforeSubmitPrompt')), stdout: out.stdout })).toBe(0);
  expect(out.text()).toBe('{"continue":true}');
});

test('服务不回应：超时界限内返回 0，仍输出 {"continue":true}', async () => {
  const { port } = await listen(false);
  const out = sink();
  const started = performance.now();
  expect(
    await runHookForward(['--origin', 'cursor', '--port', String(port)], { stdin: stdinOf(payload('beforeSubmitPrompt')), stdout: out.stdout, timeoutMs: 200 }),
  ).toBe(0);
  expect(performance.now() - started).toBeLessThan(FORWARD_TIMEOUT_MS);
  expect(out.text()).toBe('{"continue":true}');
});

test('输入是乱码、空、不是对象、或 hook_event_name 不是字符串：不输出', async () => {
  const { port } = await listen();
  for (const input of [Buffer.from([0xff, 0x00, 0x7b]), '', '"beforeSubmitPrompt"', '[{"hook_event_name":"beforeSubmitPrompt"}]', '{"hook_event_name":1}', 'null']) {
    const out = sink();
    expect(await runHookForward(['--origin', 'cursor', '--port', String(port)], { stdin: stdinOf(input), stdout: out.stdout })).toBe(0);
    expect(out.text()).toBe('');
  }
});

test('带 BOM 的 beforeSubmitPrompt 也放行', async () => {
  const out = sink();
  await runHookForward(['--origin', 'cursor', '--port', String(await deadPort())], { stdin: stdinOf(`﻿${payload('beforeSubmitPrompt')}`), stdout: out.stdout });
  expect(out.text()).toBe('{"continue":true}');
});

test('其他来源（codex / claude）即使事件名是 beforeSubmitPrompt 也不输出', async () => {
  for (const origin of ['codex', 'claude']) {
    const out = sink();
    await runHookForward(['--origin', origin, '--port', String(await deadPort())], { stdin: stdinOf(payload('beforeSubmitPrompt')), stdout: out.stdout });
    expect(out.text()).toBe('');
  }
});

test('stdout 写入抛错：仍返回 0', async () => {
  const stdout = {
    write(): boolean {
      throw new Error('EPIPE');
    },
  };
  expect(await runHookForward(['--origin', 'cursor', '--port', String(await deadPort())], { stdin: stdinOf(payload('beforeSubmitPrompt')), stdout })).toBe(0);
});

// Fix wave I3: stdin that is never closed. The answer comes from what was read by the stdin timeout.
test('stdin left open: a complete beforeSubmitPrompt payload is answered at the stdin timeout and forwarded', async () => {
  const { port, received } = await listen();
  const stdin = new PassThrough();
  stdin.write(payload('beforeSubmitPrompt'));
  const out = sink();
  const t0 = performance.now();
  await runHookForward(['--origin', 'cursor', '--port', String(port)], { stdin, stdout: out.stdout, stdinTimeoutMs: 150 });
  expect(out.text()).toBe('{"continue":true}');
  expect(received).toHaveLength(1);
  expect(performance.now() - t0).toBeLessThan(150 + FORWARD_TIMEOUT_MS + 500);
});

test('stdin left open: a cut payload naming beforeSubmitPrompt is answered; one whose event cannot be told prints nothing', async () => {
  const { port, received } = await listen();
  const cut = new PassThrough();
  cut.write('{"conversation_id":"c1","hook_event_name":"beforeSubmitPrompt","prompt":"half a pro');
  const a = sink();
  await runHookForward(['--origin', 'cursor', '--port', String(port)], { stdin: cut, stdout: a.stdout, stdinTimeoutMs: 100 });
  expect(a.text()).toBe('{"continue":true}');
  const unknown = new PassThrough();
  unknown.write('{"conversation_id":"c1","hook_event_na');
  const b = sink();
  await runHookForward(['--origin', 'cursor', '--port', String(port)], { stdin: unknown, stdout: b.stdout, stdinTimeoutMs: 100 });
  expect(b.text()).toBe('');
  expect(received).toHaveLength(0); // a cut payload is not sent: the server could not parse it
  const silent = new PassThrough();
  const c = sink();
  await runHookForward(['--origin', 'cursor', '--port', String(port)], { stdin: silent, stdout: c.stdout, stdinTimeoutMs: 100 });
  expect(c.text()).toBe('');
});
