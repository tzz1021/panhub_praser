/** 数据看板：天×网盘×操作柱形图 + 调用明细表 + 单次调用脱敏头（完整头在服务器 debug 文件） */
import { useEffect, useState } from 'preact/hooks';
import { api, fmtTime } from '../api.js';

const PAN_COLORS = { quark: '#059669', uc: '#3b82f6', '?': '#94a3b8' };

export default function Stats({ toast }) {
  const [days, setDays] = useState(7);
  const [stats, setStats] = useState(null);

  useEffect(() => {
    (async () => {
      const r = await api(`/api/web/stats?days=${days}`);
      if (r.ok) setStats(r.data);
      else toast(r.data?.message ?? '加载失败', 'err');
    })();
  }, [days]);

  if (!stats) return <p className="muted">加载中…</p>;

  const maxTotal = Math.max(1, ...stats.days.map((d) => Object.values(d.byPan).reduce((s, p) => s + p.total, 0)));

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>数据看板</h2>
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="muted">统计范围：</span>
        {[3, 7, 14, 30].map((d) => (
          <button key={d} className={`btn btn-sm ${days === d ? 'btn-primary' : ''}`} onClick={() => setDays(d)}>{d} 天</button>
        ))}
      </div>
      <div className="card">
        <h3>使用记录（天 × 网盘）</h3>
        <div className="bars">
          {stats.days.map((d) => {
            const total = Object.values(d.byPan).reduce((s, p) => s + p.total, 0);
            return (
              <div key={d.day} className="bar tooltip" data-tip={`${d.day} · ${total} 次`} style={{ height: `${Math.max(2, (total / maxTotal) * 100)}%` }}>
                <span style={{ position: 'absolute', top: -18, left: '50%', transform: 'translateX(-50%)', fontSize: 10, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
                  {d.day.slice(5)}
                </span>
              </div>
            );
          })}
        </div>
        <div className="legend">
          {Object.entries(PAN_COLORS).map(([pan, c]) => (
            <span key={pan}><span className="k" style={{ background: c }} />{pan}</span>
          ))}
        </div>
        <table className="tbl" style={{ marginTop: 12 }}>
          <thead>
            <tr><th>日期</th><th>网盘</th><th>scan</th><th>prase</th><th>其他</th><th>合计</th></tr>
          </thead>
          <tbody>
            {stats.days.flatMap((d) => {
              const pans = Object.entries(d.byPan);
              if (pans.length === 0) return [<tr key={d.day}><td>{d.day}</td><td colSpan={5} className="muted">—</td></tr>];
              return pans.map(([pan, p]) => (
                <tr key={`${d.day}-${pan}`}>
                  <td>{d.day}</td>
                  <td><span className="tag gray">{pan}</span></td>
                  <td>{p.scan ?? 0}</td><td>{p.prase ?? 0}</td><td>{p.other ?? 0}</td>
                  <td><b>{p.total}</b></td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>调用明细（最近 {stats.calls.length} 条）</h3>
        <table className="tbl">
          <thead>
            <tr><th>时间</th><th>网盘</th><th>操作</th><th>方法</th><th>URL</th><th>状态</th><th>耗时</th><th>账号</th><th>详情</th></tr>
          </thead>
          <tbody>
            {stats.calls.map((c) => (
              <tr key={c.id}>
                <td className="mono">{fmtTime(c.ts)}</td>
                <td>{c.pan ?? <span className="muted">-</span>}</td>
                <td><span className="tag">{c.operation}</span></td>
                <td className="mono">{c.method}</td>
                <td className="mono" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.url}>{c.url}</td>
                <td><span className={`tag ${c.req_status >= 400 ? 'red' : ''}`}>{c.req_status}</span></td>
                <td className="mono">{c.duration_ms}ms</td>
                <td>{c.account_id ? <span className="tag gray">#{c.account_id}</span> : <span className="muted">-</span>}</td>
                <td><button className="btn btn-sm" onClick={() => toast(`脱敏头已展示：查看 #${c.id} 的完整头请到服务器 data/tmp/debug-*.log（权限 600）`, 'info')}>头</button></td>
              </tr>
            ))}
            {stats.calls.length === 0 && <tr><td colSpan={9} className="muted">暂无调用记录（代理还没转发过请求）</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
