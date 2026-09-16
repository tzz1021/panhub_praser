/**
 * 凭据刷新预设（v1.3.1 P4）
 *
 * Tzz 定稿：**自动执行全部改手动预设** —— 就那几个常用操作，由人在这里点；
 * 不做定时自动刷新、不做宏录制。每个预设自带限频（默认 5 分钟一次），同时只允许跑一个。
 *
 * 隐私：面板只看得到「是否在跑 / 上次结果 / 账号身份（userId）」——
 * **凭据本体与任何指纹都不回面板**（读取 → 加密落账号池 → 立即丢弃）。
 * 触发前要二次输入 WebUI 令牌（写入账号池属高危操作）。
 */
import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.js';

function fmtTs(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function Plugins({ toast }) {
  const [data, setData] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = async () => {
    const r = await api('/api/web/plugins');
    if (r.ok) setData(r.data);
  };
  useEffect(() => {
    load();
  }, []);

  const run = async (preset) => {
    const confirmToken = window.prompt(`运行「${preset.title}」会写账号池：请输入 WebUI 令牌确认`);
    if (!confirmToken) return;
    setBusyId(preset.id);
    const r = await api(`/api/web/plugins/${encodeURIComponent(preset.id)}/run`, {
      method: 'POST',
      body: {},
      confirmToken: confirmToken.trim(),
    });
    setBusyId(null);
    toast(r.data?.message ?? (r.ok ? '已刷新' : '运行失败'), r.ok ? 'ok' : 'err');
    load();
  };

  if (!data) return <p className="muted">加载中…</p>;
  const browserOk = Boolean(data.browser?.ok);

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>凭据刷新（手动预设）</h2>
      <p className="muted" style={{ marginTop: -6 }}>
        真实浏览器（CDP port 9222）：打开上游页面 → 等页面下发新凭据 → 写回账号池。
        全部手动触发、按预设限频，不做自动执行。
      </p>

      <div className="card">
        <div className="row">
          <h3 style={{ margin: 0 }}>浏览器 health</h3>
          <span className={`tag ${browserOk ? '' : 'red'}`}>{browserOk ? '已连接' : '未连接'}</span>
          <span className="muted mono">127.0.0.1:{data.browser?.port}</span>
          {browserOk ? <span className="muted">{data.browser.browser}</span> : <span className="muted">{data.browser?.reason}</span>}
        </div>
        {!browserOk && (
          <p className="muted" style={{ margin: '8px 0 0' }}>
            无头服务器请先安装/启动带调试端口的 Chromium（<code className="mono">--remote-debugging-port=9222</code>）；
            首次登录可由 SSH 端口转发到本地浏览器完成，之后预设即可复用该登录态。
          </p>
        )}
      </div>

      {data.plugins.map((p) => (
        <div className="card" key={p.id}>
          <div className="row">
            <h3 style={{ margin: 0 }}>{p.title}</h3>
            <span className="tag gray">{p.pan}</span>
            <span className={`tag ${p.state === 'ok' ? '' : p.state === 'error' ? 'red' : 'gray'}`}>{p.state}</span>
            {p.lastIdentity && <span className="muted mono">身份 {p.lastIdentity}</span>}
          </div>
          <p className="dim" style={{ margin: '8px 0 0' }}>{p.desc}</p>
          <p className="muted" style={{ margin: '6px 0 0' }}>
            上次运行：{fmtTs(p.lastRunAt)} · 限频 {Math.round(p.minIntervalMs / 1000)}s
            {p.nextAllowedAt ? ` · 下次可运行 ${fmtTs(p.nextAllowedAt)}` : ''}
          </p>
          {p.lastMessage && <p className="muted" style={{ margin: '4px 0 0' }}>{p.lastMessage}</p>}
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => run(p)}
              disabled={busyId === p.id || p.running || Boolean(p.nextAllowedAt)}
            >
              {busyId === p.id || p.running ? '运行中…' : p.nextAllowedAt ? '限频中' : '手动运行'}
            </button>
            <span className="muted">写入账号池需要二次输入 WebUI 令牌</span>
          </div>
        </div>
      ))}

      <div className="card">
        <h3>插件加载器</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          第三方压缩包插件（package.json  + install.sh）与 webui 配置注入后续开放；
          当前凭据刷新预设走同一份运行/限频/审计基础设施。
        </p>
      </div>
    </div>
  );
}
