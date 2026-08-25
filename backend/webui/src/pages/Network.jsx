/** 网络配置：proxy/webui 端口、对外暴露开关、令牌轮换（高危需二次确认） */
import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.js';

export default function Network({ toast }) {
  const [net, setNet] = useState(null);
  const [confirm, setConfirm] = useState('');

  const load = async () => {
    const r = await api('/api/web/network');
    if (r.ok) setNet(r.data);
  };
  useEffect(() => { load(); }, []);

  if (!net) return <p className="muted">加载中…</p>;

  const toggleExpose = async () => {
    if (!net.proxy.expose) {
      // 开启对外暴露 → 二次确认（输入令牌）
      if (!confirm.trim()) {
        toast('开启对外暴露需二次确认：先输入 WebUI 令牌', 'err');
        return;
      }
    }
    const r = await api('/api/web/network/expose', { method: 'POST', body: { expose: !net.proxy.expose }, confirmToken: confirm.trim() });
    if (r.ok) {
      toast(`代理已${net.proxy.expose ? '收紧为仅本机' : '对外暴露（0.0.0.0）'}`, 'ok');
      setConfirm('');
      load();
    } else {
      toast(r.data?.message ?? '操作失败', 'err');
    }
  };

  const rotate = async (which) => {
    if (!window.confirm(`确认轮换 ${which === 'proxy' ? 'Proxy（SPA 填写）' : 'WebUI（面板登录）'} 令牌？旧令牌立即失效。`)) return;
    const r = await api('/api/web/network/rotate', { method: 'POST', body: { which } });
    if (r.ok) {
      toast(`${which === 'proxy' ? 'Proxy' : 'WebUI'} 新令牌已生成：${r.data.token}（仅本次展示，请立即保存）`, 'ok');
      load();
    } else {
      toast(r.data?.message ?? '轮换失败', 'err');
    }
  };

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>网络配置</h2>
      <div className="card">
        <h3>监听</h3>
        <table className="tbl">
          <tbody>
            <tr>
              <td style={{ width: 160 }}>Proxy 转发端口</td>
              <td className="mono">{net.proxy.host}:{net.proxy.port}</td>
              <td className="muted">SPA 设置里填 http://{net.proxy.host}:{net.proxy.port}</td>
            </tr>
            <tr>
              <td>WebUI 端口</td>
              <td className="mono">{net.webui.host}:{net.webui.port}</td>
              <td className="muted">硬绑本机（只读展示；改端口需编辑 config.json）</td>
            </tr>
            <tr>
              <td>对外暴露</td>
              <td>
                {net.proxy.expose ? <span className="tag red">已暴露 0.0.0.0（公网可达）</span> : <span className="tag gray">仅本机</span>}
              </td>
              <td>
                <div className="row">
                  {!net.proxy.expose && (
                    <input className="input mono" style={{ width: 260 }} type="password" placeholder="开启需输入 WebUI 令牌确认" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                  )}
                  <button className="btn btn-sm" onClick={toggleExpose}>{net.proxy.expose ? '收紧为仅本机' : '对外暴露（二次确认）'}</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="card">
        <h3>令牌</h3>
        <table className="tbl">
          <tbody>
            <tr>
              <td style={{ width: 160 }}>Proxy 令牌</td>
              <td className="mono">****{net.proxy.tokenTail}</td>
              <td><button className="btn btn-sm" onClick={() => rotate('proxy')}>轮换</button></td>
            </tr>
            <tr>
              <td>WebUI 令牌</td>
              <td className="mono">****{net.webui.tokenTail}</td>
              <td><button className="btn btn-sm" onClick={() => rotate('webui')}>轮换</button></td>
            </tr>
          </tbody>
        </table>
        <p className="muted" style={{ marginBottom: 0 }}>端口修改需编辑 data/period/config.json 后重启服务；随机端口（20000–60000）避免被恶意网页猜到。</p>
      </div>
    </div>
  );
}
