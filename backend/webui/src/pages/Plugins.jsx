/** 插件管理：内置插件列表（split/monitor/cdp；v2 开发中展示状态） */
import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.js';

export default function Plugins({ toast }) {
  const [plugins, setPlugins] = useState(null);

  useEffect(() => {
    (async () => {
      const r = await api('/api/web/plugins');
      if (r.ok) setPlugins(r.data.plugins);
    })();
  }, []);

  if (!plugins) return <p className="muted">加载中…</p>;

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>插件管理</h2>
      <p className="muted" style={{ marginTop: -6 }}>内置插件也是普通插件（走同一加载器）；自定义插件目录 backend/plugins/（v2 开放）。</p>
      {plugins.map((p) => (
        <div className="card" key={p.name}>
          <div className="row">
            <h3 style={{ margin: 0 }}>{p.title}</h3>
            <span className="tag">{p.name}</span>
            <span className={`tag ${p.enabled ? '' : 'gray'}`}>{p.enabled ? '开启' : '关闭'}</span>
            <span className="tag yellow">{p.status}</span>
          </div>
          <p className="dim" style={{ margin: '8px 0 0' }}>{p.desc}</p>
          <p className="muted" style={{ margin: '6px 0 0' }}>
            {p.name === 'cdp' ? 'CDP 配置在「系统配置」页；自动取 cookie 需要浏览器先手动授权。' : 'v2 与排队/终端一起开放开关与配置。'}
          </p>
        </div>
      ))}
    </div>
  );
}
