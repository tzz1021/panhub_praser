/** 实时日志：级别/网盘/关键字 filter + 3s 轮询 + 队列状态 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api.js';

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug'];

export default function Logs({ toast }) {
  const [logs, setLogs] = useState([]);
  const [queue, setQueue] = useState(null);
  const [level, setLevel] = useState('');
  const [pan, setPan] = useState('');
  const [q, setQ] = useState('');
  const [auto, setAuto] = useState(true);
  const boxRef = useRef(null);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const params = new URLSearchParams({ limit: '300' });
      if (level) params.set('level', level);
      if (pan) params.set('pan', pan);
      if (q) params.set('q', q);
      const r = await api(`/api/web/logs?${params}`);
      if (!stop && r.ok) {
        setLogs(r.data.logs ?? []);
        setQueue(r.data.queue ?? null);
        if (auto && boxRef.current) boxRef.current.scrollTop = 0;
      }
    };
    tick();
    const timer = setInterval(tick, 3000);
    return () => { stop = true; clearInterval(timer); };
  }, [level, pan, q, auto]);

  const clearRing = async () => {
    const r = await api('/api/web/logs/clear', { method: 'POST', body: {} });
    if (r.ok) { setLogs([]); toast('环形日志已清空', 'ok'); }
  };

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>实时日志</h2>
      <div className="card" style={{ paddingBottom: 8 }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <select className="input" style={{ width: 110 }} value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">全部级别</option>
            {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <select className="input" style={{ width: 110 }} value={pan} onChange={(e) => setPan(e.target.value)}>
            <option value="">全部网盘</option>
            <option value="quark">quark</option>
            <option value="uc">uc</option>
          </select>
          <input className="input" style={{ width: 200 }} placeholder="关键字过滤" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="row" style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> 自动刷新(3s)
          </label>
          <button className="btn btn-sm" onClick={clearRing}>清空环形日志</button>
        </div>
        {queue && (
          <p className="muted" style={{ margin: '0 0 6px' }}>
            队列：排队 <b>{queue.queued}</b> · 运行中 <b>{queue.running}</b> · 最长等待 <b>{queue.longestMs}ms</b>（debug 级）
          </p>
        )}
        <div ref={boxRef} style={{ maxHeight: 'calc(100vh - 220px)', overflowY: 'auto', background: 'var(--bg)', borderRadius: 8, padding: 6 }}>
          {logs.length === 0 && <p className="muted" style={{ padding: 12 }}>暂无日志（转发请求后这里会出现调用记录）</p>}
          {logs.map((l, i) => (
            <div key={i} className="log-line">
              <span className="muted">{new Date(l.ts).toISOString().slice(11, 19)}</span>{' '}
              <span className={`lv lv-${l.level}`}>{l.level}</span>
              {l.pan && <span className="tag gray" style={{ marginRight: 4 }}>{l.pan}</span>}
              {l.operation && <span className="tag" style={{ marginRight: 4 }}>{l.operation}</span>}
              {l.msg}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
