import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ORIGINS, type Origin, type Session } from '@claude-canvas/shared';
import { loadConfig, type Config } from '../src/config.js';
import { NORMALIZER_FACTORIES, NormalizerRegistry, type NormalizerFactories } from '../src/normalize/registry.js';
import type { AgentNormalizer, NormalizeResult } from '../src/normalize/types.js';
import { NORMALIZER_VERSION } from '../src/normalize/version.js';
import { Pipeline } from '../src/pipeline.js';
import { ClaudeFileSource } from '../src/sources/claude.js';
import type { PollSink, PollSource } from '../src/sources/poll.js';
import { KEY_PREFIXES, originOfKey } from '../src/sources/source.js';
import { openStore, type RawEvent, type Store } from '../src/store/store.js';

// Temp dirs only: no real Cursor database is involved; a fake poll source pushes synthetic records.

/** A poll source that records what the pipeline asks of it and hands its sink to the test. */
class FakePollSource implements PollSource {
  constructor(readonly origin: Origin = 'cursor') {}
  sink: PollSink | null = null;
  started = 0;
  stopped = 0;
  readonly pokes: string[] = [];
  state: { lastPollAt: string | null; lastError: string | null } = { lastPollAt: null, lastError: null };
  start(sink: PollSink): void {
    this.started += 1;
    this.sink = sink;
  }
  async stop(): Promise<void> {
    this.stopped += 1;
  }
  poke(sessionId: string): void {
    this.pokes.push(sessionId);
  }
  status(): { lastPollAt: string | null; lastError: string | null } {
    return this.state;
  }
}

/** A cursor normalizer stand-in: every transcript record upserts its session; the lines it saw are logged in order. */
class EchoNormalizer implements AgentNormalizer {
  private readonly sessions = new Set<string>();
  constructor(private readonly log: string[]) {}
  apply(event: RawEvent, projectId: string): NormalizeResult {
    if (event.source !== 'transcript') return { changes: [] };
    this.log.push(event.line);
    this.sessions.add(event.sessionId);
    const session: Session = {
      id: event.sessionId,
      projectId,
      origin: 'cursor',
      cwd: null,
      title: event.line,
      gitBranch: null,
      status: 'idle',
      sourceDeleted: false,
      startedAt: '2026-11-12T00:00:00.000Z',
      lastActivityAt: '2026-11-12T00:00:00.000Z',
    };
    return { changes: [{ type: 'session_upserted', session }] };
  }
  dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
  needsPreSessionReplay(): boolean {
    return false;
  }
  restorePreSession(): void {}
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }
  sessionCount(): number {
    return this.sessions.size;
  }
  toolInputCount(): number {
    return 0;
  }
}

let tmp: string;
let store: Store;
let config: Config;
let fake: FakePollSource;
let pipeline: Pipeline;

function makePipeline(normalizers?: NormalizerFactories): Pipeline {
  return new Pipeline(store, config, {
    sources: [new ClaudeFileSource(config.projectsDir)],
    pollSources: [fake],
    ...(normalizers ? { normalizers } : {}),
  });
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-pipeline-cursor-'));
  await fs.mkdir(path.join(tmp, 'projects'), { recursive: true });
  config = loadConfig({}, { projectsDir: path.join(tmp, 'projects'), dataDir: path.join(tmp, 'data'), codexSessionsDir: null, cursorDbPath: null });
  store = openStore(path.join(tmp, 'data.db'));
  fake = new FakePollSource();
  pipeline = makePipeline();
});
afterEach(async () => {
  await pipeline.close();
  await pipeline.idle();
  store.close();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
});

const batch = (records: { recordType: string; line: string }[], agentId: string | null = null) => ({
  key: 'cursor:c1',
  projectId: 'D--work-app',
  sessionId: 'c1',
  agentId,
  records,
});

async function started(): Promise<PollSink> {
  await pipeline.scanAll();
  return fake.sink!;
}

