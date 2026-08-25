/**
 * 系统配置：账号池（cookie）/ 白名单 / 限频 / 通知 / CDP
 *
 * 账号池字段名与 SPA CookieInputModal 对齐（v1.2 约定，勿改）：
 * - pan：'quark' | 'uc'（= src/adapters/registry.ts 的 adapter id）
 * - quark：整串 cookie（关键 key __pus / __uid / __puus，与 quark/cookies.ts 一致）
 * - uc：__pugs（下载层游客态凭据，208 字符）
 * 高危操作（账号池增删改 / 白名单增删）→ 二次输入 WebUI 令牌确认（秘钥语义）。
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { api, fmtTime } from '../api.js';

const PAN_KEYS = { quark: ['__pus', '__uid', '__puus'], uc: ['__pugs'] };

/** 与 SPA quark/cookies.ts 同构：整串里已有关键 key */
function keysPresent(cookieString, pan) {
  const stripped = String(cookieString ?? '').replace(/^cookie\s*:\s*/i, '');
  const keys = PAN_KEYS[pan] ?? [];
  return keys.filter((k) => {
    for (const pair of stripped.split(';')) {
      const eq = pair.indexOf('=');
      if (eq > 0 && pair.slice(0, eq).trim() === k && pair.slice(eq + 1).trim()) return true;
    }
    return false;
  });
}

function AccountForm({ initial, panKeys, onDone, toast }) {
  const [pan, setPan] = useState(initial?.pan ?? 'quark');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [cookieString, setCookieString] = useState(initial?.cookieString ?? '');
  const [expiresAt, setExpiresAt] = useState(initial?.expiresAt ? new Date(initial.expiresAt).toISOString().slice(0, 16) : '');
  const [confirmToken, setConfirmToken] = useState('');
  const [busy, setBusy] = useState(false);
  const found = useMemo(() => keysPresent(cookieString, pan), [cookieString, pan]);

  const save = async () => {
    if (!confirmToken.trim()) {
      toast('账号池修改属高危操作：请二次输入 WebUI 令牌确认', 'err');
      return;
    }
    setBusy(true);
    const r = await api('/api/web/accounts', {
      method: 'POST',
      body: {
        id: initial?.id,
        pan,
        label,
        cookieString,
        expiresAt: expiresAt ? new Date(expiresAt).getTime() : null,
      },
      confirmToken: confirmToken.trim(),
    });
    setBusy(false);
    if (r.ok) {
      toast(initial ? '账号已更新' : '账号已添加', 'ok');
      onDone(true);
    } else {
      toast(r.data?.message ?? '保存失败', 'err');
    }
  };

  return (
    <div className="card" style={{ borderColor: 'var(--primary)' }}>
      <h3>{initial ? `编辑账号 #${initial.id}` : '添加账号'}</h3>
      <div className="row" style={{ marginBottom: 8 }}>
        <select className="input" style={{ width: 130 }} value={pan} onChange={(e) => { setPan(e.target.value); setCookieString(''); }}>
          <option value="quark">quark（夸克）</option>
          <option value="uc">uc（UC）</option>
        </select>
        <input className="input grow" placeholder="备注名（如 家庭-1号）" value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <textarea
        className="input"
        rows={3}
        placeholder={pan === 'quark' ? '粘贴完整 cookie 整串（含 __pus=…; __uid=…; __puus=…；或从已登录浏览器复制，支持 Netscape/JSON/Header 导入）' : '粘贴 __pugs 值（下载层游客态凭据，208 字符）'}
        value={cookieString}
        onChange={(e) => setCookieString(e.target.value)}
      />
      <p style={{ margin: '6px 0 0', fontSize: 12 }}>
        {found.length > 0 ? (
          <span className="tag">已检测到：{found.join(' / ')}</span>
        ) : (
          <span className="muted">未检测到 {PAN_KEYS[pan].join(' / ')} —— 保存会被拒绝</span>
        )}
      </p>
      <div className="row" style={{ marginTop: 10 }}>
        <input className="input mono" style={{ width: 210 }} type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
        <span className="muted">过期时间（可空）</span>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <input className="input mono grow" type="password" placeholder="二次确认：输入 WebUI 令牌" value={confirmToken} onChange={(e) => setConfirmToken(e.target.value)} />
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? '保存中…' : '保存'}</button>
        <button className="btn" onClick={() => onDone(false)}>取消</button>
      </div>
    </div>
  );
}

