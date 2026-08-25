/**
 * WebUI API 客户端（对接 backend/src/server.js 的 /api/web/*）
 *
 * 鉴权流程：
 *  1. localStorage 存 WebUI 令牌（'panhub-webui-token'）
 *  2. 所有请求带 X-WebUI-Token 头；401 → 通知上层弹登录
 *  3. 写操作带 X-CSRF-Token（登录成功后从 /api/web/auth/session 取）
 * 高危操作（白名单/账号池等）二次确认令牌由页面调用方传 confirmToken。
 */
const TOKEN_KEY = 'panhub-webui-token';

export function getToken() {
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}
export function setToken(t) {
  try {
    if (t) window.localStorage.setItem(TOKEN_KEY, t);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

let csrf = '';
/** 拉会话 → 拿 CSRF（令牌未配置/失效会返回 401，由调用方处理） */
export async function fetchSession() {
  const r = await fetch('/api/web/auth/session', {
    headers: { 'x-webui-token': getToken() },
  });
  if (r.ok) {
    const data = await r.json();
    csrf = data.csrf ?? '';
  }
  return r;
}

/**
 * 通用请求。
 * @param path    /api/web/xxx
 * @param opts    { method, body, confirmToken }（confirmToken = 秘钥二次确认）
 * @returns { ok, status, data }
 */
export async function api(path, opts = {}) {
  const headers = { 'x-webui-token': getToken() };
  const isWrite = opts.method === 'POST' || opts.method === 'PUT' || opts.method === 'DELETE';
  if (isWrite && csrf) headers['x-csrf-token'] = csrf;
  let body;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    if (opts.confirmToken) {
      body = JSON.stringify({ ...opts.body, confirmToken: opts.confirmToken });
    } else {
      body = JSON.stringify(opts.body);
    }
  }
  let r;
  try {
    r = await fetch(path, { method: opts.method ?? 'GET', headers, body });
  } catch {
    return { ok: false, status: 0, data: { error: 'NETWORK', message: '无法连接 backend（请确认服务已启动）' } };
  }
  let data = {};
  try {
    data = await r.json();
  } catch {
    /* 空 body */
  }
  if (r.status === 401) {
    return { ok: false, status: 401, data: { error: 'UNAUTHORIZED', message: '令牌无效或未登录' } };
  }
  return { ok: r.ok, status: r.status, data };
}

/** 短时间格式化 */
export function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
export function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}天${h}小时` : h > 0 ? `${h}小时${m}分` : `${m}分${s % 60}秒`;
}
