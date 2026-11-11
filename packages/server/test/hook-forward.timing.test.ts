import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';

/*
 * The forwarder as a real process: hook-forward.ts (node built-ins only) is transpiled into a temp directory and run
 * by a two-line entry that does what `cli.js hook-forward` does. Codex reads the hook's stdout / stderr and exit code.
 */
let dir: string;
let entry: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hook-forward-'));
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'hook-forward.ts');
  const out = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  fs.writeFileSync(path.join(dir, 'hook-forward.mjs'), out.outputText);
  entry = path.join(dir, 'entry.mjs');
  fs.writeFileSync(
    entry,
    `import { hookForwardProcess } from ${JSON.stringify(pathToFileURL(path.join(dir, 'hook-forward.mjs')).href)};\nhookForwardProcess(process.argv.slice(2));\n`,
  );
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

async function listen(respond: boolean): Promise<{ port: number; bodies: string[] }> {
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      bodies.push(`${req.url} ${body}`);
      if (respond) res.end('ignored body');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { port: (server.address() as AddressInfo).port, bodies };
}

async function deadPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface Result { code: number | null; stdout: string; stderr: string; ms: number }

function runForwarder(port: number, stdin: string | Buffer): Promise<Result> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [entry, '--origin', 'codex', '--port', String(port)], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: performance.now() - started }));
    child.stdin.end(stdin);
  });
}

// Node's own startup is part of every bound below (a few hundred ms on a busy machine).
const STARTUP_ALLOWANCE_MS = 1500;

test('服务没启动：退出码 0，没有任何输出，很快结束', async () => {
  const r = await runForwarder(await deadPort(), '{"hook_event_name":"Stop","session_id":"s"}');
  expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
  expect(r.ms).toBeLessThan(STARTUP_ALLOWANCE_MS);
});

test('服务不回应：1 秒后放弃，退出码 0，没有输出', async () => {
  const { port, bodies } = await listen(false);
  const r = await runForwarder(port, '{"a":1}');
  expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
  expect(r.ms).toBeGreaterThanOrEqual(1000);
  expect(r.ms).toBeLessThan(1000 + STARTUP_ALLOWANCE_MS);
  expect(bodies).toEqual(['/hooks?origin=codex {"a":1}']);
});

test('服务正常：请求体原样送达，退出码 0，没有输出（响应体不回显）', async () => {
  const { port, bodies } = await listen(true);
  const r = await runForwarder(port, '{"hook_event_name":"PreToolUse","session_id":"s1"}');
  expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
  expect(bodies).toEqual(['/hooks?origin=codex {"hook_event_name":"PreToolUse","session_id":"s1"}']);
});

test('输入是乱码或为空：退出码 0，没有输出', async () => {
  const { port, bodies } = await listen(true);
  for (const input of [Buffer.from([0xff, 0x00, 0x7b, 0x22]), '']) {
    const r = await runForwarder(port, input);
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
  }
  expect(bodies).toHaveLength(1); // the empty input sends nothing
});