export default function Settings({ toast }) {
  const [tab, setTab] = useState('accounts');
  const [accounts, setAccounts] = useState(null);
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null); // null | { id?, ... } | 'new'

  const loadAccounts = async () => {
    const r = await api('/api/web/accounts');
    if (r.ok) setAccounts(r.data);
  };
  const loadSettings = async () => {
    const r = await api('/api/web/settings');
    if (r.ok) setSettings(r.data);
  };
  useEffect(() => { loadAccounts(); loadSettings(); }, []);

  const removeAccount = async (a) => {
    if (!window.confirm(`删除账号 ${a.pan}/${a.label || a.id}？`)) return;
    const r = await api(`/api/web/accounts/${a.id}`, { method: 'DELETE', body: {} });
    if (r.ok) { toast('账号已删除', 'ok'); loadAccounts(); }
  };

  /* ---------- 白名单编辑（高危 → 二次令牌） ---------- */
  const [whitelistDraft, setWhitelistDraft] = useState('');
  const [whitelistConfirm, setWhitelistConfirm] = useState('');
  const saveWhitelist = async () => {
    if (!whitelistConfirm.trim()) { toast('白名单增删属高危操作：请二次输入 WebUI 令牌', 'err'); return; }
    const list = whitelistDraft.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean);
    const r = await api('/api/web/settings', { method: 'POST', body: { whitelist: list }, confirmToken: whitelistConfirm.trim() });
    if (r.ok) { toast('白名单已更新', 'ok'); setWhitelistConfirm(''); loadSettings(); }
    else toast(r.data?.message ?? '更新失败', 'err');
  };

  /* ---------- 限频/通知/CDP ---------- */
  const [rateDraft, setRateDraft] = useState(null);
  const [notifyDraft, setNotifyDraft] = useState(null);
  const [cdpDraft, setCdpDraft] = useState(null);
  const saveMisc = async (patch) => {
    const r = await api('/api/web/settings', { method: 'POST', body: patch });
    if (r.ok) { toast('已保存', 'ok'); loadSettings(); }
    else toast(r.data?.message ?? '保存失败', 'err');
  };

  if (!accounts || !settings) return <p className="muted">加载中…</p>;

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>系统配置</h2>
      <div className="row" style={{ marginBottom: 12 }}>
        {[['accounts', '账号池'], ['whitelist', '白名单'], ['misc', '限频 / 通知 / CDP']].map(([id, label]) => (
          <button key={id} className={`btn btn-sm ${tab === id ? 'btn-primary' : ''}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === 'accounts' && (
        <div>
          <div className="card">
            <div className="row">
              <h3 style={{ margin: 0 }}>账号 cookie 池</h3>
              <span className="muted">字段与 SPA 弹窗对齐：quark 整串（__pus/__uid/__puus）· uc __pugs</span>
              <button className="btn btn-sm btn-primary" onClick={() => setForm('new')}>+ 添加账号</button>
            </div>
            {form && (
              <div style={{ marginTop: 12 }}>
                <AccountForm
                  initial={form === 'new' ? null : form}
                  panKeys={PAN_KEYS}
                  onDone={(changed) => { setForm(null); if (changed) loadAccounts(); }}
                  toast={toast}
                />
              </div>
            )}
            <table className="tbl" style={{ marginTop: 12 }}>
              <thead>
                <tr><th>ID</th><th>网盘</th><th>备注</th><th>状态</th><th>关键 key</th><th>cookie</th><th>过期</th><th>最近使用</th><th>操作</th></tr>
              </thead>
              <tbody>
                {accounts.accounts.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">#{a.id}</td>
                    <td><span className="tag gray">{a.pan}</span></td>
                    <td>{a.label || <span className="muted">-</span>}</td>
                    <td><span className={`tag ${a.status === 'ok' ? '' : 'red'}`}>{a.status}</span></td>
                    <td className="mono">{a.keys.join(' / ') || '-'}</td>
                    <td className="mono">{a.cookieLength} 字符 …{a.cookieTail}</td>
                    <td className="mono">{a.expiresAt ? fmtTime(a.expiresAt) : <span className="muted">-</span>}</td>
                    <td className="mono">{a.lastUsedAt ? fmtTime(a.lastUsedAt) : <span className="muted">-</span>}</td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        <button className="btn btn-sm" onClick={async () => {
                          const r = await api(`/api/web/accounts/${a.id}`);
                          if (r.ok) setForm(r.data.account ?? { id: a.id, pan: a.pan, label: a.label, expiresAt: a.expiresAt, cookieString: '' });
                        }}>编辑</button>
                        <button className="btn btn-sm btn-danger" onClick={() => removeAccount(a)}>删</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {accounts.accounts.length === 0 && (
                  <tr><td colSpan={9} className="muted">暂无账号 —— 添加后代理会按网盘自动注入登录态 cookie（夸克大文件 23018 解锁）</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="card">
            <h3>各网盘账号数</h3>
            {accounts.counts.length === 0 && <p className="muted" style={{ margin: 0 }}>暂无</p>}
            <div className="row">
              {accounts.counts.map((c) => <span key={c.pan} className="tag">{c.pan} × {c.n}</span>)}
            </div>
          </div>
        </div>
      )}

      {tab === 'whitelist' && (
        <div className="card">
          <h3>域名白名单（高危：增删直接扩大 SSRF 面）</h3>
          <p className="muted">默认继承 CF 版：uc.cn / quark.cn。一行一个或逗号/空格分隔，保存需二次令牌确认。</p>
          <textarea
            className="input"
            rows={4}
            defaultValue={settings.whitelist.join('\n')}
            onChange={(e) => setWhitelistDraft(e.target.value)}
            placeholder="uc.cn&#10;quark.cn"
          />
          <div className="row" style={{ marginTop: 10 }}>
            <input className="input mono grow" type="password" placeholder="二次确认：输入 WebUI 令牌" value={whitelistConfirm} onChange={(e) => setWhitelistConfirm(e.target.value)} />
            <button className="btn btn-primary" onClick={saveWhitelist}>保存白名单</button>
          </div>
        </div>
      )}

      {tab === 'misc' && (
        <div>
          <div className="card">
            <h3>限频（按 IP）</h3>
            <div className="row">
              <input
                className="input"
                style={{ width: 140 }}
                type="number"
                min="0"
                max="600"
                value={rateDraft ?? settings.rateLimitPerMin}
                onChange={(e) => setRateDraft(Number(e.target.value))}
              />
              <span className="muted">次/分钟 · 0 = 关闭（默认关，防家庭组误伤；公网暴露建议开）</span>
              <button className="btn btn-sm btn-primary" onClick={() => saveMisc({ rateLimitPerMin: rateDraft ?? 0 })}>保存</button>
            </div>
          </div>
          <div className="card">
            <h3>通知渠道（monitor 插件用，v2）</h3>
            <p className="muted" style={{ marginTop: 0 }}>
              webhook / ntfy / Server酱 / pushplus / 自定义 URL + 浏览器系统通知（Notification API）。v2 与 monitor 插件一起开放。
            </p>
            <label className="row" style={{ fontSize: 13 }}>
              <input type="checkbox" checked={Boolean(settings.notify.enabled)} onChange={(e) => saveMisc({ notify: { ...settings.notify, enabled: e.target.checked } })} />
              启用通知（当前状态：{settings.notify.enabled ? '开' : '关'}）
            </label>
          </div>
          <div className="card">
            <h3>CDP 自动取 cookie（可选插件，默认关）</h3>
            <div className="row">
              <input
                className="input mono grow"
                placeholder="浏览器 remote_debugging 地址，如 http://127.0.0.1:9222"
                defaultValue={settings.cdp.wsUrl}
                onChange={(e) => setCdpDraft((prev) => ({ ...(prev ?? settings.cdp), wsUrl: e.target.value }))}
              />
              <label className="row" style={{ fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={Boolean(settings.cdp.enabled)}
                  onChange={(e) => {
                    const next = { ...(cdpDraft ?? settings.cdp), enabled: e.target.checked };
                    setCdpDraft(next);
                    saveMisc({ cdp: next });
                  }}
                />
                开启 CDP
              </label>
              <button className="btn btn-sm" onClick={() => saveMisc({ cdp: { ...(cdpDraft ?? settings.cdp), wsUrl: cdpDraft?.wsUrl ?? settings.cdp.wsUrl } })}>保存地址</button>
            </div>
            <p className="muted" style={{ marginBottom: 0 }}>需浏览器先手动授权（不是魔法）；v2 实现在 monitor 插件里。</p>
          </div>
        </div>
      )}
    </div>
  );
}
