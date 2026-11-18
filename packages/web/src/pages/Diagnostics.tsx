import { useEffect, useMemo, useState } from 'react';
import type { Diagnostics as DiagnosticsData, Origin } from '@agent-canvas/shared';
import { api } from '../client';
import {
  codexDirLine, createPoller, cursorBlockVisible, cursorDbLine, cursorHooks, cursorPollLine, cursorUnknownRecords, fileOrigin, fileSourceBlocks, fileSourceDetailLines, fileSourceDirLine, foreignHooksLine, formatAge, hookState, hooksByOrigin, summarizeDiagnostics, truncateSample, FILES_BEHIND_MAX,
  type FileSourceBlock, type OriginHooks,
} from '../diagnostics';
import { useMask } from '../MaskContext';
import { maskDiagnostics } from '../masking';
import { diagnosticsNotificationLines } from '../notifications';
import { OriginBadge } from '../OriginBadge';
import { searchIndexLines, storageLines, type DiagLine } from '../storageDiagnostics';
import { useNow } from '../useNow';

const REFRESH_MS = 5000;

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Owns the 1-second tick so the tables around it do not re-render every second. */
function HookStatus({ origin, lastAt }: { origin: Origin; lastAt: string | null }) {
  const now = useNow(1000);
  const st = hookState(lastAt, now);
  return (
    <>
      <p>最近一次收到：{st.hookAgeMs === null ? (st.hooks === 'never' ? '从未' : '时间无法识别') : formatAge(st.hookAgeMs)}</p>
      {st.hooks === 'never' && (origin === 'codex'
        ? <p className="diag-warn">尚未收到 Codex 的 hook：Codex hooks 还没有安装，或还没有在 Codex 里确认信任。不装也能用，只靠会话文件</p>
        : origin === 'cursor'
        ? <p className="diag-warn">尚未收到 Cursor 的 hook。运行 <code>agent-canvas hooks install --cursor</code> 安装；不装也能用，只靠 Cursor 的本地数据库</p>
        : <p className="diag-warn">尚未收到任何 hook。运行 <code>agent-canvas hooks install</code> 安装；新开的会话才会生效</p>)}
      {st.hooks === 'quiet' && <p className="diag-warn">超过 10 分钟没有收到 hook</p>}
    </>
  );
}

