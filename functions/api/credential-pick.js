/**
 * 四类路由 · credential-pick（凭据探测；旧称 cookie-pick）
 *
 * v1.3.1·D1 定稿（Tzz）：**hop 的请求方式下沉到这里** —— SPA 只跟本路由说话，
 * 由 functions 去问 backend（凭据与账号集合都不下发 SPA）。
 *
 * 请求：`POST /api/credential-pick`，body `{ provider: 'alipan'|'uc'|'quark', account?: string }`
 *   account = 调用方手上那份凭据的**非敏感身份**（如 alipan 的 userId），用于判定「是不是同一个账号」
 * 响应：`200 { backend: boolean, credential: 'hit' | 'guest' | 'none' }`（**只暴露这三个状态**）
 *   hit   = backend 账号池里有这个账号（可静默续杯）
 *   guest = backend 在，但没有这个账号（只能游客/占位）
 *   none  = 无托管：未配置 BACKEND_URL / 不可达 / 老 backend 无该端点 / 没带 account 且池子为空
 *   backend=false 表示根本没配置托管（SPA 据此回退本地凭据；与 credential='none' 同向但语义更明确）
 *
 * 安全边界（与转发链路一致）：
 *   - X-Proxy-Token 校验 + 每 IP 限频（复用 proxy-core 的实现）
 *   - **永不下发凭据本体、永不下发账号集合**（旧实现回 `accounts: string[]`，v1.3.1 收窄为三态）
 *   - 上游 backend 端点 `GET /api/credential-pick/accounts` 仍只回非敏感身份（backend 侧保证）
 *
 * 失败一律安全降级（`credential: 'none'`，HTTP 200）：探测失败绝不能阻断主流程，
 * 更不能让 SPA 误以为「有托管」。
 */
import { CORS_HEADERS, checkRateLimit, checkToken, json } from './_shared/proxy-core.js';

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** 后端探测超时（与转发链路的取号一致：800ms 短超时，失败即降级） */
const PROBE_TIMEOUT_MS = 800;

/** 探测限频（比转发更严：探测是用户触发的低频动作，防被拿来刷） */
const PROBE_LIMIT_PER_MIN = 30;
const probeHits = new Map(); // ip -> number[]（时间戳）

function probeLimited(request) {
  const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const now = Date.now();
  const arr = (probeHits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= PROBE_LIMIT_PER_MIN) {
    probeHits.set(ip, arr);
    return json(429, { error: 'RATE_LIMITED', message: `凭据探测过于频繁（${PROBE_LIMIT_PER_MIN}/min/IP）` });
  }
  arr.push(now);
  probeHits.set(ip, arr);
  return null;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = checkToken(request, env);
  if (denied) return denied;
  const limited = checkRateLimit(request) ?? probeLimited(request);
  if (limited) return limited;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: 'BAD_BODY', message: '请求体必须是 JSON（{ provider, account? }）' });
  }
  const provider = typeof payload?.provider === 'string' ? payload.provider : '';
  const account = typeof payload?.account === 'string' ? payload.account : '';
  if (!provider) return json(400, { error: 'BAD_BODY', message: '缺少 provider 字段' });

  const base = String(env.BACKEND_URL ?? '').replace(/\/+$/, '');
  if (!base) return json(200, { backend: false, credential: 'none' }); // 无托管：SPA 回退本地凭据

  const qs = new URLSearchParams({ provider });
  if (account) qs.set('account', account);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${base}/api/credential-pick/accounts?${qs.toString()}`, {
      method: 'GET',
      headers: { 'x-proxy-token': env.PROXY_TOKEN ?? '' },
      signal: controller.signal,
    });
  } catch {
    // 不可达 → 无托管（安全降级，不抛错；SPA 按「提示填新凭据」处理）
    return json(200, { backend: true, credential: 'none' });
  } finally {
    clearTimeout(timer);
  }
  // 404 = 老 backend 没有该端点 → 同样按「无托管」处理（不阻断）
  if (!res.ok) return json(200, { backend: true, credential: 'none' });
  let data;
  try {
    data = await res.json();
  } catch {
    return json(200, { backend: true, credential: 'none' });
  }
  // backend 侧已按 account 过滤（filter(x => x === wanted)），命中即长度为 1。
  // 未带 account 时：池子里有号 → hit（存在可用账号），没号 → guest。
  const accounts = Array.isArray(data?.accounts)
    ? data.accounts.filter((v) => typeof v === 'string' && v.length > 0)
    : [];
  const credential = accounts.length > 0 ? 'hit' : 'guest';
  return json(200, { backend: true, credential });
}
