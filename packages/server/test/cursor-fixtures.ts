import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// A synthetic Cursor state database in a temp dir: the real table shapes (spec 2), invented content. Layout mirrors
// Cursor's: <root>/User/globalStorage/state.vscdb and <root>/User/workspaceStorage/<id>/workspace.json.

export interface FixtureBubble {
  bubbleId: string;
  type: 1 | 2;
  [field: string]: unknown;
}

export interface ComposerSpec {
  id: string;
  workspaceId?: string | null;
  createdAt?: number;
  lastUpdatedAt?: number;
  isArchived?: boolean;
  isSubagent?: boolean;
  isDraft?: boolean;
  name?: string;
  status?: string;
  /** `workspaceIdentifier.uri.fsPath` of the header value. */
  headerFsPath?: string;
  /** `workspaceIdentifier.uri.fsPath` of composerData. */
  dataFsPath?: string;
  subagentInfo?: Record<string, unknown>;
  bubbles?: FixtureBubble[];
  /** false: no composerData row at all. */
  withData?: boolean;
}

const T0 = Date.parse('2026-11-12T08:00:00.000Z');

export class CursorDbFixture {
  readonly dbPath: string;
  readonly workspaceStorage: string;
  private readonly db: Database.Database;
  private readonly specs = new Map<string, ComposerSpec>();

