import { useEffect, useState } from 'react';
import type { Diagnostics as DiagnosticsData } from '@claude-canvas/shared';
import { api } from '../client';
import { formatAge, summarizeDiagnostics, truncateSample } from '../diagnostics';
import { useNow } from '../useNow';

const REFRESH_MS = 5000;

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function Diagnostics() {
  const [data, setData] = useState<DiagnosticsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(1000);

  useEffect(() => {
    let alive = true;
    const load = (): void => {
      api.diagnostics().then(
        (d) => { if (alive) { setData(d); setError(null); } },
        (e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); },
      );
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  if (data === null) {
    return (
      <div className="diag">
        {error !== null ? <p className="error">刷新失败：{error}</p> : <p className="muted">加载中…</p>}
      </div>
    );
  }

  const sum = summarizeDiagnostics(data, now);
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
        <p>最近一次收到：{sum.hookAgeMs === null ? '从未' : formatAge(sum.hookAgeMs)}</p>
        {sum.hooks === 'never' && (
          <p className="diag-warn">尚未收到任何 hook。运行 <code>claude-canvas hooks install</code> 安装；新开的会话才会生效</p>
        )}
        {sum.hooks === 'quiet' && <p className="diag-warn">超过 10 分钟没有收到 hook</p>}
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
        <p>共 {sum.filesTotal} 个文件，{data.files.filter((f) => f.offset < f.size).length} 个尚未读完</p>
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
