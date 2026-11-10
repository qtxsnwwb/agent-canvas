import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Change, SeqChange } from '@claude-canvas/shared';
import type { Config } from './config.js';
import { Normalizer } from './normalize/normalizer.js';
import { classifyPath } from './sources/transcript/paths.js';
import { readNewLines } from './sources/transcript/reader.js';
import type { RawEvent, Store, StoredRawEvent } from './store/store.js';

/** Per-read byte budget; keeps each synchronous slice of work short so the event loop stays responsive. */
const READ_BUDGET_BYTES = 64 * 1024;
const UNKNOWN_PROJECT = 'unknown';

type Listener = (changes: SeqChange[]) => void;
interface FileLock {
  running: Promise<void> | null;
  queued: Promise<void> | null;
}

function topLevelType(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const t = (parsed as { type?: unknown }).type;
      if (typeof t === 'string' && t !== '') return t;
    }
    return 'unknown';
  } catch {
    return 'invalid-json';
  }
}

export class Pipeline {
  private normalizer = new Normalizer();
  private readonly listeners = new Set<Listener>();
  private readonly locks = new Map<string, FileLock>();

  constructor(
    private readonly store: Store,
    private readonly config: Config,
  ) {}

  onChanges(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  lastHookAt(): string | null {
    return this.store.diagnostics().lastHookAt;
  }

  /** Reads new content of one file. Concurrent calls for the same file are serialized (at most one queued rerun). */
  ingestFile(absPath: string): Promise<void> {
    let lock = this.locks.get(absPath);
    if (!lock) {
      lock = { running: null, queued: null };
      this.locks.set(absPath, lock);
    }
    const l = lock;
    if (!l.running && !l.queued) {
      l.running = this.runLocked(absPath, l);
      return l.running;
    }
    if (!l.queued) {
      const prev = l.running!;
      l.queued = prev
        .catch(() => undefined)
        .then(() => {
          l.queued = null;
          l.running = this.runLocked(absPath, l);
          return l.running;
        });
    }
    return l.queued;
  }

  ingestHook(eventName: string, sessionId: string | null, payload: string): void {
    this.ensureHydrated(sessionId);
    const event: RawEvent = { source: 'hook', receivedAt: new Date().toISOString(), eventName, sessionId, payload };
    if (this.store.insertRaw(event) === null) return;
    const projectId = (sessionId !== null ? this.store.getSession(sessionId)?.projectId : undefined) ?? UNKNOWN_PROJECT;
    const out = this.normalizer.apply(event, projectId);
    if (out.unknownRecordType !== undefined) this.store.bumpUnknown(out.unknownRecordType, payload);
    this.commit(out.changes);
  }

  async scanAll(): Promise<void> {
    for (const file of await this.listFiles()) await this.ingestFile(file);
    this.markDeletedSources();
  }

  /** Cheap periodic check: ingest files whose size differs from the stored size, plus files not seen yet. */
  async rescan(): Promise<void> {
    const known = new Map(this.store.diagnostics().files.map((f) => [f.path, f.size]));
    for (const file of await this.listFiles()) {
      const storedSize = known.get(file);
      if (storedSize !== undefined) {
        try {
          if ((await fsp.stat(file)).size === storedSize) continue;
        } catch {
          continue;
        }
      }
      await this.ingestFile(file);
    }
    this.markDeletedSources();
  }

  /** Re-derives everything from the raw log. */
  rebuild(): void {
    this.store.clearDerived();
    this.normalizer = new Normalizer();
    const changes: Change[] = [];
    for (const id of this.store.allSessionIdsInRaw()) {
      changes.push(...this.replay(this.store.rawForSession(id)));
    }
    this.commit(changes);
    this.markDeletedSources();
  }

  /** Files under projectsDir that classifyPath recognizes, in stable order. */
  async listFiles(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fsp.readdir(this.config.projectsDir, { recursive: true });
    } catch {
      return [];
    }
    return entries
      .map((rel) => path.join(this.config.projectsDir, rel))
      .filter((abs) => classifyPath(this.config.projectsDir, abs) !== null)
      .sort();
  }

  private async runLocked(absPath: string, lock: FileLock): Promise<void> {
    try {
      await this.doIngest(absPath);
    } finally {
      lock.running = null;
    }
  }

