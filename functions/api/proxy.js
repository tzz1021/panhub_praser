/**
 * panhub_praser 1.1 —— CF Pages Function 代理（POST /api/proxy）
 *
 * 设计依据：docs/transport.md（传输层协议 §代理协议 / §CF Pages Functions 实现）
 * 职责：SPA 侧绕过 CORS —— 浏览器把网盘 API 请求 POST 到这里，服务端转发。
 *
 * 额外职责（reverse-notes-uc.md §10.2）：捕获 upstream `set-cookie: __pugs=`
 * 并回传 `x-pugs` 响应头 —— SPA 据此拿到 UC 下载层唯一必需的 __pugs 令牌，
 * 注入 curl/aria2/gopeed 导出命令。
 *
 * 安全模型（docs/transport.md §关键设计决策 3）：
 *   1. X-Proxy-Token 校验（env PROXY_TOKEN，部署时生成）→ 401
 *   2. 目标域名白名单（uc.cn / 后续接入的网盘域）→ 403
 *   3. 每 IP 限频（60 req/min，内存滑动窗口，per-isolate 尽力而为）→ 429
 *
 * 边界：
 *   - 只转发 API JSON，不转发文件流（直链是 OSS 签名 URL，用户浏览器直连下载）
 *   - Cookie/Authorization 类凭据一律丢弃，不转发（协议 §防滥用）
 *   - 只转发白名单请求头（content-type / accept），其余全部丢弃
 *
 * 部署：
 *   - Pages 项目根目录放本文件 → 自动生成 POST /api/proxy 路由（与静态站同域，SPA 侧无需跨域）
 *   - 环境变量：PROXY_TOKEN（必配，fail-closed：未配置一律 503）
 *   - 本地调试：`wrangler pages dev . -- var PROXY_TOKEN=xxx`（或 dashboard 配好后线上测）
 */

const ALLOWED_HOST_SUFFIXES = [
  'uc.cn', // UC 网盘（token/detail/download 三连全在 pc-api.uc.cn / drive.uc.cn）
  // 后续接入的网盘域在这里追加，如 'aliyundrive.com'
];

const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'DELETE'];
const MAX_BODY_BYTES = 1024 * 1024; // 1MB，API JSON 足够
const UPSTREAM_TIMEOUT_MS = 20_000; // API JSON 小流量，20s 封顶

const RATE_LIMIT_PER_MIN = 60; // 每 IP 每分钟
const RATE_WINDOW_MS = 60_000;

/** per-isolate 内存滑动窗口（CF 是分布式隔离，这里只是"简单限频"；
 *  要硬限频请改用 CF Rate Limiting / KV 计数） */
const ipHits = new Map(); // ip -> number[]（时间戳）

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-proxy-token',
  // 跨域部署（如 SPA 在 GitHub Pages、代理在 pages.dev）时，浏览器需要显式放行才能读到 x-pugs
  'Access-Control-Expose-Headers': 'x-pugs',
  'Access-Control-Max-Age': '86400',
};

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...extra },
  });
}

/** 校验 X-Proxy-Token（env 未配置 → fail-closed 503，绝不裸奔） */
function checkToken(request, env) {
  const expected = env.PROXY_TOKEN;
  if (!expected) {
    return json(503, { error: 'PROXY_TOKEN_NOT_CONFIGURED', message: '代理未配置 PROXY_TOKEN，拒绝服务（fail-closed）' });
  }
  const got = request.headers.get('x-proxy-token') ?? '';
  if (got !== expected) {
    return json(401, { error: 'UNAUTHORIZED', message: 'X-Proxy-Token 无效' });
  }
  return null;
}

/** 目标域名白名单：host == 后缀 或 host 以 .后缀 结尾 */
function hostAllowed(hostname) {
  const h = hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

/** 简单限频：返回 null 放行，否则返回 429 Response */
function checkRateLimit(request) {
  const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const now = Date.now();
  const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_LIMIT_PER_MIN) {
    ipHits.set(ip, hits);
    return json(429, { error: 'RATE_LIMITED', message: `请求过于频繁（${RATE_LIMIT_PER_MIN}/min/IP）` });
  }
  hits.push(now);
  ipHits.set(ip, hits);
  return null;
}

/**
 * 从 Set-Cookie 响应头里提取 __pugs 值（UC 下载鉴权唯一必需 cookie，§10.1/§12）。
 * 兼容两种运行时：Workers 的 headers.get('set-cookie') 只回第一个值；
 * Node/undici 会把多个 Set-Cookie 用 ", " 拼接 —— 这里按“__pugs= 出现在任意段”匹配。
 */
