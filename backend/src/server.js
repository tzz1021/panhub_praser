/**
 * 双 listener HTTP 服务（docs/selfhost-node.md §3/§4.1）
 *
 * listener A = proxy：POST /api/proxy（可绑 0.0.0.0 对外）
 * listener B = webui：/api/web/* + 静态（webui/dist）+ ws（后续），**硬绑 127.0.0.1**
 *
 * webui 安全四件套：Host 校验 + Origin 校验 + CSRF + 随机端口（auth.js）
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, saveConfig, randomToken, uptimeMs } from './config.js';
import { initDb, getDb, audit, listAudit, getSetting, setSetting } from './db.js';
import { log, listLogs, getQueueState, clearRing } from './log.js';
import { hostAllowed, originAllowed, verifyWebuiToken, createCsrf, verifyCsrf, verifyProxyToken } from './auth.js';
import { handleProxy } from './proxy.js';
import {
  listAccounts, getAccount, upsertAccount, deleteAccount, countByPan,
} from './cookies.js';

const WEBUI_DIST = join(fileURLToPath(new URL('..', import.meta.url)), 'webui', 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** 读请求体（限 1MB，防撑爆内存） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error('body 过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders });
  res.end(body);
}

/* ================= webui API 路由 ================= */

/** webui 鉴权中间件：Host/Origin/令牌/CSRF（GET 免 CSRF） */
function webAuth(req, url, body) {
  if (!hostAllowed(req.headers.host)) return { ok: false, status: 403, body: { error: 'HOST_NOT_ALLOWED', message: 'Host 头不在白名单（仅 127.0.0.1/localhost）' } };
  if (!originAllowed(req.headers.origin, req.headers.host)) return { ok: false, status: 403, body: { error: 'ORIGIN_NOT_ALLOWED', message: 'Origin 不在白名单（仅同源）' } };
  const token = req.headers['x-webui-token'];
  if (!verifyWebuiToken(token)) return { ok: false, status: 401, body: { error: 'UNAUTHORIZED', message: 'WebUI 令牌无效或未登录' } };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const csrf = req.headers['x-csrf-token'] ?? body?.csrf;
    if (!verifyCsrf(csrf)) return { ok: false, status: 403, body: { error: 'CSRF_INVALID', message: 'CSRF 校验失败，请刷新页面重试' } };
  }
  return { ok: true };
}

/** 轮换 WebUI 令牌（旧令牌立即失效；新令牌打印到控制台） */
function rotateWebuiToken() {
  const t = randomToken();
  getConfig().webui.token = t;
  saveConfig();
  audit('token.rotate', 'webui token 已轮换', 'webui');
  console.log('');
  console.log('══════════════════════════════════════════');
  console.log(`  ⚠️  WebUI 令牌已轮换（旧令牌立即失效）`);
  console.log(`  新令牌: ${t}`);
  console.log('══════════════════════════════════════════');
  console.log('');
  return t;
}

/** 轮换 proxy 令牌（SPA 填的 X-Proxy-Token） */
function rotateProxyToken() {
  const t = randomToken();
  getConfig().proxy.token = t;
  saveConfig();
  audit('token.rotate', 'proxy token 已轮换', 'webui');
  log('warn', `proxy：X-Proxy-Token 已轮换（SPA 设置里需同步更新）`);
  return t;
}

