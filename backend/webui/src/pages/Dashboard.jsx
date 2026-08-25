/** 基础信息：服务器 cpu/内存/系统、host 版本、运行时长 */
import { useEffect, useState } from 'preact/hooks';
import { api, fmtTime, fmtUptime } from '../api.js';

export default function Dashboard({ toast }) {
  const [info, setInfo] = useState(null);

  useEffect(() => {
    (async () => {
      const r = await api('/api/web/info');
      if (r.ok) setInfo(r.data);
      else toast(r.data?.message ?? '加载失败', 'err');
    })();
  }, []);

  if (!info) return <p className="muted">加载中…</p>;

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>基础信息</h2>
      <div className="stat-grid">
        <div className="stat-box"><div className="lbl">运行时长</div><div className="num">{fmtUptime(info.uptimeMs)}</div></div>
        <div className="stat-box"><div className="lbl">启动时间</div><div className="num" style={{ fontSize: 15 }}>{fmtTime(info.bootAt)}</div></div>
        <div className="stat-box"><div className="lbl">Node 版本</div><div className="num" style={{ fontSize: 15 }}>{info.node}</div></div>
        <div className="stat-box"><div className="lbl">进程 PID</div><div className="num" style={{ fontSize: 15 }}>{info.pid}</div></div>
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h3>服务器</h3>
        <table className="tbl">
          <tbody>
            <tr><td style={{ width: 140 }}>主机名</td><td className="mono">{info.hostname}</td></tr>
            <tr><td>平台</td><td className="mono">{info.platform} · {info.arch}</td></tr>
            <tr><td>数据库</td><td className="mono">{info.dbPath}</td></tr>
            <tr><td>版本</td><td>backend v{info.version}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