function extractPugs(setCookie) {
  if (!setCookie) return null;
  // 按逗号分段（cookie 值本身不含逗号/分号，安全）；也可直接用宽松正则兜底
  const m = setCookie.match(/(?:^|,)\s*__pugs=([^;,\s]*)/);
  return m ? m[1] : null;
}

/** 透传前清理请求头：只留白名单，cookie/authorization 一律丢弃 */
function forwardHeaders(headers) {
  const out = {};
  for (const name of ['content-type', 'accept', 'accept-language']) {
    const v = headers[name];
    if (typeof v === 'string' && v) out[name] = v;
  }
  return out;
}

/** OPTIONS 预检：SPA 与代理跨域部署时（如 SPA 在 GitHub Pages）需要 */
export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const denied = checkToken(request, env);
  if (denied) return denied;

  const limited = checkRateLimit(request);
  if (limited) return limited;

  // 解析代理协议体 { url, method, headers, body }（见 docs/transport.md §代理协议）
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: 'BAD_BODY', message: '请求体必须是 JSON（{ url, method, headers, body }）' });
  }
  if (!payload || typeof payload !== 'object' || typeof payload.url !== 'string') {
    return json(400, { error: 'BAD_BODY', message: '缺少 url 字段' });
  }

  // 目标 URL 校验：仅 http(s) + 白名单域 + 无内嵌凭据
  let target;
  try {
    target = new URL(payload.url);
  } catch {
    return json(400, { error: 'BAD_URL', message: 'url 不是合法 URL' });
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return json(400, { error: 'BAD_URL', message: '仅支持 http(s) 目标' });
  }
  if (!hostAllowed(target.hostname)) {
    return json(403, { error: 'DOMAIN_NOT_ALLOWED', message: `目标域名不在白名单：${target.hostname}` });
  }
  if (target.username || target.password) {
    return json(400, { error: 'BAD_URL', message: 'url 不允许携带用户名/密码' });
  }

  const method = (typeof payload.method === 'string' ? payload.method.toUpperCase() : 'GET');
  if (!ALLOWED_METHODS.includes(method)) {
    return json(405, { error: 'METHOD_NOT_ALLOWED', message: `仅支持 ${ALLOWED_METHODS.join('/')}` });
  }

  // body 只允许字符串（JSON 原样透传），GET 不带 body
  const body = typeof payload.body === 'string' ? payload.body : null;
  if (body && body.length > MAX_BODY_BYTES) {
    return json(413, { error: 'BODY_TOO_LARGE', message: `body 超过 ${MAX_BODY_BYTES} 字节` });
  }
  if (method === 'GET') {
    // GET 不转发 body（浏览器 fetch 会直接抛错）
  }

  // 转发（丢弃 cookie/authorization，只留白名单头；无 UA 兜底避免被网盘风控误判）
  const upstreamInit = {
    method,
    headers: forwardHeaders(payload.headers ?? {}),
    ...(body && method !== 'GET' ? { body } : {}),
  };

  // 超时：AbortController + 手动计时（兼容性优先）
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(target.toString(), { ...upstreamInit, signal: controller.signal });
  } catch (err) {
    return json(502, {
      error: 'UPSTREAM_FAILED',
      message: err instanceof Error && err.name === 'AbortError'
        ? `上游超时（>${UPSTREAM_TIMEOUT_MS / 1000}s）`
        : `上游请求失败：${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    clearTimeout(timer);
  }

  // 原样透传状态码 + body（API JSON）；content-type 保留
  const respHeaders = {
    ...CORS_HEADERS,
    'Content-Type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
  };
  // 捕获 __pugs（UC 下载鉴权唯一必需 cookie）回传 SPA（§10.2 代理捕获通道）
  const setCookieRaw = upstream.headers.get('set-cookie');
  const pugs = extractPugs(setCookieRaw);
  if (pugs) {
    respHeaders['x-pugs'] = pugs;
  }
  // 诊断日志（排查 CF 边缘是否收到上游 __pugs；定位后删除）：
  console.log(`[proxy] ${method} ${target.hostname} -> ${upstream.status} | set-cookie: ${setCookieRaw ? setCookieRaw.split(';')[0] : '(none)'} | x-pugs: ${pugs ? 'YES' : 'no'}`);
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}
