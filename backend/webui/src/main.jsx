/**
 * 管理面板入口（左栏导航，参考 napcatqq；docs/selfhost-node.md §6）
 * 页面：基础信息 / 网络配置 / 实时日志 / 数据看板 / 插件管理 / 系统终端 / 系统配置
 */
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import './style.css';
import { getToken, setToken, fetchSession, api } from './api.js';
import Dashboard from './pages/Dashboard.jsx';
import Network from './pages/Network.jsx';
import Logs from './pages/Logs.jsx';
import Stats from './pages/Stats.jsx';
import Plugins from './pages/Plugins.jsx';
import Terminal from './pages/Terminal.jsx';
import Settings from './pages/Settings.jsx';

const NAV = [
  { id: 'dashboard', label: '基础信息', icon: '🏠' },
  { id: 'network', label: '网络配置', icon: '🌐' },
  { id: 'logs', label: '实时日志', icon: '📋' },
  { id: 'stats', label: '数据看板', icon: '📊' },
  { id: 'plugins', label: '插件管理', icon: '🧩' },
  { id: 'terminal', label: '系统终端', icon: '💻' },
  { id: 'settings', label: '系统配置', icon: '⚙️' },
];

function ToastHub({ toasts }) {
  return (
    <div className="toast-wrap">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>
      ))}
    </div>
  );
}

function Login({ onOk }) {
  const [token, setT] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!token.trim()) return;
    setBusy(true);
    setErr('');
    setToken(token.trim());
    const r = await fetchSession();
    if (r.ok) {
      onOk();
    } else {
      setErr(r.status === 401 ? '令牌无效，请检查控制台横幅或 data/period/config.json' : `请求失败（${r.status}）`);
      setToken('');
    }
    setBusy(false);
  };
  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>panhub 管理面板</h1>
        <div className="sub">自托管转发代理 · 仅本机可访问（127.0.0.1）</div>
        <input
          className="input mono"
          type="password"
          placeholder="WebUI 令牌（首启打印在启动横幅）"
          value={token}
          onChange={(e) => setT(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          autoFocus
        />
        {err && <p style={{ color: 'var(--danger)', fontSize: 12.5, margin: '10px 0 0' }}>{err}</p>}
        <div style={{ marginTop: 16 }}>
          <button className="btn btn-primary" style={{ width: '100%' }} onClick={submit} disabled={busy}>
            {busy ? '验证中…' : '进入面板'}
          </button>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [page, setPage] = useState('dashboard');
  const [toasts, setToasts] = useState([]);

  const toast = (msg, kind = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, msg, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3600);
  };

  useEffect(() => {
    // 已有令牌 → 尝试直接进（失效则回登录）
    (async () => {
      if (getToken()) {
        const r = await fetchSession();
        if (r.ok) setAuthed(true);
      }
      setChecking(false);
    })();
  }, []);

  // 401 全局处理：回登录
  useEffect(() => {
    const onUnauth = () => {
      setAuthed(false);
      setToken('');
    };
    window.addEventListener('panhub-unauth', onUnauth);
    return () => window.removeEventListener('panhub-unauth', onUnauth);
  }, []);

  if (checking) return <div style={{ padding: 40, color: 'var(--text-faint)' }}>加载中…</div>;

  if (!authed) return <Login onOk={() => setAuthed(true)} />;

  const Page = { dashboard: Dashboard, network: Network, logs: Logs, stats: Stats, plugins: Plugins, terminal: Terminal, settings: Settings }[page];

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand"><span className="dot">☁️</span> panhub</div>
        <nav>
          {NAV.map((n) => (
            <a key={n.id} href={`#/${n.id}`} className={page === n.id ? 'active' : ''} onClick={(e) => { e.preventDefault(); setPage(n.id); }}>
              <span>{n.icon}</span> {n.label}
            </a>
          ))}
        </nav>
        <div className="side-foot">
          backend v0.1.0<br />WebUI 仅本机 · 随机端口
        </div>
      </aside>
      <main className="content">
        <Page toast={toast} />
      </main>
      <ToastHub toasts={toasts} />
    </div>
  );
}

render(<App />, document.getElementById('app'));
