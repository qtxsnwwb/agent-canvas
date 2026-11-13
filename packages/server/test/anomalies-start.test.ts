import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_NOTIFICATION_SETTINGS, type AnomalyCountsResponse, type Diagnostics } from '@agent-canvas/shared';
import { start, type Running } from '../src/cli.js';
import type { DeliveryStatus, NotificationMessage } from '../src/notify/desktop.js';
import type { ServiceNotifier } from '../src/notify/service.js';
import type { RawEvent } from '../src/store/store.js';
import { assistantBlock, toolResult, userPrompt } from './fixtures.js';

class FakeNotifier implements ServiceNotifier {
  sent: NotificationMessage[] = [];
  async notify(m: NotificationMessage): Promise<void> {
    this.sent.push(m);
  }
  status(): DeliveryStatus {
    return { available: true, lastError: null, lastErrorAt: null };
  }
  async close(): Promise<void> {}
}

const linesOf = (events: RawEvent[]): string => events.map((e) => (e.source === 'transcript' ? e.line : '') + '\n').join('');

/*
 * start() wiring: the anomaly routes answer, and a loop arising in a running session is notified within a couple of
 * seconds without any page open (the change feed → background recompute → notification), with the node as click target.
 */
describe('anomalies: start wiring', () => {
  let tmp: string;
  const apps: Running[] = [];
  beforeEach(async () => {
    vi.stubEnv('AGENT_CANVAS_CODEX_DIR', '');
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-anomalies-start-'));
    await fs.mkdir(path.join(tmp, 'projects'), { recursive: true });
  });
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close().catch(() => undefined);
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 });
    vi.unstubAllEnvs();
  });

  test('a fresh loop in a running session notifies once, pointing at its last node', { timeout: 30_000 }, async () => {
    const notifier = new FakeNotifier();
    const overrides = { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), port: 0, cursorDbPath: null };
    const app = await start(overrides, { notifier, storage: false, searchIndex: false });
    apps.push(app);
    const put = await fetch(`${app.url}/api/notifications/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true, finished: false, loop: true }),
    });
    expect(put.status).toBe(200);
    await vi.waitFor(async () => expect(((await (await fetch(`${app.url}/api/diagnostics`)).json()) as Diagnostics).importing).toBe(false), { timeout: 10_000 });

    const file = path.join(overrides.projectsDir, '-work-demo', 's1.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    // The session runs (a prompt hook), and its transcript shows the same call failing three times, just now.
    await fetch(`${app.url}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/work/demo', transcript_path: file, prompt: 'hi' }),
    });
    // After the start (anything before it never notifies): the calls are a few seconds apart from now on.
    const t = Date.now();
    const at = (i: number): string => new Date(t + i * 300).toISOString();
    const call = (n: number, parent: string): RawEvent[] => [
      assistantBlock(`a${n}`, parent, { type: 'tool_use', id: `tu${n}`, name: 'Bash', input: { command: 'npm test' } }, { timestamp: at(n * 2) }),
      toolResult(`r${n}`, `a${n}`, `tu${n}`, 'failed', true, { timestamp: at(n * 2 + 1) }),
    ];
    await fs.writeFile(file, linesOf([userPrompt('u1', null, 'hello', { timestamp: at(0) }), ...call(1, 'u1'), ...call(2, 'r1')]));
    await new Promise((r) => setTimeout(r, 1500));
    await fs.appendFile(file, linesOf(call(3, 'r2')));
    await vi.waitFor(() => expect(notifier.sent.filter((m) => m.title.startsWith('原地打转'))).toHaveLength(1), { timeout: 10_000, interval: 100 });
    const sent = notifier.sent.find((m) => m.title.startsWith('原地打转'))!;
    expect(sent.title).toBe('原地打转 · demo');
    expect(sent.body.split('\n')[1]).toBe('同一个调用失败了 3 次 · Claude Code');
    expect(sent.url).toMatch(new RegExp(`^${app.url.replace(/[.]/g, '\\.')}/#/s/s1/n/[^\\s]+$`));

    // A fourth failure: the same anomaly grows, no second notification.
    await fs.appendFile(file, linesOf(call(4, 'r3')));
    await new Promise((r) => setTimeout(r, 3000));
    expect(notifier.sent.filter((m) => m.title.startsWith('原地打转'))).toHaveLength(1);
    const counts = (await (await fetch(`${app.url}/api/anomalies/counts`)).json()) as AnomalyCountsResponse;
    expect(counts.counts.s1).toEqual({ total: 1, byKind: { loop: 1 } });
  });
  test('restart: history and a loop completed while the service was down never notify, even with a summary taken mid-import; a new loop does', { timeout: 60_000 }, async () => {
    const overrides = { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), port: 0, cursorDbPath: null };
    const file = path.join(overrides.projectsDir, '-work-demo', 's1.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const hook = (url: string) => fetch(`${url}/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/work/demo', transcript_path: file, prompt: 'hi' }),
    });
    const idle = async (url: string) =>
      vi.waitFor(async () => expect(((await (await fetch(`${url}/api/diagnostics`)).json()) as Diagnostics).importing).toBe(false), { timeout: 10_000 });
    const iso = (ms: number): string => new Date(ms).toISOString();
    const call = (n: number, parent: string, at: number, failed = true): RawEvent[] => [
      assistantBlock(`a${n}`, parent, { type: 'tool_use', id: `tu${n}`, name: 'Bash', input: { command: failed ? 'npm test' : `ls ${n}` } }, { timestamp: iso(at) }),
      toolResult(`r${n}`, `a${n}`, `tu${n}`, 'out', failed, { timestamp: iso(at + 500) }),
    ];

    // First run: an old loop in history (yesterday), and a running turn with two failures.
    const first = await start(overrides, { notifier: new FakeNotifier(), storage: false, searchIndex: false });
    apps.push(first);
    await fetch(`${first.url}/api/notifications/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true, finished: false, stuck: false, loop: true, failures: true }),
    });
    await idle(first.url);
    const old = Date.now() - 86_400_000;
    const t = Date.now() - 20_000;
    await fs.writeFile(file, linesOf([
      userPrompt('u0', null, 'old', { timestamp: iso(old) }), ...call(90, 'u0', old + 1000), ...call(91, 'r90', old + 3000), ...call(92, 'r91', old + 5000),
      userPrompt('u1', 'r92', 'hello', { timestamp: iso(t) }), ...call(1, 'u1', t + 1000), ...call(2, 'r1', t + 3000),
    ]));
    await hook(first.url);
    await new Promise((r) => setTimeout(r, 1500));
    apps.splice(0);
    await first.close();

    // While it is down, the third failure lands (just before the restart).
    await fs.appendFile(file, linesOf(call(3, 'r2', Date.now() - 2000)));

    const notifier = new FakeNotifier();
    const second = await start(overrides, { notifier, storage: false, searchIndex: false, statsWarmup: true });
    apps.push(second);
    // A page open across the restart asks at once (during the initial scan).
    await fetch(`${second.url}/api/sessions/s1/anomalies`);
    await idle(second.url);
    await second.statsWarmup;
    // The session keeps running: a fresh successful call triggers a background recompute.
    await hook(second.url);
    await fs.appendFile(file, linesOf(call(4, 'r3', Date.now(), false)));
    await vi.waitFor(async () => {
      const counts = (await (await fetch(`${second.url}/api/anomalies/counts`)).json()) as AnomalyCountsResponse;
      expect(counts.counts.s1?.byKind.loop).toBe(2);
    }, { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 2500));
    expect(notifier.sent.filter((m) => m.title.startsWith('原地打转') || m.title.startsWith('失败扎堆'))).toEqual([]);

    // A new loop in a new turn after the restart does notify.
    const n = Date.now();
    await hook(second.url);
    await fs.appendFile(file, linesOf([userPrompt('u2', 'r4', 'again', { timestamp: iso(n) }), ...call(5, 'u2', n + 100), ...call(6, 'r5', n + 200), ...call(7, 'r6', n + 300)]));
    await vi.waitFor(() => expect(notifier.sent.filter((m) => m.title.startsWith('原地打转'))).toHaveLength(1), { timeout: 10_000, interval: 100 });
  });
});
