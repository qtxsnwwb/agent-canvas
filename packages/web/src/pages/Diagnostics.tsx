import { useEffect, useState } from 'react';
import type { Diagnostics as DiagnosticsData } from '@claude-canvas/shared';
import { api } from '../client';
import { createPoller, formatAge, summarizeDiagnostics, truncateSample, FILES_BEHIND_MAX, type DiagnosticsSummary } from '../diagnostics';
import { useNow } from '../useNow';

const REFRESH_MS = 5000;

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Owns the 1-second tick so the tables around it do not re-render every second. */
function HookStatus({ data }: { data: DiagnosticsData }) {
  const now = useNow(1000);
  const sum: DiagnosticsSummary = summarizeDiagnostics(data, now);
  return (
    <>
      <p>最近一次收到：{sum.hookAgeMs === null ? (sum.hooks === 'never' ? '从未' : '时间无法识别') : formatAge(sum.hookAgeMs)}</p>
      {sum.hooks === 'never' && (
        <p className="diag-warn">尚未收到任何 hook。运行 <code>claude-canvas hooks install</code> 安装；新开的会话才会生效</p>
      )}
      {sum.hooks === 'quiet' && <p className="diag-warn">超过 10 分钟没有收到 hook</p>}
    </>
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
        <HookStatus data={data} />
        {data.hookEvents.length > 0 && (
          <table>
            <thead>
              <tr><th>事件名</th><th>次数</th><th>最近一次</th></tr>
            </thead>
            <tbody>
              {data.hookEvents.map((e) => (
                <tr key={e.eventName}>
                  <td>{e.eventName}</td>
                  <td>{e.count}</td>
                  <td>{formatTime(e.lastAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {sum.missingHookEvents.length > 0 && <p className="muted">尚未收到过：{sum.missingHookEvents.join('、')}</p>}
      </section>

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
                  <td>{f.file}</td>
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
                  <td>{f.path}</td>
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