function OriginHookSection({ hooks, lastAt, titled, codex }: {
  hooks: OriginHooks; lastAt: string | null; titled: boolean; codex: DiagnosticsData['codex'];
}) {
  return (
    <div className="diag-origin">
      {titled && <h3><OriginBadge origin={hooks.origin} /></h3>}
      {hooks.origin === 'codex' && <p>{codexDirLine(codex)}</p>}
      <HookStatus origin={hooks.origin} lastAt={lastAt} />
      {hooks.events.length > 0 && (
        <table>
          <thead>
            <tr><th>事件名</th><th>次数</th><th>最近一次</th></tr>
          </thead>
          <tbody>
            {hooks.events.map((e) => (
              <tr key={e.eventName}>
                <td>{e.eventName}</td>
                <td>{e.count}</td>
                <td>{formatTime(e.lastAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {hooks.missing.length > 0 && <p className="muted">尚未收到过：{hooks.missing.join('、')}</p>}
    </div>
  );
}

/** A file's store key, with the origin shown for Codex and Cursor files (Claude Code paths look as before). */
function FilePath({ path }: { path: string }) {
  const origin = fileOrigin(path);
  return origin === 'claude' ? <>{path}</> : <><OriginBadge origin={origin} /> {path}</>;
}

/** The notifications line; nothing at all when the server reports no notifications block. */
function NotificationsSection({ data }: { data: DiagnosticsData['notifications'] }) {
  const now = useNow(1000);
  const n = diagnosticsNotificationLines(data, now);
  if (n === null) return null;
  return (
    <section>
      <h2>通知</h2>
      <p>桌面通知：{n.state}（<a href="#/notifications">设置</a>）</p>
      <p>最近一次发出：{n.lastSent}</p>
      {n.lastError !== null && <p className="error" style={{ padding: 0 }}>最近一次错误：{n.lastError}</p>}
      {n.settingsError !== null && <p className="diag-warn">保存的通知设置读不出来，按默认（关闭）处理：{n.settingsError}</p>}
    </section>
  );
}

function DiagLineView({ line }: { line: DiagLine }) {
  const cls = line.tone === 'warn' ? 'diag-warn' : line.tone === 'error' ? 'error' : line.tone === 'muted' ? 'muted' : undefined;
  return (
    <p className={cls} style={line.tone === 'error' ? { padding: 0 } : undefined}>
      {line.text}{line.command !== undefined && <code>{line.command}</code>}{line.tail}
    </p>
  );
}

/** Database file, compression, VACUUM and the content search index; nothing for a block an older server does not send. */
function DatabaseSection({ data }: { data: DiagnosticsData }) {
  const lines = [...(storageLines(data.storage) ?? []), ...(searchIndexLines(data.search) ?? [])];
  if (lines.length === 0) return null;
  return (
    <section>
      <h2>数据库</h2>
      {lines.map((l, i) => <DiagLineView key={i} line={l} />)}
    </section>
  );
}

/** Owns the 1-second tick for the "last poll" age. */
function CursorPoll({ lastPollAt }: { lastPollAt: string | null }) {
  const now = useNow(1000);
  return <p>上次轮询：{cursorPollLine(lastPollAt, now)}</p>;
}

/** Unknown record types with their samples (the shared list and the per-origin blocks). */
function UnknownList({ records }: { records: DiagnosticsData['unknownRecords'] }) {
  if (records.length === 0) return <p className="muted">无</p>;
  return (
    <ul>
      {records.map((r) => (
        <li key={r.recordType}>
          <div>{r.recordType}：{r.count} 次</div>
          {r.sample !== '' && (
            <details>
              <summary>样例</summary>
              <pre>{truncateSample(r.sample)}</pre>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * A file-only origin (Gemini CLI, Grok Build, Copilot CLI, DeepSeek, WorkBuddy, CodeBuddy, 豆包, Qwen Code): directory,
 * the lines of fileSourceDetailLines, session count and the unknown records. These are read from files only (no hooks,
 * no waiting states) and their formats were not checked against real data.
 */
function FileSourceSection({ block }: { block: FileSourceBlock }) {
  return (
    <section>
      <h2><OriginBadge origin={block.origin} /></h2>
      <p>{fileSourceDirLine(block.origin, block)}</p>
      {fileSourceDetailLines(block).map((line) => <p key={line.text} className={line.warn ? 'diag-warn' : undefined}>{line.text}</p>)}
      <p>会话数：{block.sessionCount}</p>
      <p className="muted">只读会话文件，没有 hook，不显示“等待确认”等实时状态。格式未经真实数据核对：显示不对时先看下面的未识别记录</p>
      <h3>未识别的记录</h3>
      <UnknownList records={block.unknown} />
    </section>
  );
}

/** Shown when Cursor's database exists or any Cursor data is known. */
function CursorSection({ data }: { data: DiagnosticsData }) {
  const c = data.cursor;
  const unknown = cursorUnknownRecords(data);
  const hooks = cursorHooks(data);
  return (
    <section>
      <h2><OriginBadge origin="cursor" /></h2>
      <p>{cursorDbLine(c)}</p>
      <CursorPoll lastPollAt={c.lastPollAt} />
      {c.lastError !== null && <p className="error">上次错误：{c.lastError}</p>}
      <h3>Hooks</h3>
      <OriginHookSection hooks={hooks} lastAt={hooks.lastAt} titled={false} codex={data.codex} />
      <h3>未识别的气泡形状</h3>
      <UnknownList records={unknown} />
    </section>
  );
}

export function Diagnostics() {
  /** The last answer and whether it was asked for with `mask=1`. */
  const [loaded, setData] = useState<{ d: DiagnosticsData; masked: boolean } | null>(null);
  const [rawError, setError] = useState<string | null>(null);
  // With the masking switch on: the unknown-record samples (conversation text) come masked by the server (`?mask=1`,
  // cut text in truncated mode); file keys, errors and paths are masked here (the samples once more, harmlessly). An
  // answer asked for without `mask=1` is not shown while the switch is on (fail closed: 加载中 until the masked one).
  const { list: m } = useMask();
  const rawData = loaded !== null && loaded.masked === m.on ? loaded.d : null;
  const data = useMemo(() => (rawData === null ? null : maskDiagnostics(rawData, m)), [rawData, m]);
  const error = rawError === null ? null : m.text(rawError);

  const maskOn = m.on;
  useEffect(() => {
    const poller = createPoller({
      load: () => (maskOn ? api.diagnostics(true) : api.diagnostics()).then((d) => ({ d, masked: maskOn })),
      onResult: (r) => {
        if (r.ok) { setData(r.value); setError(null); } else setError(r.error);
      },
      intervalMs: REFRESH_MS,
    });
    poller.start();
    return () => poller.stop();
  }, [maskOn]);

  if (data === null) {
    return (
      <div className="diag">
        {error !== null ? <p className="error">刷新失败：{error}</p> : <p className="muted">加载中…</p>}
      </div>
    );
  }

  const sum = summarizeDiagnostics(data, 0); // only the time-independent fields are used here
  // Cursor's hooks live in its own block.
  const hooks = hooksByOrigin(data).filter((h) => h.origin !== 'cursor');
  // With only Claude Code hooks the server's own "last hook" time is used, exactly as before the Codex split.
  const onlyClaude = data.hookEvents.every((e) => e.origin === 'claude');
  const foreign = foreignHooksLine(data.foreignHooksDropped);
  return (
    <div className="diag">
      {error !== null && <p className="error">刷新失败：{error}</p>}

      <section>
        <h2>服务</h2>
        <p>正在导入：{data.importing ? '是' : '否'}</p>
        <p>推导规则版本：{data.normalizerVersion}</p>
        <p>数据库标识：<code>{data.dbEpoch}</code></p>
      </section>

      <DatabaseSection data={data} />

      <section>
        <h2>Hooks</h2>
        {hooks.map((h) => (
          <OriginHookSection key={h.origin} hooks={h} titled={hooks.length > 1} codex={data.codex}
            lastAt={h.origin === 'claude' && onlyClaude ? data.lastHookAt : h.lastAt} />
        ))}
        {foreign !== null && <p className={foreign.warn ? 'diag-warn' : 'muted'}>{foreign.text}</p>}
      </section>

      <NotificationsSection data={data.notifications} />

      {cursorBlockVisible(data) && <CursorSection data={data} />}

      {fileSourceBlocks(data).map((b) => <FileSourceSection key={b.origin} block={b} />)}

      <section>
        <h2>导入失败</h2>
        {data.ingestFailures.length === 0 ? (
          <p className="muted">无</p>
        ) : (
          <table>
            <thead>
              <tr><th>文件</th><th>错误</th><th>时间</th></tr>
            </thead>
            <tbody>
              {data.ingestFailures.map((f) => (
                <tr key={f.file}>
                  <td><FilePath path={f.file} /></td>
                  <td>{f.error}</td>
                  <td>{formatTime(f.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>未识别的记录类型</h2>
        <UnknownList records={data.unknownRecords} />
      </section>

      <section>
        <h2>文件读取进度</h2>
        <p>共 {sum.filesTotal} 个文件，{sum.behindTotal} 个尚未读完</p>
        {sum.behindTotal > FILES_BEHIND_MAX && <p className="muted">仅显示前 {FILES_BEHIND_MAX} 条</p>}
        {sum.filesBehind.length > 0 && (
          <table>
            <thead>
              <tr><th>路径</th><th>已读 / 总字节</th></tr>
            </thead>
            <tbody>
              {sum.filesBehind.map((f) => (
                <tr key={f.path}>
                  <td><FilePath path={f.path} /></td>
                  <td>{f.offset} / {f.size}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
