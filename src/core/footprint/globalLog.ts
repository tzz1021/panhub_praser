/**
 * 全局日志（开发调试用，reverse-notes-uc 2026-08-16 规划）
 *
 * 与足迹 logs.ts 的区别：
 * - 足迹日志：按链接（url 维度）归档，写入前强制脱敏（cookie/令牌 → ~~***~~）
 * - 全局日志：服务维度（启动/设置变更/解析点击/代理测试/导出合并），
 *   **故意不过滤隐私信息**（UI 上有明确声明），仅用于开发调试定位问题
 *
 * 存储：localStorage 环形缓冲（默认 300 条，超限丢最旧），无 IndexedDB 依赖。
 */
const STORAGE_KEY = 'pan-web:global-log:v1';
const LAST_START_KEY = 'pan-web:global-log:last-start:v1';
const DEFAULT_LIMIT = 300;

export interface GlobalLogEntry {
  time: string; // ISO
  message: string;
}

/** 读取全部全局日志（新→旧） */
export function listGlobalLogs(): GlobalLogEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as GlobalLogEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 追加一条全局日志（message 不过滤隐私；环形裁剪到 limit 条） */
export function addGlobalLog(message: string, limit = DEFAULT_LIMIT): void {
  if (typeof window === 'undefined') return;
  try {
    const entry: GlobalLogEntry = { time: new Date().toISOString(), message };
    const next = [entry, ...listGlobalLogs()].slice(0, limit);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 配额/隐私模式静默（日志不阻断主流程）
  }
}

/** 清空全局日志 */
export function clearGlobalLogs(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 忽略 */
  }
}

/** 记录"服务已启动"（带上次启动时间），返回本次启动时间 */
export function logServiceStart(): string {
  const now = new Date();
  let lastStart = '（首次启动）';
  try {
    const raw = window.localStorage.getItem(LAST_START_KEY);
    if (raw) lastStart = raw;
    window.localStorage.setItem(LAST_START_KEY, now.toISOString());
  } catch {
    /* 忽略 */
  }
  addGlobalLog(`服务已启动，欢迎你的使用（上次启动：${lastStart}）`);
  return now.toISOString();
}
