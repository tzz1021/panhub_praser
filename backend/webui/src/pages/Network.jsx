/** 网络配置：单 listener 端口、令牌轮换、wrangler 健康检查（v1.2.2）
 *  - 校验策略（白名单/限频）归 functions/api/proxy.js，本页不再有"对外暴露"开关
 *  - wrangler 健康 = /api/web/info 的 wrangler 字段（只读，轮询刷新，不做真 ws 客户端）
 */
import { useEffect, useState } from 'preact/hooks';
import { api, getInfo } from '../api.js';

/** inspector ws 状态标签 */
function WsTag({ state }) {
  const cls = state === 'connected' ? '' : state === 'connecting' ? 'yellow' : 'red';
  return <span className={`tag ${cls}`}>{state ?? '-'}</span>;
}

export default function Network({ toast }) {
  const [net, setNet] = useState(null);
  const [info, setInfo] = useState(null);

  const load = async () => {
    const [n, i] = await Promise.all([api('/api/web/network'), getInfo()]);
    if (n.ok) setNet(n.data);
    if (i.ok) setInfo(i.data);
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 4000); // 健康轮询（wrangler 状态/lastLine 实时）
    return () => clearInterval(t);
  }, []);

  if (!net || !info) return <p className="muted">加载中…</p>;

  const w = info.wrangler ?? {};
  const inspectorPort = w.inspectorPort;

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

  const openDevtools = () => {
    if (!inspectorPort) {
      toast('wrangler inspector 端口未知，无法打开 devtools', 'err');
      return;
    }
    // 文案一字不差（设计稿 §7）
    const ok = window.confirm('由于 ws 限制，现在即将开启 wrangler 自带的 devtools。如果 wrangler 不在本机运行（比如 ssh 穿透 webui），这里不能转发 devtools，请去系统终端完成穿透。');
    if (ok) window.open(`http://127.0.0.1:${inspectorPort}`);
  };

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>网络配置</h2>
      <div className="card">
        <h3>监听</h3>
        <table className="tbl">
          <tbody>
            <tr>
              <td style={{ width: 160 }}>Proxy / WebUI 端口</td>
              <td className="mono">{net.proxy.host}:{net.proxy.port}</td>
              <td className="muted">单 listener：/api/proxy + /api/web/* 同一端口；SPA 填 proxy_address（企业部署 = 服务器内网地址，见 README；本地联调 = 本机地址，不能用 127.0.0.1 跨机访问）</td>
            </tr>
            <tr>
              <td>wrangler 转发</td>
              <td className="mono">{net.wrangler?.bind ?? '0.0.0.0'}:{net.wrangler?.port ?? '-'}</td>
              <td className="muted">wrangler pages dev（proxy.js 是校验策略唯一实现；PANHUB_BIND 控制绑定，默认 0.0.0.0 企业内网可达）</td>
            </tr>
            <tr>
              <td>inspector</td>
              <td className="mono">{net.wrangler?.inspectorPort ?? '-'}</td>
              <td className="muted">devtools ws 端口（仅健康检查，不消费 CDP）</td>
            </tr>
            <tr>
              <td>autoSpawn</td>
              <td><span className={`tag ${net.wrangler?.autoSpawn ? '' : 'gray'}`}>{net.wrangler?.autoSpawn ? '开（未监听时自动拉起）' : '关（外部启动）'}</span></td>
              <td className="muted">改 data/period/config.json 后重启服务生效</td>
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
        <p className="muted" style={{ marginBottom: 0 }}>随机端口（20000–60000）避免被恶意网页猜到；wrangler 未启动时 proxy 令牌轮换需 restart 才生效。</p>
      </div>
      <div className="card">
        <h3>wrangler 健康检查</h3>
        <table className="tbl">
          <tbody>
            <tr>
              <td style={{ width: 160 }}>运行模式</td>
              <td className="mono">{w.mode ?? '-'}{w.running ? '（本进程 spawn，存活）' : ''}</td>
            </tr>
            <tr>
              <td>inspector 端口</td>
              <td className="mono">{inspectorPort ?? '-'}</td>
            </tr>
            <tr>
              <td>inspector ws</td>
              <td><WsTag state={w.inspectorWs} /></td>
            </tr>
            <tr>
              <td>最近 stdout</td>
              <td className="mono" style={{ wordBreak: 'break-all' }}>{w.lastLine || <span className="muted">（暂无输出）</span>}</td>
            </tr>
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn btn-sm" onClick={openDevtools} disabled={!inspectorPort}>打开 wrangler devtools</button>
          <span className="muted">非服务器查看必然是 off，无需在意</span>
        </div>
      </div>
    </div>
  );
}