  constructor(root: string) {
    const global = path.join(root, 'User', 'globalStorage');
    this.workspaceStorage = path.join(root, 'User', 'workspaceStorage');
    fs.mkdirSync(global, { recursive: true });
    fs.mkdirSync(this.workspaceStorage, { recursive: true });
    this.dbPath = path.join(global, 'state.vscdb');
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
      CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
      CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER,
        isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT, subagentTypeName TEXT);
    `);
  }

  /** Adds or replaces a conversation: header row, composerData and its bubbles (as BLOBs, like Cursor). */
  put(spec: ComposerSpec): void {
    this.specs.set(spec.id, spec);
    const createdAt = spec.createdAt ?? T0;
    const lastUpdatedAt = spec.lastUpdatedAt ?? createdAt;
    const workspaceId = spec.workspaceId === undefined ? 'ws-1' : spec.workspaceId;
    const headerValue = {
      type: 'head',
      composerId: spec.id,
      name: spec.name ?? `Conversation ${spec.id}`,
      createdAt,
      lastUpdatedAt,
      unifiedMode: 'agent',
      forceMode: 'edit',
      isDraft: spec.isDraft ?? false,
      isArchived: spec.isArchived ?? false,
      workspaceIdentifier:
        spec.headerFsPath === undefined
          ? { id: workspaceId }
          : { id: workspaceId, uri: { fsPath: spec.headerFsPath, path: '/x', scheme: 'file', external: 'file:///x' } },
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value, subagentTypeName)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(spec.id, workspaceId, createdAt, lastUpdatedAt, spec.isArchived ? 1 : 0, spec.isSubagent ? 1 : 0, lastUpdatedAt, null, JSON.stringify(headerValue), null);
    const bubbles = spec.bubbles ?? [];
    if (spec.withData !== false) {
      const data: Record<string, unknown> = {
        _v: 10,
        composerId: spec.id,
        name: spec.name ?? `Conversation ${spec.id}`,
        status: spec.status ?? 'completed',
        createdAt,
        lastUpdatedAt,
        unifiedMode: 'agent',
        modelConfig: { modelName: 'synthetic-model', maxMode: false },
        isDraft: spec.isDraft ?? false,
        richText: '',
        text: '',
        context: { fileSelections: [], folderSelections: [] },
        fullConversationHeadersOnly: bubbles.map((b) => ({
          bubbleId: b.bubbleId,
          type: b.type,
          createdAt: b.createdAt,
          startedAtMs: b.startedAtMs,
          completedAtMs: b.completedAtMs,
          grouping: { kind: 'none' },
        })),
      };
      if (spec.dataFsPath !== undefined) data.workspaceIdentifier = { id: workspaceId, uri: { fsPath: spec.dataFsPath } };
      if (spec.subagentInfo !== undefined) data.subagentInfo = spec.subagentInfo;
      this.setKv(`composerData:${spec.id}`, JSON.stringify(data));
    }
    for (const b of bubbles) this.setBubble(spec.id, b);
  }

  /** Changes a conversation's spec (header and composerData rewritten; bubbles rewritten too). */
  update(id: string, patch: Partial<ComposerSpec>): void {
    const spec = this.specs.get(id);
    if (spec === undefined) throw new Error(`no composer ${id}`);
    this.put({ ...spec, ...patch });
  }

  setBubble(composerId: string, bubble: FixtureBubble): void {
    this.setKv(`bubbleId:${composerId}:${bubble.bubbleId}`, JSON.stringify(withNoise(bubble)));
  }

  /** Raw text under a bubble's key (e.g. JSON that does not parse). */
  setBubbleRaw(composerId: string, bubbleId: string, text: string): void {
    this.setKv(`bubbleId:${composerId}:${bubbleId}`, text);
  }

  setKv(key: string, value: string, asText = false): void {
    this.db.prepare(`INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)`).run(key, asText ? value : Buffer.from(value, 'utf8'));
  }

  remove(id: string): void {
    this.db.prepare(`DELETE FROM composerHeaders WHERE composerId = ?`).run(id);
    this.specs.delete(id);
  }

  writeWorkspaceJson(workspaceId: string, content: Record<string, unknown>): void {
    const dir = path.join(this.workspaceStorage, workspaceId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify(content));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}

/** Editor-state noise every real bubble carries; the trim must drop all of it. */
function withNoise(b: FixtureBubble): Record<string, unknown> {
  return {
    _v: 3,
    ...b,
    codebaseContextChunks: [],
    commits: [],
    pullRequests: [],
    gitDiffs: [],
    attachedCodeChunks: [],
    lints: [],
    richText: '',
    toolResults: [],
  };
}

let seq = 0;
const iso = (ms: number): string => new Date(ms).toISOString();

export function userBubble(bubbleId: string, text: string, at: number = T0): FixtureBubble {
  return { bubbleId, type: 1, text, createdAt: iso(at), startedAtMs: at, completedAtMs: at, tokenCount: { inputTokens: 0, outputTokens: 0 } };
}

export function textBubble(bubbleId: string, text: string, at: number = T0, extra: Record<string, unknown> = {}): FixtureBubble {
  return { bubbleId, type: 2, text, createdAt: iso(at), startedAtMs: at, completedAtMs: at + 500, tokenCount: { inputTokens: 10, outputTokens: 20 }, ...extra };
}

export function thinkingBubble(bubbleId: string, text: string, at: number = T0): FixtureBubble {
  return {
    bubbleId,
    type: 2,
    capabilityType: 30,
    text: '',
    thinking: { text, signature: 'sig-xyz' },
    thinkingDurationMs: 1200,
    createdAt: iso(at),
    startedAtMs: at,
    completedAtMs: at + 1200,
    tokenCount: { inputTokens: 0, outputTokens: 0 },
  };
}

export function toolBubble(
  bubbleId: string,
  name: string,
  status: 'completed' | 'error' | 'loading' | 'cancelled',
  at: number = T0,
  extra: { toolCallId?: string; params?: unknown; result?: unknown } = {},
): FixtureBubble {
  seq += 1;
  return {
    bubbleId,
    type: 2,
    capabilityType: 15,
    text: '',
    createdAt: iso(at),
    startedAtMs: at,
    ...(status === 'loading' ? {} : { completedAtMs: at + 300 }),
    tokenCount: { inputTokens: 5, outputTokens: 6 },
    toolFormerData: {
      tool: 7,
      name,
      status,
      toolCallId: extra.toolCallId ?? `call-${bubbleId}`,
      params: JSON.stringify(extra.params ?? { target: `file-${seq}.txt` }),
      result: status === 'loading' ? undefined : JSON.stringify(extra.result ?? { ok: true }),
      rawArgs: '{"raw":true}',
      additionalData: { status: 'x' },
      toolCallBinary: 'B'.repeat(2048),
    },
  };
}

export { T0 };