  private async doIngest(absPath: string): Promise<void> {
    const cls = classifyPath(this.config.projectsDir, absPath);
    if (cls === null) return;
    if (cls.kind === 'title' || cls.kind === 'agent_meta') return this.ingestMeta(absPath, cls);

    const agentId = cls.kind === 'agent' ? cls.agentId : null;
    for (;;) {
      let size: number;
      try {
        size = (await fsp.stat(absPath)).size;
      } catch {
        return; // file is gone: keep the stored offset, scanAll marks the session
      }
      const res = await readNewLines(absPath, this.store.getOffset(absPath), READ_BUDGET_BYTES);
      const changes: Change[] = [];
      for (const { offset, text } of res.lines) {
        this.ensureHydrated(cls.sessionId);
        const recordType = topLevelType(text);
        const event: RawEvent = {
          source: 'transcript',
          file: absPath,
          offset,
          line: text,
          recordType,
          sessionId: cls.sessionId,
          agentId,
        };
        if (this.store.insertRaw(event) === null) continue;
        const out = this.normalizer.apply(event, cls.projectId);
        changes.push(...out.changes);
        if (out.unknownRecordType !== undefined) this.store.bumpUnknown(out.unknownRecordType, text);
      }
      this.commit(changes);
      if (res.lines.length === 0 && !res.truncated) return;
      this.store.setOffset(absPath, res.newOffset, size);
      if (res.lines.length === 0) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private async ingestMeta(
    absPath: string,
    cls: { kind: 'title' | 'agent_meta'; projectId: string; sessionId: string; agentId?: string },
  ): Promise<void> {
    let content: string;
    try {
      content = await fsp.readFile(absPath, 'utf8');
    } catch {
      return;
    }
    const size = Buffer.byteLength(content);
    const agentId = cls.kind === 'agent_meta' ? (cls.agentId ?? null) : null;
    // Compare against what is stored (not an in-memory cache) so the check survives restarts.
    const stored = this.store.rawForSession(cls.sessionId).filter((e) => e.source === 'meta' && e.file === absPath);
    const last = stored[stored.length - 1];
    if (last?.source === 'meta' && last.payload === content) return;

    this.ensureHydrated(cls.sessionId);
    const event: RawEvent = { source: 'meta', file: absPath, sessionId: cls.sessionId, agentId, payload: content };
    this.store.insertRaw(event);
    this.commit(this.normalizer.apply(event, cls.projectId).changes);
    // Recorded so the rescan timer treats the file as known and only revisits it when its size changes.
    this.store.setOffset(absPath, size, size);
  }

  /**
   * A fresh Normalizer has no memory of sessions already in the store. Must be called before the
   * event about to be applied is inserted, so replay never includes it.
   */
  private ensureHydrated(sessionId: string | null): void {
    if (sessionId === null || this.normalizer.hasSession(sessionId)) return;
    if (this.store.getSession(sessionId) === null) return;
    this.replay(this.store.rawForSession(sessionId)); // changes are already persisted: discard
  }

  private replay(events: StoredRawEvent[]): Change[] {
    const changes: Change[] = [];
    const projectBySession = new Map<string, string>();
    for (const ev of events) {
      let projectId: string;
      if (ev.source === 'hook') {
        projectId = (ev.sessionId !== null ? projectBySession.get(ev.sessionId) : undefined) ?? UNKNOWN_PROJECT;
      } else {
        projectId = classifyPath(this.config.projectsDir, ev.file)?.projectId ?? UNKNOWN_PROJECT;
        projectBySession.set(ev.sessionId, projectId);
      }
      changes.push(...this.normalizer.apply(ev, projectId).changes);
    }
    return changes;
  }

  private commit(changes: Change[]): void {
    if (changes.length === 0) return;
    const applied = this.store.applyChanges(changes);
    for (const listener of [...this.listeners]) {
      try {
        listener(applied);
      } catch {
        // a failing subscriber must not break ingestion
      }
    }
  }

  /** Flags sessions whose recorded source file no longer exists. Data is kept. */
  private markDeletedSources(): void {
    const changes: Change[] = [];
    const seen = new Set<string>();
    for (const f of this.store.diagnostics().files) {
      const cls = classifyPath(this.config.projectsDir, f.path);
      if (cls?.kind !== 'session' || seen.has(cls.sessionId) || fs.existsSync(f.path)) continue;
      seen.add(cls.sessionId);
      const session = this.store.getSession(cls.sessionId);
      if (session && !session.sourceDeleted) changes.push({ type: 'session_upserted', session: { ...session, sourceDeleted: true } });
    }
    this.commit(changes);
  }
}
