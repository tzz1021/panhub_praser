/** 操作日志：backend 自身活动记录（audit_log 表），与上游网盘调用无关。
 *  上游代理调用记录（proxy_logs）在「数据看板」；这里只展示 backend 自己的动作：
 *  账号增删改 / 令牌轮换 / 日志清理 / hosts 映射 / 云端取号 / 刷新标记等。
 *  keyword 过滤 + 3s 轮询。
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, fmtTime } from '../api.js';

export default function Logs({ toast }) {
  const [entries, setEntries] = useState([]);
  const [q, setQ] = useState('');
  const [auto, setAuto] = useState(true);
  const boxRef = useRef(null);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const params = new URLSearchParams({ limit: '500' });
      if (q) params.set('q', q);
      const r = await api(`/api/web/audit?${params}`);
      if (!stop && r.ok) {
        setEntries(r.data.entries ?? []);
        if (auto && boxRef.current) boxRef.current.scrollTop = 0;
      }
    };
    tick();
    const timer = setInterval(tick, 3000);
    return () => { stop = true; clearInterval(timer); };
  }, [q, auto]);

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>操作日志</h2>
      <div className="card" style={{ paddingBottom: 8 }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <input className="input" style={{ width: 220 }} placeholder="关键字过滤（action / 详情 / via）" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="row" style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> 自动刷新(3s)
          </label>
        </div>
        <p className="muted" style={{ margin: '0 0 6px' }}>
          backend 自身活动（账号增删改 / 令牌轮换 / 日志清理 / hosts / 云端取号等）。上游网盘调用记录见「数据看板」。
        </p>
        <div ref={boxRef} style={{ maxHeight: 'calc(100vh - 220px)', overflowY: 'auto', background: 'var(--bg)', borderRadius: 8, padding: 6 }}>
          {entries.length === 0 && <p className="muted" style={{ padding: 12 }}>暂无操作记录</p>}
          {entries.map((e) => (
            <div key={e.id} className="log-line">
              <span className="muted">{fmtTime(e.ts)}</span>{' '}
              <span className="tag gray">{e.action}</span>
              {e.via && <span className="tag" style={{ marginRight: 4 }}>{e.via}</span>}
              {e.detail}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
