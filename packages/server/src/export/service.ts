import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPORT_MAX_BYTES,
  parseExportOptions,
  parseExportSettings,
  type ExportPreview,
  type ExportSettingsResponse,
} from '@agent-canvas/shared';
import { assembleExport, ExportAbortedError, homeUsersOf, type ExportSource } from './assemble.js';
import { contentDisposition, exportFileName } from './filename.js';
import { fillTemplate, findViewerTemplate, TEMPLATE_SLOT } from './html.js';
import { renderMarkdown } from './markdown.js';
import { loadExportSettings, saveExportSettings } from './settings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The server package's version (package.json above src/ or dist/); 'unknown' when unreadable. */
function serverVersion(): string {
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', '..', 'package.json'), 'utf8'));
    const v = (pkg as { version?: unknown } | null)?.version;
    return typeof v === 'string' && v !== '' ? v : 'unknown';
  } catch {
    return 'unknown';
  }
}

function machineUser(): string | null {
  try {
    const name = os.userInfo().username;
    return name === '' ? null : name;
  } catch {
    return null;
  }
}

export interface ExportServiceOptions {
  store: ExportSource;
  /** Where export-settings.json lives. */
  dataDir: string;
  /** The viewer template's path, or null when it is not built (default: findViewerTemplate). */
  findTemplate?: () => string | null;
  version?: string;
  now?: () => Date;
  /** The service machine's user name for `personal` (default: os.userInfo()). */
  machineUser?: () => string | null;
  /** Export and preview jobs allowed at the same time (default 4); more are answered 429. */
  maxConcurrent?: number;
  /** The size limit (default EXPORT_MAX_BYTES; tests lower it). */
  maxBytes?: number;
  /** Event-loop yield interval of the assembly (default 15 ms). */
  yieldAfterMs?: number;
}

/** An HTTP answer: a JSON body ({ error } or a value), or a file (`file` with its headers). */
export type ExportAnswer =
  | { status: number; json: unknown }
  | { status: 200; file: Buffer; headers: Record<string, string> };

const BUSY: ExportAnswer = { status: 429, json: { error: '同时进行的导出太多，请稍后再试' } };
const TOO_LARGE = (max: number): ExportAnswer => ({
  status: 413,
  json: { error: `导出内容超过 ${Math.round(max / 1024 / 1024)} MB，请缩小范围或减少输出` },
});
const FAILED: ExportAnswer = { status: 500, json: { error: '导出失败' } };
const GONE: ExportAnswer = { status: 499, json: { error: '请求已取消' } };

/**
 * Export settings, preview and export (spec 4.2). Answers carry types, counts and sizes only, except the exported file.
 * Nothing is logged. A job stops at its next check once `stopped()` turns true (the client went away).
 */
export class ExportService {
  private active = 0;
  private readonly maxConcurrent: number;
  private readonly maxBytes: number;