describe('cursor origin', () => {
  test('ORIGINS, key prefix and origin of a cursor: key', () => {
    expect(ORIGINS).toEqual(['claude', 'codex', 'cursor']);
    expect(KEY_PREFIXES.cursor).toBe('cursor:');
    expect(originOfKey('cursor:abc-123')).toBe('cursor');
    expect(originOfKey('codex:2026/x.jsonl')).toBe('codex');
    expect(originOfKey('proj/abc.jsonl')).toBe('claude');
  });

  test('NORMALIZER_VERSION bumped for the cursor origin', () => {
    expect(NORMALIZER_VERSION).toBe(23);
  });

  test('without a cursor normalizer (factory null) a cursor raw event yields no changes', () => {
    const ev: RawEvent = { source: 'transcript', origin: 'cursor', file: 'cursor:c1', offset: 0, line: '{}', recordType: 'bubble', sessionId: 'c1', agentId: null, projectId: 'p' };
    expect(new NormalizerRegistry({ ...NORMALIZER_FACTORIES, cursor: null }).apply(ev, 'p')).toEqual({ changes: [] });
  });
});

describe('poll sources in the pipeline', () => {
  test('started once after the initial scan, stopped on close', async () => {
    expect(fake.started).toBe(0);
    await pipeline.scanAll();
    expect(fake.started).toBe(1);
    await pipeline.scanAll();
    expect(fake.started).toBe(1);
    await pipeline.close();
    expect(fake.stopped).toBe(1);
  });

  test('a poll source is not started when the pipeline closed before the initial scan', async () => {
    await pipeline.close();
    await pipeline.scanAll();
    expect(fake.started).toBe(0);
  });

  test('ingestRecords stores each record once as a cursor transcript raw event, in order; nothing derived without a normalizer', async () => {
    pipeline = makePipeline({ ...NORMALIZER_FACTORIES, cursor: null });
    const sink = await started();
    const records = [
      { recordType: 'composer', line: '{"composerId":"c1"}' },
      { recordType: 'bubble', line: '{"bubbleId":"b1","text":"hi"}' },
    ];
    await sink.ingestRecords(batch(records));
    await sink.ingestRecords(batch(records)); // unchanged: no-op
    let raw = store.rawForSession('c1');
    expect(raw.map((e) => (e.source === 'transcript' ? [e.origin, e.file, e.offset, e.recordType, e.line, e.agentId, e.projectId] : null))).toEqual([
      ['cursor', 'cursor:c1', 0, 'composer', records[0]!.line, null, 'D--work-app'],
      ['cursor', 'cursor:c1', 1, 'bubble', records[1]!.line, null, 'D--work-app'],
    ]);
    // A changed record is a second raw event; the stored offset keeps ingestion order.
    await sink.ingestRecords(batch([{ recordType: 'bubble', line: '{"bubbleId":"b1","text":"hi there"}' }]));
    raw = store.rawForSession('c1');
    expect(raw.map((e) => (e.source === 'transcript' ? e.offset : -1))).toEqual([0, 1, 2]);
    expect(store.getSession('c1')).toBeNull();
    expect(store.listSessions('D--work-app')).toEqual([]);

    // Rebuild replays from the raw log only: the source is not asked anything, the raw events stay.
    await pipeline.idle();
    pipeline.rebuild();
    expect(store.rawForSession('c1')).toHaveLength(3);
    expect(fake.started).toBe(1);
    expect(store.getSession('c1')).toBeNull();
  });

  test('an agent batch stores its agentId; the offset sequence is per key and survives a new pipeline', async () => {
    const sink = await started();
    await sink.ingestRecords({ key: 'cursor:sub1', projectId: 'p', sessionId: 'c1', agentId: 'sub1', records: [{ recordType: 'composer', line: '{"a":1}' }] });
    await sink.ingestRecords(batch([{ recordType: 'composer', line: '{"b":1}' }]));
    await pipeline.close();
    // A new pipeline over the same database continues each key's sequence.
    fake = new FakePollSource();
    pipeline = makePipeline();
    const sink2 = await started();
    await sink2.ingestRecords(batch([{ recordType: 'bubble', line: '{"b":2}' }]));
    const raw = store.rawForSession('c1').map((e) => (e.source === 'transcript' ? [e.file, e.offset, e.agentId] : null));
    expect(raw).toEqual([
      ['cursor:sub1', 0, 'sub1'],
      ['cursor:c1', 0, null],
      ['cursor:c1', 1, null],
    ]);
  });

  test('with a cursor normalizer: new records are applied in order, duplicates are not, and rebuild gives the same', async () => {
    const live: string[] = [];
    pipeline = makePipeline({ ...NORMALIZER_FACTORIES, cursor: () => new EchoNormalizer(live) });
    const sink = await started();
    await sink.ingestRecords(batch([
      { recordType: 'composer', line: 'A' },
      { recordType: 'bubble', line: 'B' },
    ]));
    await sink.ingestRecords(batch([
      { recordType: 'bubble', line: 'B' },
      { recordType: 'bubble', line: 'C' },
    ]));
    expect(live).toEqual(['A', 'B', 'C']);
    expect(store.getSession('c1')).toMatchObject({ origin: 'cursor', projectId: 'D--work-app', title: 'C' });

    live.length = 0;
    await pipeline.idle();
    pipeline.rebuild();
    expect(live).toEqual(['A', 'B', 'C']);
    expect(store.getSession('c1')).toMatchObject({ projectId: 'D--work-app', title: 'C' });
  });

  test('importing() is true while a batch is being ingested; idle() waits for it', async () => {
    const sink = await started();
    const p = sink.ingestRecords(batch([{ recordType: 'composer', line: '{}' }]));
    expect(pipeline.importing()).toBe(true);
    await pipeline.idle();
    await p;
    expect(pipeline.importing()).toBe(false);
    expect(store.rawForSession('c1')).toHaveLength(1);
  });

  test('markSourceDeleted / clearSourceDeleted flag the session; a later record keeps the flag', async () => {
    pipeline = makePipeline({ ...NORMALIZER_FACTORIES, cursor: () => new EchoNormalizer([]) });
    const sink = await started();
    await sink.markSourceDeleted('nope'); // unknown session: nothing happens
    await sink.ingestRecords(batch([{ recordType: 'composer', line: 'A' }]));
    expect(store.getSession('c1')?.sourceDeleted).toBe(false);
    await sink.markSourceDeleted('c1');
    expect(store.getSession('c1')?.sourceDeleted).toBe(true);
    await sink.markSourceDeleted('c1'); // idempotent
    await sink.ingestRecords(batch([{ recordType: 'bubble', line: 'B' }]));
    expect(store.getSession('c1')).toMatchObject({ sourceDeleted: true, title: 'B' });
    await sink.clearSourceDeleted('c1');
    expect(store.getSession('c1')?.sourceDeleted).toBe(false);
  });

  test('clearSourceDeleted clears a flag left by an earlier run', async () => {
    pipeline = makePipeline({ ...NORMALIZER_FACTORIES, cursor: () => new EchoNormalizer([]) });
    const sink = await started();
    await sink.ingestRecords(batch([{ recordType: 'composer', line: 'A' }]));
    await sink.markSourceDeleted('c1');
    await pipeline.close();
    fake = new FakePollSource();
    pipeline = makePipeline({ ...NORMALIZER_FACTORIES, cursor: () => new EchoNormalizer([]) });
    const sink2 = await started();
    expect(store.getSession('c1')?.sourceDeleted).toBe(true);
    await sink2.clearSourceDeleted('c1');
    expect(store.getSession('c1')?.sourceDeleted).toBe(false);
  });

  test('reportFailure through the sink shows in ingestFailures and survives a rescan', async () => {
    const sink = await started();
    sink.reportFailure('cursor:db', new Error('database is locked'));
    expect(pipeline.ingestFailures()).toEqual([expect.objectContaining({ file: 'cursor:db', error: 'database is locked' })]);
    await pipeline.rescan();
    expect(pipeline.ingestFailures()).toEqual([expect.objectContaining({ file: 'cursor:db', error: 'database is locked' })]);
  });

  test('a hook of the poll source origin pokes it with the session id; no session id or another origin does not', async () => {
    await started();
    pipeline.ingestHook('beforeSubmitPrompt', 'c1', '{"hook_event_name":"beforeSubmitPrompt"}', null, 'cursor');
    pipeline.ingestHook('stop', null, '{}', null, 'cursor');
    pipeline.ingestHook('Stop', 'c2', '{}', null, 'claude');
    await pipeline.idle();
    expect(fake.pokes).toEqual(['c1']);
    expect(store.rawForSession('c1').map((e) => [e.source, e.origin])).toEqual([['hook', 'cursor']]);
  });

  test('pollStatus: the status of the poll source of an origin, null when none', () => {
    fake.state = { lastPollAt: '2026-11-12T01:02:03.000Z', lastError: 'no such table: composerHeaders' };
    expect(pipeline.pollStatus('cursor')).toEqual(fake.state);
    expect(pipeline.pollStatus('codex')).toBeNull();
  });
});

