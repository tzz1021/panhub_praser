/**
 * 格式化工具（docs/STRUCTURE.md：src/utils/format.ts）
 * 大小 / 时间 / 时长显示。
 */

/** 字节 → 人类可读（B/KB/MB/GB/TB，2 位小数） */
export function formatSize(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = bytes;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(2)} ${units[i]}`;
}

/** 时间戳(ms) → YYYY-MM-DD HH:mm（本地时区） */
export function formatTime(ts: number | undefined | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 剩余毫秒 → "Xh Ym" / "Ym Zs" / "已过期" */
export function formatRemain(ms: number): string {
  if (ms <= 0) return '已过期';
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m`;
  const s = Math.floor((ms % 60_000) / 1000);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** 下载文件名安全化（去掉路径分隔符/非法字符） */
export function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim();
}
