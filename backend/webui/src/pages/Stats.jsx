/** 数据看板（v1.2.2）：使用记录（天×网盘）+ 调用明细（「<>」展开详情 / 严重警告红标）+ 重复检测 Tab
 *  - 展开：GET /api/web/calls/:id/detail → 请求摘要 + file_hits 文件级表格
 *  - warning=true（req_status 为空，请求未完成）→ 整行红标「严重警告」
 *  - 重复检测：GET /api/web/abuse（file_hits 按 fid|md5 聚合，暴力解析检测）
 */
import { Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api, fmtTime, getCallDetail, getAbuse } from '../api.js';

const PAN_COLORS = { quark: '#059669', uc: '#3b82f6', '?': '#94a3b8' };

function fmtSize(n) {
  if (n == null) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** 展开后的详情区：请求摘要 + file_hits */
function DetailBox({ detail, loading, id }) {
  if (loading) return <p className="muted">加载中…</p>;
  if (!detail) return <p className="muted">详情加载失败（记录可能已被清理）</p>;
  const hits = Array.isArray(detail.file_hits) ? detail.file_hits : [];
  return (
    <div>
      <h4 style={{ margin: '0 0 6px' }}>请求摘要 #{id}</h4>
      <table className="tbl">
        <tbody>
          <tr><td style={{ width: 90 }}>URL</td><td className="mono" style={{ wordBreak: 'break-all' }}>{detail.url ?? '-'}</td></tr>
          <tr><td>方法</td><td className="mono">{detail.method ?? '-'}</td></tr>
          <tr>
            <td>状态</td>
            <td className="mono">
              {detail.req_status != null ? detail.req_status : <span className="tag red">未完成（严重警告）</span>}
            </td>
          </tr>
          <tr><td>耗时</td><td className="mono">{detail.duration_ms != null ? `${detail.duration_ms}ms` : '-'}{detail.req_ms != null ? `（上游 ${detail.req_ms}ms）` : ''}</td></tr>
          <tr><td>账号</td><td className="mono">{detail.account_id ? `#${detail.account_id}` : '-'}</td></tr>
          <tr><td>网盘 / 操作</td><td className="mono">{detail.pan ?? '-'} / {detail.operation ?? '-'}</td></tr>
          <tr><td>时间</td><td className="mono">{fmtTime(detail.ts)}</td></tr>
          <tr><td>frontend_id</td><td className="mono" style={{ wordBreak: 'break-all' }}>{detail.frontend_id || '-'}</td></tr>
        </tbody>
      </table>
      <h4 style={{ margin: '12px 0 6px' }}>file_hits（文件级，{hits.length} 条）</h4>
      {hits.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>无（非文件解析请求，或响应体解析失败不阻断请求）</p>
      ) : (
        <table className="tbl">
          <thead>
            <tr><th>fid</th><th>file_name</th><th>md5</th><th>size</th></tr>
          </thead>
          <tbody>
            {hits.map((h, i) => (
              <tr key={i}>
                <td className="mono">{h.fid ?? '-'}</td>
                <td>{h.file_name ?? '-'}</td>
                <td className="mono">{h.md5 ?? '-'}</td>
                <td className="mono">{fmtSize(h.size)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function Stats({ toast }) {
  const [tab, setTab] = useState('calls'); // 'calls' | 'abuse'
  const [days, setDays] = useState(7);
  const [pan, setPan] = useState(''); // '' = 全部网盘（v1.2.2 微调：原「实时日志」的网盘过滤挪到这里）
  const [stats, setStats] = useState(null);

  useEffect(() => {
    (async () => {
      const r = await api(`/api/web/stats?days=${days}${pan ? `&pan=${pan}` : ''}`);
      if (r.ok) setStats(r.data);
      else toast(r.data?.message ?? '加载失败', 'err');
    })();
  }, [days, pan]);

  /* ---------- 调用明细：展开详情 ---------- */
  const [openIds, setOpenIds] = useState(() => new Set());
  const [details, setDetails] = useState({});
  const [loading, setLoading] = useState({});

  const toggleDetail = async (c) => {
    const id = c.id;
    if (openIds.has(id)) {
      const n = new Set(openIds);
      n.delete(id);
      setOpenIds(n);
      return;
    }
    setOpenIds((prev) => new Set(prev).add(id));
    if (details[id] || loading[id]) return;
    setLoading((p) => ({ ...p, [id]: true }));
    const r = await getCallDetail(id);
    setLoading((p) => ({ ...p, [id]: false }));
    if (r.ok) setDetails((p) => ({ ...p, [id]: r.data }));
    else toast(r.data?.message ?? `详情加载失败（#${id}）`, 'err');
  };

  /* ---------- 重复检测 ---------- */
  const [abuseForm, setAbuseForm] = useState({ pan: 'quark', by: 'fid', days: 7, min: 3, limit: 50 });
  const [abuse, setAbuse] = useState(null);

  const runAbuse = async () => {
    const f = abuseForm;
    const r = await getAbuse({
      pan: f.pan || undefined, // pan 为空 = 不按网盘过滤（全部）
      by: f.by,
      days: f.days || undefined,
      min: f.min || undefined,
      limit: f.limit || undefined,
    });
    if (r.ok) setAbuse(r.data);
    else toast(r.data?.message ?? '重复检测失败', 'err');
  };
  const setF = (k, v) => setAbuseForm((p) => ({ ...p, [k]: v }));

  if (!stats) return <p className="muted">加载中…</p>;

  const maxTotal = Math.max(1, ...stats.days.map((d) => Object.values(d.byPan).reduce((s, p) => s + p.total, 0)));
  const abuseRows = Array.isArray(abuse) ? abuse : (abuse?.rows ?? []);

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>数据看板</h2>
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="muted">统计范围：</span>
        {[3, 7, 14, 30].map((d) => (
          <button key={d} className={`btn btn-sm ${days === d ? 'btn-primary' : ''}`} onClick={() => setDays(d)}>{d} 天</button>
        ))}
        <span style={{ width: 12 }} />
        <span className="muted">网盘：</span>
        <select className="input" style={{ width: 110 }} value={pan} onChange={(e) => setPan(e.target.value)}>
          <option value="">全部网盘</option>
          <option value="quark">quark</option>
          <option value="uc">uc</option>
        </select>
        <span style={{ width: 12 }} />
        {[['calls', '调用明细'], ['abuse', '重复检测']].map(([id, label]) => (
          <button key={id} className={`btn btn-sm ${tab === id ? 'btn-primary' : ''}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === 'calls' && (
        <div>
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
                {stats.calls.map((c) => {
                  const warn = c.warning === true || c.req_status == null; // 请求未完成 → 严重警告
                  const open = openIds.has(c.id);
                  return (
                    <Fragment key={c.id}>
                      <tr className={warn ? 'warn-row' : ''}>
                        <td className="mono">{fmtTime(c.ts)}</td>
                        <td>{c.pan ?? <span className="muted">-</span>}</td>
                        <td><span className="tag">{c.operation}</span></td>
                        <td className="mono">{c.method}</td>
                        <td className="mono" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.url}>{c.url}</td>
                        <td>
                          {warn
                            ? <span className="tag red">严重警告</span>
                            : <span className={`tag ${c.req_status >= 400 ? 'red' : ''}`}>{c.req_status}</span>}
                        </td>
                        <td className="mono">{c.duration_ms != null ? `${c.duration_ms}ms` : '-'}</td>
                        <td>{c.account_tag ? <span className="tag gray">{c.account_tag}</span> : <span className="muted">-</span>}</td>
                        <td>
                          <button className="btn btn-sm mono" title="展开详情（请求摘要 + file_hits）" onClick={() => toggleDetail(c)}>{'<>'}</button>
                        </td>
                      </tr>
                      {open && (
                        <tr className="detail-row">
                          <td colSpan={9}>
                            <DetailBox detail={details[c.id]} loading={loading[c.id]} id={c.id} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {stats.calls.length === 0 && <tr><td colSpan={9} className="muted">暂无调用记录（代理还没转发过请求）</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'abuse' && (
        <div className="card">
          <h3>重复检测（file_hits 按 fid/md5 聚合 · 暴力解析检测）</h3>
          <div className="row" style={{ marginBottom: 12 }}>
            <label className="muted">网盘</label>
            <select className="input" style={{ width: 100 }} value={abuseForm.pan} onChange={(e) => setF('pan', e.target.value)}>
              <option value="quark">quark</option>
              <option value="uc">uc</option>
              <option value="">全部</option>
            </select>
            <label className="muted">回看</label>
            <select className="input" style={{ width: 86 }} value={abuseForm.days} onChange={(e) => setF('days', Number(e.target.value))}>
              {[1, 3, 7, 14, 30].map((d) => <option key={d} value={d}>{d} 天</option>)}
            </select>
            <label className="muted">分组</label>
            <select className="input" style={{ width: 100 }} value={abuseForm.by} onChange={(e) => setF('by', e.target.value)}>
              <option value="fid">按 fid</option>
              <option value="md5">按 md5</option>
            </select>
            <label className="muted">最少次数</label>
            <input className="input" style={{ width: 70 }} type="number" min="1" max="999" value={abuseForm.min} onChange={(e) => setF('min', Number(e.target.value))} />
            <button className="btn btn-sm btn-primary" onClick={runAbuse}>查询</button>
          </div>
          <table className="tbl">
            <thead>
              <tr><th>key（{abuseForm.by}）</th><th>file_name</th><th>次数</th><th>最近时间</th><th>涉及账号</th></tr>
            </thead>
            <tbody>
              {abuseRows.map((r, i) => {
                const acct = r.accounts ?? r.account_ids ?? r.account_id;
                const acctStr = Array.isArray(acct) ? (acct.length ? acct.join(', ') : '-') : (acct ?? '-');
                return (
                  <tr key={i}>
                    <td className="mono">{r.key ?? r.fid ?? r.md5 ?? '-'}</td>
                    <td>{r.file_name ?? '-'}</td>
                    <td><b>{r.c ?? r.count ?? 0}</b></td>
                    <td className="mono">{fmtTime(r.max_ts ?? r.recent_ts ?? r.ts ?? r.last_ts)}</td>
                    <td className="mono">{acctStr}</td>
                  </tr>
                );
              })}
              {abuseRows.length === 0 && (
                <tr><td colSpan={5} className="muted">暂无结果（未检测到超过最少次数的重复文件）</td></tr>
              )}
            </tbody>
          </table>
          <p className="muted" style={{ marginBottom: 0 }}>命中同一文件/分享被高频解析 → 结合账号审计判断滥用；扫描（scan）不落 file_hits，不受影响。</p>
        </div>
      )}
    </div>
  );
}
