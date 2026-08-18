/**
 * 直链状态判定（v1.1.5.2）
 *
 * 四色状态（行底色 + status:xxx 文本，防脚本批量刷 prase 的轻量对抗）：
 * - 白：等待中（未解析）或 完成且已过期（超复用窗口 / oss Expires 剩余 < 60s）
 * - 绿：完成且有效期足够支撑完整下载（剩余时间 >= 参考下载耗时）
 * - 黄：完成但有效期不够支撑完整下载（剩余 < 参考耗时，但仍有效）
 * - 红：失败（含手动终止）
 *
 * 参考下载速率：200Mb 家庭宽带实测 1.5 MiB/s（Tzz 2026-08-18 提供，防刷阈值用）。
 * oss Expires 判定按 URL 自带参数（点赞项），无参数时按复用窗口推算。
 */
import type { LinkEntry } from '../core/types';
import { formatRemain } from './format';

/** 直链状态（颜色语义） */
export type LinkStatusKind = 'none' | 'green' | 'yellow' | 'white' | 'red';

/** 内部细粒度状态（复用/导出/按钮逻辑用） */
export type LinkDetail =
  | { kind: 'none' }
  | { kind: 'green'; remainMs: number }
  | { kind: 'yellow'; remainMs: number }
  | { kind: 'expired' }
  | { kind: 'failed' }
  | { kind: 'terminated' };

/** 从 OSS 签名 URL 解析 Expires（秒时间戳），无该参数返回 null */
export function getExpiry(url: string): number | null {
  const m = url.match(/[?&]Expires=(\d+)/);
  return m ? Number(m[1]) * 1000 : null;
}

/** 过期安全边际：oss Expires 剩余不足该值即视为已过期（按 oss expire 计算而非 prase 时间） */
export const EXPIRY_MARGIN_MS = 60_000;

/** 参考下载速率：1.5 MiB/s（实测），用于「是否足够支撑完整下载」计算 */
export const REF_DOWNLOAD_RATE_BPS = 1.5 * 1024 * 1024;

/** 文件在参考速率下完成下载所需毫秒数 */
export function downloadTimeMs(sizeBytes: number | undefined): number {
  if (!sizeBytes || sizeBytes <= 0) return 0;
  return Math.ceil((sizeBytes / REF_DOWNLOAD_RATE_BPS) * 1000);
}

/** 解析直链详细状态（细粒度，调用方按需映射颜色/按钮） */
export function linkDetailOf(
  entry: LinkEntry | undefined,
  reuseWindowHours: number,
  sizeBytes?: number,
): LinkDetail {
  if (!entry) return { kind: 'none' };
  if (entry.terminatedAt) return { kind: 'terminated' };
  if (!entry.ok) return { kind: 'failed' };
  if (reuseWindowHours <= 0) return { kind: 'expired' }; // 窗口 0 = 不复用，一律视为已过期
  const age = Date.now() - entry.fetchedAt;
  if (age >= reuseWindowHours * 3600_000) return { kind: 'expired' };
  const exp = getExpiry(entry.url);
  const remainMs = exp !== null ? exp - Date.now() : reuseWindowHours * 3600_000 - age;
  if (remainMs <= EXPIRY_MARGIN_MS) return { kind: 'expired' };
  const needed = downloadTimeMs(sizeBytes);
  // 有大小且剩余时间不够完整下载 → 黄；否则绿
  if (needed > 0 && remainMs < needed) return { kind: 'yellow', remainMs };
  return { kind: 'green', remainMs };
}

/** 四色状态（行底色 / status:xxx 文本） */
export function linkStatusOf(
  entry: LinkEntry | undefined,
  reuseWindowHours: number,
  sizeBytes?: number,
): LinkStatusKind {
  const d = linkDetailOf(entry, reuseWindowHours, sizeBytes);
  switch (d.kind) {
    case 'green':
      return 'green';
    case 'yellow':
      return 'yellow';
    case 'failed':
    case 'terminated':
      return 'red';
    case 'expired':
    case 'none':
      return 'white';
  }
}

/** 是否可复用/可导出（绿 + 黄：直链仍有效，只是黄可能不够时间） */
export function isLinkUsable(entry: LinkEntry | undefined, reuseWindowHours: number, sizeBytes?: number): boolean {
  const d = linkDetailOf(entry, reuseWindowHours, sizeBytes);
  return d.kind === 'green' || d.kind === 'yellow';
}

/** 是否绿色（有效期足够支撑完整下载；防刷判定用） */
export function isLinkGreen(entry: LinkEntry | undefined, reuseWindowHours: number, sizeBytes?: number): boolean {
  return linkDetailOf(entry, reuseWindowHours, sizeBytes).kind === 'green';
}

/** 是否黄色（有效但不够完整下载；导出后提示用） */
export function isLinkYellow(entry: LinkEntry | undefined, reuseWindowHours: number, sizeBytes?: number): boolean {
  return linkDetailOf(entry, reuseWindowHours, sizeBytes).kind === 'yellow';
}

/** 文件行状态标签（v1.1.5.2：直接写 status:xxx，方便 ctrl+s 保存页面后统计） */
export function linkStatusLabel(entry: LinkEntry, reuseWindowHours: number, sizeBytes?: number): string {
  const d = new Date(entry.fetchedAt);
  const p = (n: number): string => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const detail = linkDetailOf(entry, reuseWindowHours, sizeBytes);
  switch (detail.kind) {
    case 'terminated':
      return `status:red 上次${hm}手动终止`;
    case 'failed':
      return `status:red 上次${hm}失败`;
    case 'expired':
      return `status:white 上次${hm}已过期`;
    case 'green':
      return `status:green 上次${hm}剩${formatRemain(detail.remainMs)}`;
    case 'yellow':
      return `status:yellow 上次${hm}剩${formatRemain(detail.remainMs)}`;
    case 'none':
      return 'status:white 未解析';
  }
}
