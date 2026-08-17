/**
 * __pugs 令牌存储（reverse-notes-uc.md §10：UC 下载层唯一必需的 cookie）
 *
 * 来源：CF 代理转发 API 时捕获 upstream `set-cookie: __pugs=` 回传 `x-pugs` 头
 * （§10.2 代理捕获通道），transport 层每次请求后自动落库。
 * 用途：curl/aria2/gopeed 导出命令注入 `Cookie: __pugs=...`（§10.2 导出通道）。
 *
 * 注意：这是令牌值，不是浏览器 cookie jar —— 浏览器内直连下载仍靠
 * “新标签预热”把 __pugs 写进 .uc.cn 的 jar（§10.2 预热通道），两者互补。
 *
 * 有效期：Max-Age=10800（3 小时），过期后下次解析自动重新捕获覆盖。
 */
const STORAGE_KEY = 'pan-web:pugs:v1';

/** 读取当前持有的 __pugs 值；无/损坏返回 null */
export function getPugs(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** 写入 __pugs 值（transport 捕获后调用；空值忽略，防脏数据） */
export function setPugs(value: string | null | undefined): void {
  if (!value || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // 配额/隐私模式异常静默
  }
}

/** 从响应头里捕获 x-pugs（若存在）并落库；返回是否捕获到 */
export function capturePugsFromHeaders(headers: Headers | Record<string, string>): boolean {
  const v =
    headers instanceof Headers
      ? headers.get('x-pugs')
      : (headers['x-pugs'] as string | undefined);
  if (!v) return false;
  setPugs(v);
  return true;
}
