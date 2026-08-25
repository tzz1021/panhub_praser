/**
 * 核心转发（docs/selfhost-node.md §4.1/§4.2）—— 与 CF 版 functions/api/proxy.js 协议完全兼容
 *
 * POST /api/proxy { url, method, headers, body }
 * 校验顺序：X-Proxy-Token（timingSafeEqual）→ scheme/白名单 → （可选）限频 → 转发
 * 响应：原样透传状态码 + body + content-type；CORS *；回传头 x-pugs / x-quark-pus / x-quark-puus
 *
 * 本地版多出的能力：
 * - 完整响应头记录（脱敏版进 DB + 完整版进 data/tmp/debug-*.log）
 * - Set-Cookie 自动合并回账号池（cookies.mergeSetCookies，与 SPA mergeQuarkSetCookies 同构）
 * - 调用级 proxy_logs（数据看板数据源）
 */
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { getConfig } from './config.js';
import { verifyProxyToken } from './auth.js';
import { log } from './log.js';
import { getDb, audit } from './db.js';
import { pickAccountForPan, mergeSetCookies, CREDENTIAL_KEYS } from './cookies.js';

const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE'];
const MAX_BODY_BYTES = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 20_000;

/** IP 限频（内存滑动窗口；0 = 关） */
const rateBuckets = new Map(); // ip -> number[]

function rateLimited(ip, perMin) {
  if (!perMin || perMin <= 0) return false;
  const now = Date.now();
  const arr = (rateBuckets.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= perMin) {
    rateBuckets.set(ip, arr);
    return true;
  }
  arr.push(now);
  rateBuckets.set(ip, arr);
  return false;
}

/** URL 特征 → 操作分类（scan | prase | other；与 SPA 术语一致） */
function classifyOperation(url) {
  if (/sharepage\/(token|detail)/.test(url)) return 'scan';
  if (/file\/download/.test(url)) return 'prase';
  return 'other';
}

function panOfHostname(hostname) {
  if (hostname.endsWith('uc.cn')) return 'uc';
  if (hostname.endsWith('quark.cn')) return 'quark';
  return null;
}

/** 脱敏：已知凭据名的值 → SHA-256 前缀（DB 存脱敏版） */
function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    const lk = k.toLowerCase();
    if (lk === 'cookie' || lk === 'set-cookie') {
      // cookie 头：逐项脱敏已知凭据；未知项保留名称 + 长度
      if (lk === 'set-cookie') {
        out[k] = (Array.isArray(v) ? v : [v]).map((sc) => {
          const eq = sc.indexOf('=');
          const name = eq > 0 ? sc.slice(0, eq).trim() : sc.slice(0, 16);
          const rest = eq > 0 ? sc.slice(eq) : '';
          return CREDENTIAL_KEYS.includes(name) ? `${name}=sha256:${sha256(sc)}` : `${name}${rest.length > 0 ? '=<len:' + sc.length + '>' : ''}`;
        });
        continue;
      }
      out[k] = String(v)
        .split(';')
        .map((pair) => {
          const eq = pair.indexOf('=');
          if (eq <= 0) return pair;
          const name = pair.slice(0, eq).trim();
          return CREDENTIAL_KEYS.includes(name) ? `${name}=sha256:${sha256(pair.slice(eq + 1).trim())}` : pair;
        })
        .join('; ');
      continue;
    }
    out[k] = v;
  }
  return out;
}

function sha256(s) {
  return createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
}

/** 单次转发（返回 { status, headers, body, durationMs, upstreamHeaders }） */
async function forward(payload) {
  const url = new URL(payload.url);
  const method = String(payload.method ?? 'GET').toUpperCase();
  const headers = { ...(payload.headers ?? {}) };
  const body = payload.body ?? null;
  const mod = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = mod(
      url,
      {
        method,
        headers,
        timeout: UPSTREAM_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const bodyBuf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: bodyBuf.toString('utf8').slice(0, MAX_BODY_BYTES),
            fullBody: bodyBuf,
            durationMs: Date.now() - started,
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`上游超时（${UPSTREAM_TIMEOUT_MS / 1000}s 封顶）`));
    });
    req.on('error', (err) => reject(err));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 处理 POST /api/proxy（proxy listener 路由）。
 * @param reqBody 已解析的 JSON body
 * @param clientIp 直连 remoteAddress（XFF 不可信）
 * @param proxyToken X-Proxy-Token 请求头值（与 CF 版同规格）
 * @returns Response 兼容对象 { status, headers, body }
 */