async function handleWebApi(req, res, pathname, body) {
  const cfg = getConfig();
  const auth = webAuth(req, { pathname }, body);
  if (!auth.ok) return json(res, auth.status, auth.body);
  const send = (status, data) => json(res, status, data);

  // ---- 会话/鉴权 ----
  if (pathname === '/api/web/auth/session') {
    const csrf = createCsrf();
    return send(200, { ok: true, csrf, webuiPort: cfg.webui.port });
  }

  // ---- 基础信息 ----
  if (pathname === '/api/web/info') {
    return send(200, {
      hostname: (await import('node:os')).hostname(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      pid: process.pid,
      uptimeMs: uptimeMs(),
      version: '0.1.0',
      bootAt: Date.now() - uptimeMs(),
      dbPath: (await import('node:path')).join(process.cwd(), 'data', 'period', 'panhub.db'),
    });
  }

  // ---- 网络配置 ----
  if (pathname === '/api/web/network') {
    return send(200, {
      proxy: { ...cfg.proxy, token: undefined, tokenTail: cfg.proxy.token?.slice(-6) },
      webui: { ...cfg.webui, token: undefined, tokenTail: cfg.webui.token?.slice(-6) },
      whitelist: cfg.whitelist,
      rateLimitPerMin: cfg.proxy.rateLimitPerMin,
    });
  }
  if (pathname === '/api/web/network/expose' && req.method === 'POST') {
    const expose = Boolean(body?.expose);
    cfg.proxy.expose = expose;
    cfg.proxy.host = expose ? '0.0.0.0' : '127.0.0.1';
    saveConfig();
    audit('network.expose', expose ? '代理对外暴露（0.0.0.0）' : '代理仅本机', 'webui');
    log('warn', `network：代理 ${expose ? '对外暴露 0.0.0.0（公网请确认限频/IP 封禁）' : '收紧为仅本机 127.0.0.1'}`);
    return send(200, { ok: true });
  }
  if (pathname === '/api/web/network/rotate' && req.method === 'POST') {
    const which = body?.which === 'proxy' ? 'proxy' : 'webui';
    const t = which === 'proxy' ? rotateProxyToken() : rotateWebuiToken();
    return send(200, { ok: true, which, token: t, tokenTail: t.slice(-6) });
  }

  // ---- 实时日志 ----
  if (pathname === '/api/web/logs') {
    const q = new URL(req.url, 'http://x').searchParams;
    const logs = listLogs({
      limit: Math.min(Number(q.get('limit') ?? 300), 1000),
      level: q.get('level') ?? undefined,
      pan: q.get('pan') ?? undefined,
      q: q.get('q') ?? undefined,
    });
    return send(200, { logs, queue: getQueueState() });
  }
  if (pathname === '/api/web/logs/clear' && req.method === 'POST') {
    clearRing();
    audit('logs.clear', '环形日志已清空', 'webui');
    return send(200, { ok: true });
  }

  // ---- 数据看板 ----
  if (pathname === '/api/web/stats') {
    const days = Math.min(Number(new URL(req.url, 'http://x').searchParams.get('days') ?? 7), 30);
    const since = Date.now() - days * 86400_000;
    const rows = getDb()
      .prepare('SELECT id, pan, operation, method, url, req_status, duration_ms, account_id, ts FROM proxy_logs WHERE ts >= ? ORDER BY ts DESC LIMIT 2000')
      .all(since);
    // 天 × 网盘 × 操作 聚合
    const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);
    const buckets = new Map(); // `${day}|${pan}|${op}` -> count
    for (const r of rows) {
      const k = `${dayKey(r.ts)}|${r.pan ?? '?'}|${r.operation}`;
      buckets.set(k, (buckets.get(k) ?? 0) + 1);
    }
    const daysArr = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
      const byPan = {};
      for (const [k, n] of buckets) {
        const [day, pan, op] = k.split('|');
        if (day !== d) continue;
        byPan[pan] ??= { scan: 0, prase: 0, other: 0, total: 0 };
        byPan[pan][op] = (byPan[pan][op] ?? 0) + n;
        byPan[pan].total += n;
      }
      daysArr.push({ day: d, byPan });
    }
    return send(200, { days: daysArr, calls: rows.slice(0, 200) });
  }
  if (pathname.startsWith('/api/web/calls/') && pathname.endsWith('/headers')) {
    // 单次调用完整头（脱敏版已在 proxy_logs；完整版在 data/tmp/debug-*.log，这里提示位置）
    const id = pathname.split('/')[4];
    const row = getDb().prepare('SELECT * FROM proxy_logs WHERE id = ?').get(Number(id));
    if (!row) return send(404, { error: 'NOT_FOUND', message: '调用记录不存在' });
    return send(200, {
      ...row,
      req_headers: JSON.parse(row.req_headers ?? '{}'),
      resp_headers: JSON.parse(row.resp_headers ?? '{}'),
      fullNote: '完整请求/响应头（含明文 set-cookie）在服务器 data/tmp/debug-*.log（权限 600）',
    });
  }

  // ---- 账号池 ----
  if (pathname === '/api/web/accounts' && req.method === 'GET') {
    return send(200, { accounts: listAccounts(), counts: countByPan(), panKeys: { quark: ['__pus', '__uid', '__puus'], uc: ['__pugs'] } });
  }
  if (pathname === '/api/web/accounts' && req.method === 'POST') {
    try {
      const id = upsertAccount(body, 'webui');
      audit('account.upsert', `${body?.pan ?? '?'}/${body?.label ?? ''}`, 'webui');
      log('info', `账号池：${body?.pan ?? '?'} 账号已保存（${body?.label ?? ''}）`);
      return send(200, { ok: true, id });
    } catch (err) {
      return send(400, { error: 'BAD_ACCOUNT', message: err.message });
    }
  }
  if (pathname.startsWith('/api/web/accounts/') && req.method === 'GET') {
    const a = getAccount(Number(pathname.split('/')[4]));
    if (!a) return send(404, { error: 'NOT_FOUND' });
    return send(200, { account: { id: a.id, pan: a.pan, label: a.label, expiresAt: a.expires_at, status: a.status, cookieString: a.cookie_enc ? undefined : '' } });
  }
  if (pathname.startsWith('/api/web/accounts/') && req.method === 'DELETE') {
    deleteAccount(Number(pathname.split('/')[4]), 'webui');
    return send(200, { ok: true });
  }

  // ---- 系统配置 ----
  if (pathname === '/api/web/settings' && req.method === 'GET') {
    return send(200, {
      whitelist: cfg.whitelist,
      rateLimitPerMin: cfg.proxy.rateLimitPerMin,
      ipBan: cfg.proxy.ipBan,
      notify: cfg.notify,
      cdp: cfg.cdp,
      advanced: cfg.advanced,
    });
  }
  if (pathname === '/api/web/settings' && req.method === 'POST') {
    const b = body ?? {};
    // 白名单增删 = 高危（直接扩大 SSRF 面）→ 这里要求请求体带 confirmToken（秘钥二次确认）
    if (b.whitelist !== undefined) {
      if (!verifyWebuiToken(b.confirmToken)) return send(403, { error: 'CONFIRM_REQUIRED', message: '修改白名单需二次输入 WebUI 令牌确认' });
      const next = Array.isArray(b.whitelist) ? b.whitelist.map((s) => String(s).trim().toLowerCase()).filter(Boolean).slice(0, 30) : cfg.whitelist;
      cfg.whitelist = next;
      audit('settings.whitelist', `白名单更新：${next.join(', ')}`, 'webui');
      log('warn', `settings：域名白名单更新为 [${next.join(', ')}]`);
    }
    if (b.rateLimitPerMin !== undefined) {
      cfg.proxy.rateLimitPerMin = Math.max(0, Math.min(Number(b.rateLimitPerMin) || 0, 600));
      audit('settings.ratelimit', `限频 ${cfg.proxy.rateLimitPerMin}/min`, 'webui');
    }
    if (b.ipBan !== undefined) cfg.proxy.ipBan = Boolean(b.ipBan);
    if (b.notify !== undefined) {
      cfg.notify = { enabled: Boolean(b.notify.enabled), webhooks: Array.isArray(b.notify.webhooks) ? b.notify.webhooks.slice(0, 10) : [] };
      audit('settings.notify', `通知渠道 ${cfg.notify.webhooks.length} 个`, 'webui');
    }
    if (b.cdp !== undefined) {
      cfg.cdp = { enabled: Boolean(b.cdp.enabled), wsUrl: String(b.cdp.wsUrl ?? '').trim() };
      audit('settings.cdp', `CDP ${cfg.cdp.enabled ? `开启 ${cfg.cdp.wsUrl}` : '关闭'}`, 'webui');
    }
    if (b.advanced !== undefined && typeof b.advanced === 'object') {
      cfg.advanced = { ...cfg.advanced, ...b.advanced };
      audit('settings.advanced', `高级设置更新`, 'webui');
    }
    saveConfig();
    return send(200, { ok: true });
  }

  // ---- 插件 ----
  if (pathname === '/api/web/plugins') {
    return send(200, {
      plugins: [
        { name: 'split', title: '分流开关', desc: '网盘 × 操作 × 登录态 三维调控；公网部署强制游客（防登录 cookie 泄露）', enabled: true, builtin: true, status: 'v2 开发中' },
        { name: 'monitor', title: '过期/风控通知', desc: '账号过期、23018 频繁触发、账号下线 → webhook/浏览器系统通知', enabled: false, builtin: true, status: 'v2 开发中' },
        { name: 'cdp', title: 'CDP 自动取 cookie', desc: '绑定浏览器 remote_debugging，账号过期自动取新 cookie（需手动授权）', enabled: cfg.cdp.enabled, builtin: true, status: cfg.cdp.enabled ? '已配置' : '默认关' },
      ],
    });
  }

  // ---- 审计 ----
  if (pathname === '/api/web/audit') {
    return send(200, { entries: listAudit(200) });
  }

  return send(404, { error: 'NOT_FOUND', message: `未知接口 ${pathname}` });
}

