/**
 * 错误分类与文案（docs/STRUCTURE.md：src/core/errors.ts）
 *
 * 约束：core/ 零网盘依赖 —— 本文件不 import 任何适配器，通过 duck-typing
 * 读取 err.code / err.status 分类（适配器抛出的错误对象只要带 code 字段即可被识别）。
 * message 优先用 err.message（uc.ts 抛出的已是最终中文文案），否则给分类兜底文案。
 */
/** 错误分类：供 UI 按类处理（如 need-login 弹登录跳转、over-limit 提示登录后重试） */
export type ErrorCategory =
  | 'need-login'
  | 'over-limit'
  | 'invalid'
  | 'expired'
  | 'network'
  | 'server'
  | 'unknown';

/** 分类兜底文案（err.message 缺失时使用） */
const FALLBACKS: Record<ErrorCategory, string> = {
  'need-login': '请先登录网盘后重试',
  'over-limit': '超出可获取大小限制，请登录后重试',
  invalid: '请求参数无效，请刷新重试',
  expired: '链接或令牌已过期，请重新解析',
  network: '网络请求失败，请检查网络后重试',
  server: '服务暂时不可用，请稍后重试',
  unknown: '发生未知错误，请重试',
};

/** 生成分类结果：优先 err.message（适配器文案），否则分类兜底 */
function result(category: ErrorCategory, err: unknown): { category: ErrorCategory; message: string } {
  const message = err instanceof Error && err.message ? err.message : FALLBACKS[category];
  return { category, message };
}

/**
 * 把任意错误分类成 ErrorCategory + 中文文案。
 * 分类规则（优先业务码 → 其次 HTTP 状态 → 再次网络层 → 兜底 unknown）：
 * - code 31001 → need-login；23018 → over-limit；14001 → invalid；41020 → expired；15000 → server
 * - HTTP 状态码 401 → invalid；>=500 → server（适配器常把 HTTP 码写进 code，故两者同规则判定）
 * - fetch 网络层失败（TypeError）→ network
 * - 其余 → unknown
 */
export function classifyError(err: unknown): { category: ErrorCategory; message: string } {
  // duck-typing：不依赖任何适配器类型/import，core 保持零网盘依赖
  const code = (err as { code?: number | string } | null | undefined)?.code;
  const status = (err as { status?: number } | null | undefined)?.status;

  // 业务错误码（与 uc.ts ERROR_MESSAGES 对应）
  if (code === 31001) return result('need-login', err);
  if (code === 23018) return result('over-limit', err);
  if (code === 14001) return result('invalid', err);
  if (code === 41020) return result('expired', err);
  if (code === 15000) return result('server', err);

  // HTTP 状态码：status 优先，其次数值型 code（uc.ts 用 fail(res.status) 把 HTTP 码放进 code）
  const http = typeof status === 'number' ? status : typeof code === 'number' ? code : 0;
  if (http === 401) return result('invalid', err);
  if (http >= 500) return result('server', err);

  // fetch 网络层失败：TypeError（如 CORS 拦截、断网、DNS 失败）
  if (err instanceof TypeError) return result('network', err);

  return result('unknown', err);
}

/**
 * 是否为 CORS 拦截错误（适配器在非网盘域直连时给出该提示，见 uc.ts request）
 * PC 端无书签场景下，UI 据此决定“自动跳转分享页”或弹窗提示（1.0.1）。
 */
export function isCorsError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('CORS');
}