describe('poll sources: fix round 1', () => {
  test('a successful batch keeps a failure the source reported under the same key; clearFailure clears it', async () => {
    const sink = await started();
    sink.reportFailure('cursor:c1', new Error('bubble b7: invalid JSON'));
    await sink.ingestRecords(batch([{ recordType: 'bubble', line: '{"bubbleId":"b1"}' }]));
    expect(pipeline.ingestFailures()).toEqual([expect.objectContaining({ file: 'cursor:c1', error: 'bubble b7: invalid JSON' })]);
    sink.clearFailure('cursor:c1');
    expect(pipeline.ingestFailures()).toEqual([]);
    sink.clearFailure('cursor:never-failed'); // no-op
  });

  test('a stop() that throws (sync or async) neither rejects close() nor skips the other sources', async () => {
    const syncThrow = new FakePollSource('cursor');
    syncThrow.stop = () => {
      throw new Error('sync stop');
    };
    const asyncThrow = new FakePollSource('codex');
    asyncThrow.stop = async () => {
      throw new Error('async stop');
    };
    const ok = new FakePollSource('claude');
    pipeline = new Pipeline(store, config, { sources: [new ClaudeFileSource(config.projectsDir)], pollSources: [syncThrow, asyncThrow, ok] });
    await pipeline.scanAll();
    await expect(pipeline.close()).resolves.toBeUndefined();
    expect(ok.stopped).toBe(1);
    await expect(pipeline.close()).resolves.toBeUndefined(); // repeated close: same outcome
    expect(ok.stopped).toBe(1);
  });

  test('a status() that throws gives lastError = its message', () => {
    fake.status = () => {
      throw new Error('status broke');
    };
    expect(pipeline.pollStatus('cursor')).toEqual({ lastPollAt: null, lastError: 'status broke' });
  });

  test('a start() that throws is reported under cursor:poll; the other sources still start', async () => {
    const bad = new FakePollSource('cursor');
    bad.start = () => {
      throw new Error('cannot start');
    };
    const other = new FakePollSource('codex');
    pipeline = new Pipeline(store, config, { sources: [new ClaudeFileSource(config.projectsDir)], pollSources: [bad, other] });
    await pipeline.scanAll();
    expect(other.started).toBe(1);
    expect(pipeline.ingestFailures()).toEqual([expect.objectContaining({ file: 'cursor:poll', error: 'cannot start' })]);
  });

  test('two concurrent batches of one key keep ingest order; offsets have no gap or duplicate', async () => {
    const live: string[] = [];
    pipeline = makePipeline({ ...NORMALIZER_FACTORIES, cursor: () => new EchoNormalizer(live) });
    const sink = await started();
    await Promise.all([
      sink.ingestRecords(batch([{ recordType: 'bubble', line: 'A' }, { recordType: 'bubble', line: 'B' }])),
      sink.ingestRecords(batch([{ recordType: 'bubble', line: 'C' }, { recordType: 'bubble', line: 'B' }, { recordType: 'bubble', line: 'D' }])),
    ]);
    expect(live).toEqual(['A', 'B', 'C', 'D']);
    expect(store.rawForSession('c1').map((e) => (e.source === 'transcript' ? [e.line, e.offset] : null))).toEqual([
      ['A', 0],
      ['B', 1],
      ['C', 2],
      ['D', 3],
    ]);
  });

  test('after close: ingestRecords rejects and stores nothing; markSourceDeleted / clearSourceDeleted do nothing', async () => {
    pipeline = makePipeline({ ...NORMALIZER_FACTORIES, cursor: () => new EchoNormalizer([]) });
    const sink = await started();
    await sink.ingestRecords(batch([{ recordType: 'composer', line: 'A' }]));
    await pipeline.close();
    await expect(sink.ingestRecords(batch([{ recordType: 'bubble', line: 'B' }]))).rejects.toThrow(/closed/);
    await sink.markSourceDeleted('c1');
    expect(store.rawForSession('c1')).toHaveLength(1);
    expect(store.getSession('c1')?.sourceDeleted).toBe(false);
    expect(pipeline.importing()).toBe(false);
  });
});