/* ================= 静态文件（webui/dist） ================= */

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  // 防目录穿越
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(WEBUI_DIST, safe);
  if (!filePath.startsWith(WEBUI_DIST)) return false;
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) return false;
  const ext = extname(filePath).toLowerCase();
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(readFileSync(filePath));
  return true;
}

/* ================= 双 listener ================= */

function startProxyListener(cfg) {
  const server = createServer(async (req, res) => {
    const clientIp = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '?';
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type, x-proxy-token',
        'access-control-expose-headers': 'x-pugs, x-quark-pus, x-quark-puus',
        'access-control-max-age': '86400',
      });
      res.end();
      return;
    }
    if (req.method !== 'POST' || new URL(req.url, 'http://x').pathname !== '/api/proxy') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'NOT_FOUND', message: '仅 POST /api/proxy' }));
      return;
    }
    try {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'BAD_BODY', message: '请求体必须是 JSON' }));
        return;
      }
      const proxyToken = req.headers['x-proxy-token'] ?? '';
      const r = await handleProxy(body, clientIp, proxyToken);
      res.writeHead(r.status, { ...r.headers, 'access-control-allow-origin': '*' });
      res.end(r.body);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'INTERNAL', message: err.message }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.proxy.port, cfg.proxy.host, () => resolve(server));
  });
}

function startWebuiListener(cfg) {
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    try {
      if (pathname.startsWith('/api/web/')) {
        let body = {};
        if (req.method === 'POST' || req.method === 'PUT') {
          const raw = await readBody(req);
          try {
            body = raw ? JSON.parse(raw) : {};
          } catch {
            return json(res, 400, { error: 'BAD_BODY', message: '请求体必须是 JSON' });
          }
        }
        return await handleWebApi(req, res, pathname, body);
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (serveStatic(req, res, pathname)) return;
      }
      json(res, 404, { error: 'NOT_FOUND' });
    } catch (err) {
      json(res, 500, { error: 'INTERNAL', message: err.message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.webui.port, cfg.webui.host, () => resolve(server));
  });
}

/** 启动双 listener（index.js 调用） */
export async function startServers() {
  const cfg = getConfig();
  initDb();
  const proxy = await startProxyListener(cfg);
  const webui = await startWebuiListener(cfg);
  log('info', `proxy listener：http://${cfg.proxy.host}:${cfg.proxy.port}（/api/proxy）`);
  log('info', `webui listener：http://${cfg.webui.host}:${cfg.webui.port}（/api/web/* + 静态）`);
  return { proxy, webui };
}
