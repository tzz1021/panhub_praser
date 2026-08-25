/** 系统终端：默认关（v2 实现 xterm.js；命令全审计）。这里先做状态提示 + 审计日志展示 */
import { useEffect, useState } from 'preact/hooks';
import { api, fmtTime } from '../api.js';

export default function Terminal({ toast }) {
  const [audit, setAudit] = useState([]);

  useEffect(() => {
    (async () => {
      const r = await api('/api/web/audit');
      if (r.ok) setAudit(r.data.entries ?? []);
    })();
  }, []);

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>系统终端</h2>
      <div className="card">
        <div className="row">
          <span className="tag gray">默认关闭</span>
          <span className="muted">v2 实现：xterm.js + 长期令牌鉴权，命令全部写审计日志</span>
        </div>
        <p className="dim" style={{ marginBottom: 0 }}>
          终端用于 CLI 管理 host（改端口/看配置/重启服务）。安全原因默认不开放；后续版本在「系统配置 → 高级」里开启。
        </p>
      </div>
      <div className="card">
        <h3>管理审计（最近 {audit.length} 条）</h3>
        <table className="tbl">
          <thead><tr><th>时间</th><th>动作</th><th>详情</th><th>来源</th></tr></thead>
          <tbody>
            {audit.map((a) => (
              <tr key={a.id}>
                <td className="mono">{fmtTime(a.ts)}</td>
                <td><span className="tag gray">{a.action}</span></td>
                <td className="mono" style={{ wordBreak: 'break-all' }}>{a.detail}</td>
                <td>{a.via}</td>
              </tr>
            ))}
            {audit.length === 0 && <tr><td colSpan={4} className="muted">暂无审计记录</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
