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
    const t = Date.now() - 10_000;
    const at = (i: number): string => new Date(t + i * 1000).toISOString();
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
});