  constructor(private readonly options: ExportServiceOptions) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 4);
    this.maxBytes = options.maxBytes ?? EXPORT_MAX_BYTES;
  }

  /** Jobs running now (for tests and diagnostics). */
  activeJobs(): number {
    return this.active;
  }

  getSettings(): ExportSettingsResponse {
    return loadExportSettings(this.options.dataDir);
  }

  putSettings(body: unknown): ExportAnswer {
    const parsed = parseExportSettings(body);
    if (!parsed.ok) return { status: 400, json: { error: parsed.error } };
    try {
      saveExportSettings(this.options.dataDir, parsed.settings);
    } catch {
      return { status: 500, json: { error: '保存导出设置失败' } };
    }
    return { status: 200, json: { customTerms: parsed.settings.customTerms, settingsError: null } satisfies ExportSettingsResponse };
  }

  private template(): string | null {
    const file = (this.options.findTemplate ?? findViewerTemplate)();
    if (file === null) return null;
    try {
      const text = fs.readFileSync(file, 'utf8');
      return text.includes(TEMPLATE_SLOT) ? text : null;
    } catch {
      return null;
    }
  }

  private homeUsers(cwd: string | null): string[] {
    const users = homeUsersOf(cwd);
    const machine = (this.options.machineUser ?? machineUser)();
    if (machine !== null) users.push(machine);
    return users;
  }

  private async run(job: () => Promise<ExportAnswer>): Promise<ExportAnswer> {
    if (this.active >= this.maxConcurrent) return BUSY;
    this.active++;
    try {
      return await job();
    } catch (err) {
      return err instanceof ExportAbortedError ? GONE : FAILED;
    } finally {
      this.active--;
    }
  }

  /** POST /api/sessions/:id/export/preview. */
  async preview(sessionId: string, body: unknown, stopped: () => boolean = () => false): Promise<ExportAnswer> {
    const parsed = parseExportOptions(body);
    if (!parsed.ok) return { status: 400, json: { error: parsed.error } };
    const options = parsed.options;
    const session = this.options.store.getSession(sessionId);
    if (session === null) return { status: 404, json: { error: 'session not found' } };
    return this.run(async () => {
      const template = options.format === 'html' ? this.template() : null;
      const result = await assembleExport(this.options.store, sessionId, options, {
        customTerms: this.getSettings().customTerms,
        homeUsers: this.homeUsers(session.cwd),
        version: this.options.version ?? serverVersion(),
        now: (this.options.now ?? (() => new Date()))(),
        mode: 'preview',
        extraBytes: template === null ? 0 : Buffer.byteLength(template, 'utf8'),
        stopped,
        maxBytes: this.maxBytes,
        ...(this.options.yieldAfterMs !== undefined ? { yieldAfterMs: this.options.yieldAfterMs } : {}),
      });
      if (result.kind === 'not-found') return { status: 404, json: { error: 'session not found' } };
      if (result.kind === 'unknown-turn') return { status: 400, json: { error: '这个会话里没有这一轮' } };
      return { status: 200, json: result.preview satisfies ExportPreview };
    });
  }

  /** POST /api/sessions/:id/export: the file. */
  async export(sessionId: string, body: unknown, stopped: () => boolean = () => false): Promise<ExportAnswer> {
    const parsed = parseExportOptions(body);
    if (!parsed.ok) return { status: 400, json: { error: parsed.error } };
    const options = parsed.options;
    const session = this.options.store.getSession(sessionId);
    if (session === null) return { status: 404, json: { error: 'session not found' } };
    let template: string | null = null;
    if (options.format === 'html') {
      template = this.template();
      if (template === null) {
        return { status: 501, json: { error: 'HTML 查看器还没有构建（缺少 viewer-template.html），请先构建网页，或改用 Markdown 导出' } };
      }
    }
    return this.run(async () => {
      const now = (this.options.now ?? (() => new Date()))();
      const result = await assembleExport(this.options.store, sessionId, options, {
        customTerms: this.getSettings().customTerms,
        homeUsers: this.homeUsers(session.cwd),
        version: this.options.version ?? serverVersion(),
        now,
        mode: 'bundle',
        extraBytes: template === null ? 0 : Buffer.byteLength(template, 'utf8'),
        stopped,
        maxBytes: this.maxBytes,
        ...(this.options.yieldAfterMs !== undefined ? { yieldAfterMs: this.options.yieldAfterMs } : {}),
      });
      if (result.kind === 'not-found') return { status: 404, json: { error: 'session not found' } };
      if (result.kind === 'unknown-turn') return { status: 400, json: { error: '这个会话里没有这一轮' } };
      if (result.bundle === null) return TOO_LARGE(this.maxBytes);
      if (stopped()) throw new ExportAbortedError();
      const text = template === null ? renderMarkdown(result.bundle) : fillTemplate(template, result.bundle);
      const file = Buffer.from(text, 'utf8');
      if (file.length > this.maxBytes) return TOO_LARGE(this.maxBytes);
      const name = exportFileName(result.bundle.session.title, now, options.format);
      return {
        status: 200,
        file,
        headers: {
          'content-type': options.format === 'md' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8',
          'content-disposition': contentDisposition(name),
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        },
      };
    });
  }
}
