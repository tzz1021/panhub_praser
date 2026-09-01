/**
 * WebUI 鉴权（docs/selfhost-node.md §4.3）
 *
 * v1 简化：门禁令牌 = 秘钥（首启打印/可轮换）。危险操作（白名单增删/账号池修改/
 * 令牌轮换）在 UI 侧要求二次输入令牌确认（保险柜钥匙语义），服务端统一校验。
 *
 * 本地 webui 的威胁是恶意网页打 127.0.0.1（DNS rebinding）→ 四件套：
 *  1. Host 头校验（只认 127.0.0.1 / localhost / 配置的 host）
 *  2. Origin 校验（只认同源；无 Origin 的 curl 等也放行——本地 CLI 场景）
 *  3. CSRF token（每个会话随机，写进页面 meta，所有 /api/web 写操作必须带）
 *  4. 随机端口（config.js 首启生成）
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getConfig } from './config.js';

const SESSIONS = new Map(); // csrf -> { at }

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Host 头校验（DNS rebinding 防线 1）
 * 放行：回环（127.0.0.1/localhost/[::1]）+ 配置的 webui.host / proxy.host。
 * B 端部署：PANHUB_BIND=<固定内网 IP> 时 launcher 会把 proxy.host/webui.host 写成该 IP →
 * 企业员工经固定内网 IP 访问管理面板放行；0.0.0.0 永不匹配真实 Host，天然只放行回环。 */
export function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  const host = hostHeader.split(':')[0].replace(/^\[|\]$/g, '').toLowerCase();
  if (ALLOWED_HOSTS.has(host)) return true;
  const cfg = getConfig();
  return host === (cfg.webui.host || '127.0.0.1') || host === (cfg.proxy.host || '127.0.0.1');
}

/** Origin 校验（防线 2）：同源或缺失放行 */
export function originAllowed(originHeader, hostHeader) {
  if (!originHeader) return true;
  try {
    const o = new URL(originHeader);
    return o.host === hostHeader || ALLOWED_HOSTS.has(o.hostname);
  } catch {
    return false;
  }
}

/** 校验 WebUI 令牌（门禁） */
export function verifyWebuiToken(token) {
  const cfg = getConfig();
  if (!cfg.webui.token) return false;
  return safeEqual(token, cfg.webui.token);
}

/** 创建会话 → 返回 CSRF token（同时发回给前端；写操作必须回带） */
export function createCsrf() {
  const csrf = randomBytes(24).toString('hex');
  SESSIONS.set(csrf, { at: Date.now() });
  // 简单过期清理（1 小时）
  const cutoff = Date.now() - 3600_000;
  for (const [k, v] of SESSIONS) if (v.at < cutoff) SESSIONS.delete(k);
  return csrf;
}

/** 校验 CSRF（写操作防线 3）；校验通过顺带刷新会话时间 */
export function verifyCsrf(csrf) {
  const s = SESSIONS.get(csrf);
  if (!s) return false;
  s.at = Date.now();
  return true;
}

/** X-Proxy-Token 校验（proxy listener 用；timingSafeEqual） */
export function verifyProxyToken(token) {
  const cfg = getConfig();
  if (!cfg.proxy.token) return false;
  return safeEqual(token, cfg.proxy.token);
}
