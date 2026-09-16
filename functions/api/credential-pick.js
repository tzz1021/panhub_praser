/**
 * 四类路由 · credential-pick（取号类：托管账号身份查询；旧称 cookie-pick）
 *
 * 语义（v1.3.1 四类规范）：
 *   - 「取号」= 从 backend 账号池挑一个可用账号注入上游请求（发生在 download 链路内部，函数内部调用）
 *   - 「凭据身份查询」= 这里：问 backend「当前有哪些可用账号身份」，**只返回非敏感身份**
 *     （userId / drive:<driveId>），凭据本体永不下发 SPA（Tzz D2：换号不换 #3 无意义，要返回 userId）
 *
 * POST body: { provider: 'alipan' | 'uc' | 'quark', account?: string }
 * → 200 { backend: boolean, accounts: string[] }
 *   backend=false → 未配置 BACKEND_URL（云端无托管：SPA 应回退本地凭据）
 *
 * TODO(D1 待接入)：SPA 侧的滚动更新探测（carry.ts#onAlipanExpired）后续改为走本路由，
 * 不再由 SPA 直连 hop；本路由先就位，暂未接入主流程。
 */
import { CORS_HEADERS, checkRateLimit, checkToken, json } from './_shared/proxy-core.js';

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** 后端探测超时（与转发链路的取号一致：800ms 短超时，失败即降级） */
const PROBE_TIMEOUT_MS = 800;

export async function onRequestPost(context) {
  const { request, env } = context;
  const denied = checkToken(request, env);
  if (denied) return denied;
  const limited = checkRateLimit(request);
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
  if (!base) return json(200, { backend: false, accounts: [] }); // 无托管：SPA 回退本地凭据

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
    clearTimeout(timer);
    return json(200, { backend: true, accounts: [] }); // 不可达 = 空集合（安全降级，不抛错）
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // 404 = 老 backend 无该端点 → 空集合（不阻断；SPA 按「未命中」处理）
    return json(200, { backend: true, accounts: [] });
  }
  let data;
  try {
    data = await res.json();
  } catch {
    return json(200, { backend: true, accounts: [] });
  }
  const accounts = Array.isArray(data?.accounts)
    ? data.accounts.filter((v) => typeof v === 'string' && v.length > 0)
    : [];
  return json(200, { backend: true, accounts });
}
