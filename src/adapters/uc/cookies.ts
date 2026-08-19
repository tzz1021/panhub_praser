/**
 * UC __pugs 令牌存取（docs/STRUCTURE.md：src/adapters/uc/cookies.ts）
 *
 * 原 src/adapters/ucPugs.ts（1.1.6 adapter 规范整理迁入）。
 * 这是 UC 网盘的专属凭据（下载层唯一必需 cookie），按架构约束
 * “core/ 零网盘依赖”（docs/transport.md）放在 adapters 层，不污染 core。
 *
 * 来源：CF 代理转发 UC API 时捕获 upstream `set-cookie: __pugs=` 回传 `x-pugs` 头
 * （§10.2 代理捕获通道），UC 适配器 request() 收口处自动落库。
 * 用途：curl/aria2/gopeed 导出命令注入 `Cookie: __pugs=...`（§10.2 导出通道）。
 *
 * 注意：这是令牌值，不是浏览器 cookie jar —— 浏览器内直连下载仍靠
 * “新标签预热”把 __pugs 写进 .uc.cn 的 jar（§10.2 预热通道），两者互补。
 *
 * 有效期：Max-Age=10800（3 小时），过期后下次解析自动重新捕获覆盖。
 *
 * §12（2026-08-16 实测）：__pugs 与直链**同响应绑定** —— 某次 download
 * 响应下发的 __pugs 只对该响应的 download_url 有效，跨响应/跨环境混用
 * 一律 403（Cdn auth fail: ucidMd5 invalid）。因此导出命令不再读取本全局
 * 值，而是用适配器绑定到每个 LinkResult 的 cookie（见 scanner.ts getDownloadLinks）；
 * 本全局值仅用于弹窗展示捕获状态与调试。
 */
const STORAGE_KEY = 'pan-web:uc-pugs:v1';

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

/** 写入 __pugs 值（适配器捕获后调用；空值忽略，防脏数据） */
export function setPugs(value: string | null | undefined): void {
  if (!value || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // 配额/隐私模式异常静默
  }
}

/** 从传输层响应头里捕获 x-pugs（若存在）并落库；返回捕获到的值（无则 null） */
export function capturePugsFromHeaders(headers: Record<string, string>): string | null {
  const v = headers['x-pugs'];
  if (!v) return null;
  setPugs(v);
  return v;
}
