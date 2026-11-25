import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { fileSources } from '../src/cli.js';
import { loadConfig, type Config } from '../src/config.js';
import { CONTROL_HEADER, CONTROL_KEY_FILE, createControlKey, keyMatches, readControlKey, removeControlKey } from '../src/control.js';
import { Pipeline } from '../src/pipeline.js';
import { openStore, type Store } from '../src/store/store.js';

// Temp dirs and an in-memory store only; every other origin disabled.
let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-control-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

describe('控制密钥文件', () => {
  test('64 位十六进制，每次不同，覆盖旧的', async () => {
    const a = createControlKey(tmp);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(readControlKey(tmp)).toBe(a);
    const b = createControlKey(tmp);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(b).not.toBe(a);
    expect(readControlKey(tmp)).toBe(b);
    expect((await fs.readFile(path.join(tmp, CONTROL_KEY_FILE), 'utf8')).trim()).toBe(b);
  });

  it.skipIf(process.platform === 'win32')('POSIX 上文件只有自己可读写（0600）', async () => {
    createControlKey(tmp);
    expect((await fs.stat(path.join(tmp, CONTROL_KEY_FILE))).mode & 0o777).toBe(0o600);
  });

  test('没有文件时 readControlKey 为 null', () => {
    expect(readControlKey(tmp)).toBeNull();
  });

  test('removeControlKey 只删仍是这把钥匙的文件', () => {
    const first = createControlKey(tmp);
    const second = createControlKey(tmp);
    removeControlKey(tmp, first);
    expect(readControlKey(tmp)).toBe(second);
    removeControlKey(tmp, second);
    expect(readControlKey(tmp)).toBeNull();
    removeControlKey(tmp, second); // already gone: no error
  });

  test('keyMatches：对的钥匙为真；错的、短的、不是字符串的为假', () => {
    const key = createControlKey(tmp);
    expect(keyMatches(key, key)).toBe(true);
    expect(keyMatches(key, key.replace(/.$/, (c) => (c === '0' ? '1' : '0')))).toBe(false);
    expect(keyMatches(key, key.slice(0, 32))).toBe(false);
    expect(keyMatches(key, '')).toBe(false);
    expect(keyMatches(key, undefined)).toBe(false);
    expect(keyMatches(key, [key])).toBe(false);
    expect(keyMatches(key, 42)).toBe(false);
  });
});

describe('POST /api/control/stop', () => {
  const HOST = '127.0.0.1:4999';
  let config: Config;
  let store: Store;
  let pipeline: Pipeline;
  let app: FastifyInstance;
  const key = 'ab'.repeat(32);

  function build(control?: { key: string; onStop(): void }): FastifyInstance {
    app = buildServer({ store, pipeline, config, ...(control !== undefined ? { control } : {}) });
    return app;
  }
  const stop = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/api/control/stop', headers: { host: HOST, ...headers } });

  beforeEach(async () => {
    await fs.mkdir(path.join(tmp, 'projects'), { recursive: true });
    config = loadConfig({}, {
      projectsDir: path.join(tmp, 'projects'),
      dataDir: path.join(tmp, 'data'),
      codexSessionsDir: null,
      cursorDbPath: null,
      deepseekDir: null, workbuddyDirs: [], codebuddyDir: null, doubaoDirs: [], qwenDir: null, geminiDir: null,
      grokDir: null,
      copilotDir: null,
    });
    store = openStore(':memory:');
    pipeline = new Pipeline(store, config, { sources: fileSources(config, store) });
  });
  afterEach(async () => {
    await app.close();
    await pipeline.idle();
    store.close();
  });

  test('没有钥匙头：403，不停', async () => {
    const onStop = vi.fn();
    build({ key, onStop });
    const res = await stop({});
    expect(res.statusCode).toBe(403);
    expect(res.json()).toHaveProperty('error');
    expect(onStop).not.toHaveBeenCalled();
  });

  test('钥匙不对：403，不停', async () => {
    const onStop = vi.fn();
    build({ key, onStop });
    const res = await stop({ [CONTROL_HEADER]: 'cd'.repeat(32) });
    expect(res.statusCode).toBe(403);
    expect(onStop).not.toHaveBeenCalled();
  });

  test('钥匙对但带 Origin（网页发的）：403，不停', async () => {
    const onStop = vi.fn();
    build({ key, onStop });
    const res = await stop({ [CONTROL_HEADER]: key, origin: 'http://127.0.0.1:1' });
    expect(res.statusCode).toBe(403);
    expect(onStop).not.toHaveBeenCalled();
  });

  test('钥匙对：202 { stopping: true }，回应发出后调用一次 onStop', async () => {
    const onStop = vi.fn();
    build({ key, onStop });
    const res = await stop({ [CONTROL_HEADER]: key });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ stopping: true });
    await vi.waitFor(() => expect(onStop).toHaveBeenCalledTimes(1));
  });

  test('没有 control 依赖时没有这个接口：404', async () => {
    build();
    const res = await stop({ [CONTROL_HEADER]: key });
    expect(res.statusCode).toBe(404);
  });
});