export async function handleProxy(reqBody, clientIp, proxyToken) {
  const cfg = getConfig();
  const started = Date.now();
  const fail = (status, message) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'DOMAIN_NOT_ALLOWED' : status === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST', message }) });

  // ① 令牌（timingSafeEqual）
  if (!verifyProxyToken(proxyToken)) {
    audit('proxy.reject', `token 无效 from ${clientIp}`, 'proxy');
    log('warn', `proxy：令牌无效，拒绝（${clientIp}）`);
    return fail(401, 'X-Proxy-Token 无效');
  }
  // ② URL 合法性 + 白名单
  let target;
  try {
    target = new URL(reqBody.url);
  } catch {
    return fail(400, 'url 不是合法 URL');
  }
  if (!['http:', 'https:'].includes(target.protocol)) return fail(400, '仅支持 http(s) 目标');
  if (target.username || target.password) return fail(400, 'url 不允许携带用户名/密码');
  if (!cfg.whitelist.some((s) => target.hostname === s || target.hostname.endsWith(`.${s}`))) {
    audit('proxy.reject', `域名不在白名单：${target.hostname}`, 'proxy');
    log('warn', `proxy：域名不在白名单，拒绝 ${target.hostname}`);
    return fail(403, `目标域名不在白名单：${target.hostname}`);
  }
  const method = String(reqBody.method ?? 'GET').toUpperCase();
  if (!ALLOWED_METHODS.includes(method)) return fail(405, `仅支持 ${ALLOWED_METHODS.join('/')}`);
  // ③ 限频（可选）
  if (rateLimited(clientIp, cfg.proxy.rateLimitPerMin)) {
    audit('proxy.reject', `限频 ${clientIp}`, 'proxy');
    log('warn', `proxy：限频触发，拒绝 ${clientIp}`);
    return fail(429, `请求过于频繁（${cfg.proxy.rateLimitPerMin}/min/IP）`);
  }

  // ④ 按网盘注入账号池 cookie（v1 分流：仅 prase/download 注入登录态，scan 保持游客——
  //    对齐 split 插件默认矩阵；后续 split 插件接管这里做三维调控）
  const pan = panOfHostname(target.hostname);
  const operation = classifyOperation(target.href);
  let accountId = null;
  const outHeaders = { ...(reqBody.headers ?? {}) };
  if (pan && operation === 'prase') {
    const hit = pickAccountForPan(pan);
    if (hit) {
      accountId = hit.account.id;
      const prev = outHeaders.cookie ? `${outHeaders.cookie}; ` : '';
      outHeaders.cookie = prev + hit.cookieString;
    }
  }

  // ⑤ 转发
  let upstream;
  try {
    upstream = await forward({ url: target.href, method, headers: outHeaders, body: reqBody.body ?? null });
  } catch (err) {
    log('error', `proxy：转发失败 ${target.hostname} — ${err.message}`);
    return { status: 502, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'UPSTREAM_ERROR', message: err.message }) };
  }

  // ⑥ 响应头处理：透传指定头 + 回传凭据头；set-cookie 合并回账号池
  const respHeaders = {
    'content-type': upstream.headers['content-type'] ?? 'application/octet-stream',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'x-pugs, x-quark-pus, x-quark-puus',
  };
  const setCookies = upstream.headers['set-cookie'] ?? [];
  if (pan && setCookies.length > 0) {
    mergeSetCookies(pan, setCookies);
    // 回传给 SPA（与 CF 版同规格：只回传这几个凭据键，其余 set-cookie 不回）
    const passthrough = {
      quark: ['__pus', '__puus'],
      uc: ['__pugs'],
    }[pan] ?? [];
    for (const sc of setCookies) {
      const eq = sc.indexOf('=');
      const name = eq > 0 ? sc.slice(0, eq).trim() : '';
      if (passthrough.includes(name)) {
        const value = sc.slice(eq + 1).split(';')[0].trim();
        if (value) respHeaders[pan === 'quark' ? `x-quark-${name.slice(2)}` : 'x-pugs'] = value;
      }
    }
  }

  // ⑦ 记录：脱敏进 DB（proxy_logs）+ 完整头进 debug 文件
  try {
    const db = getDb();
    db.prepare(
      'INSERT INTO proxy_logs (ts, pan, operation, method, url, req_status, duration_ms, account_id, queued_ms, client_ip, req_headers, resp_headers, body_preview) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      started, pan, operation, method, target.href.slice(0, 300), upstream.status, upstream.durationMs, accountId, 0, clientIp,
      JSON.stringify(redactHeaders(outHeaders)).slice(0, 2000),
      JSON.stringify(redactHeaders(upstream.headers)).slice(0, 4000),
      Buffer.isBuffer(upstream.fullBody) ? upstream.fullBody.toString('utf8').slice(0, 500) : '',
    );
    log('debug', `proxy：${operation} ${pan ?? ''} ${method} ${target.hostname} → ${upstream.status}（${upstream.durationMs}ms${accountId ? `，账号#${accountId}` : ''}）`, {
      pan, operation, durationMs: upstream.durationMs, accountId,
    });
  } catch (err) {
    log('error', `proxy：落库失败 — ${err.message}`);
  }

  return { status: upstream.status, headers: respHeaders, body: upstream.body };
}
