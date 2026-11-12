import { useEffect, useState } from 'react';
import type { Diagnostics as DiagnosticsData, Origin } from '@agent-canvas/shared';
import { api } from '../client';
import {
  codexDirLine, createPoller, cursorBlockVisible, cursorDbLine, cursorHooks, cursorPollLine, cursorUnknownRecords, fileOrigin, formatAge, hookState, hooksByOrigin, summarizeDiagnostics, truncateSample, FILES_BEHIND_MAX,
  type OriginHooks,
} from '../diagnostics';
import { OriginBadge } from '../OriginBadge';
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

/** Owns the 1-second tick for the "last poll" age. */
function CursorPoll({ lastPollAt }: { lastPollAt: string | null }) {
  const now = useNow(1000);
  return <p>上次轮询：{cursorPollLine(lastPollAt, now)}</p>;
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
      {unknown.length === 0 ? (
        <p className="muted">无</p>
      ) : (
        <ul>
          {unknown.map((r) => (
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
      )}
    </section>
  );
}

export function Diagnostics() {
  const [data, setData] = useState<DiagnosticsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const poller = createPoller({
      load: api.diagnostics,
      onResult: (r) => {
        if (r.ok) { setData(r.value); setError(null); } else setError(r.error);
      },
      intervalMs: REFRESH_MS,
    });
    poller.start();
    return () => poller.stop();
  }, []);

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
  return (
    <div className="diag">
      {error !== null && <p className="error">刷新失败：{error}</p>}

      <section>
        <h2>服务</h2>
        <p>正在导入：{data.importing ? '是' : '否'}</p>
        <p>推导规则版本：{data.normalizerVersion}</p>
        <p>数据库标识：<code>{data.dbEpoch}</code></p>
      </section>

      <section>
        <h2>Hooks</h2>
        {hooks.map((h) => (
          <OriginHookSection key={h.origin} hooks={h} titled={hooks.length > 1} codex={data.codex}
            lastAt={h.origin === 'claude' && onlyClaude ? data.lastHookAt : h.lastAt} />
        ))}
      </section>

      {cursorBlockVisible(data) && <CursorSection data={data} />}

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
        {data.unknownRecords.length === 0 ? (
          <p className="muted">无</p>
        ) : (
          <ul>
            {data.unknownRecords.map((r) => (
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
        )}
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
