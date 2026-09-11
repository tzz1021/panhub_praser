/**
 * 直链状态判定（v1.1.5.2 / v1.2.x 复用分家）
 *
 * 四色状态（行底色 + status:xxx 文本，防脚本批量刷 prase 的轻量对抗）：
 * - 白：等待中（未解析）或 完成且已过期（oss Expires / auth_key 剩余 < 60s）
 * - 绿：完成且有效期足够支撑完整下载（剩余时间 >= 参考下载耗时）
 * - 黄：完成但有效期不够支撑完整下载（剩余 < 参考耗时，但仍有效）
 * - 红：失败（含手动终止）
 *
 * 参考下载速率：200Mb 家庭宽带实测 1.5 MiB/s（Tzz 2026-08-18 提供，防刷阈值用）。
 *
 * v1.2.x 复用分家（Task 4）：
 * - prase（直链）复用严格按**上游过期时间**判定：优先 entry.expiresAt（适配器解析自
 *   URL Expires/auth_key 参数或响应 expire_time），其次实时解析直链 URL 的签名过期参数；
 *   两者皆无（极端情况）→ 视为不可用（白）。偏好 reuseWindowHours 不再参与直链判定。
 * - scan（资源列表）快照复用仍由偏好窗口决定（HomePage，见 core/types.ts 注释）。
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

/**
 * 从直链 URL 解析签名过期参数 → 绝对过期 ms（v1.2.x 通用工具，适配器也可用）。
 * 覆盖两种 CDN 签名形态：
 * - UC/夸克系 pds.uc.cn：`Expires=<秒>`（OSS 风格）
 * - 夸克 auth_key：`auth_key=<秒>-0-0-<sign>`（CDN 风格，首段即过期秒数）
 * 两者皆无返回 null。
 */
export function ossUrlExpiryMs(url: string): number | null {
  const exp = getExpiry(url);
  if (exp !== null) return exp;
  const ak = url.match(/[?&]auth_key=(\d{9,11})(?:-|&|$)/);
  return ak ? Number(ak[1]) * 1000 : null;
}

/**
 * 条目的绝对过期 ms：优先 entry.expiresAt（适配器在解析时算好的值），
 * 其次实时解析直链 URL 签名参数（兼容历史足迹里没存 expiresAt 的旧条目）；皆无返回 null。
 */
export function entryExpiryMs(entry: Pick<LinkEntry, 'url' | 'expiresAt'>): number | null {
  if (typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt)) {
    return entry.expiresAt;
  }
  return ossUrlExpiryMs(entry.url ?? '');
}

/** 过期安全边际：oss Expires 剩余不足该值即视为已过期（按上游过期时间计算而非 prase 时间） */
export const EXPIRY_MARGIN_MS = 60_000;

/** 参考下载速率：1.5 MiB/s（实测），用于「是否足够支撑完整下载」计算 */
export const REF_DOWNLOAD_RATE_BPS = 1.5 * 1024 * 1024;

/** 文件在参考速率下完成下载所需毫秒数 */
export function downloadTimeMs(sizeBytes: number | undefined): number {
  if (!sizeBytes || sizeBytes <= 0) return 0;
  return Math.ceil((sizeBytes / REF_DOWNLOAD_RATE_BPS) * 1000);
}

/**
 * 解析直链详细状态（细粒度，调用方按需映射颜色/按钮）。
 * v1.2.x：直链有效性只看上游过期时间（entryExpiryMs），reuseWindowHours 已不参与。
 * 无任何过期信息（entry.ok 但解析不出 expiresAt）→ 视为 expired（兜底：宁白不绿，
 * 让用户一键续杯重新解析；该情况仅出现在直链 URL 不带签名过期参数且适配器未填充）。
 */
export function linkDetailOf(entry: LinkEntry | undefined, sizeBytes?: number): LinkDetail {
  if (!entry) return { kind: 'none' };
  if (entry.terminatedAt) return { kind: 'terminated' };
  if (!entry.ok) return { kind: 'failed' };
  const exp = entryExpiryMs(entry);
  if (exp === null) return { kind: 'expired' }; // 无上游过期信息 → 视为不可用（任务 4 兜底决策）
  const remainMs = exp - Date.now();
  if (remainMs <= EXPIRY_MARGIN_MS) return { kind: 'expired' };
  const needed = downloadTimeMs(sizeBytes);
  // 有大小且剩余时间不够完整下载 → 黄；否则绿
  if (needed > 0 && remainMs < needed) return { kind: 'yellow', remainMs };
  return { kind: 'green', remainMs };
}

/** 四色状态（行底色 / status:xxx 文本） */
export function linkStatusOf(entry: LinkEntry | undefined, sizeBytes?: number): LinkStatusKind {
  const d = linkDetailOf(entry, sizeBytes);
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
export function isLinkUsable(entry: LinkEntry | undefined, sizeBytes?: number): boolean {
  const d = linkDetailOf(entry, sizeBytes);
  return d.kind === 'green' || d.kind === 'yellow';
}

/** 是否绿色（有效期足够支撑完整下载；防刷判定用） */
export function isLinkGreen(entry: LinkEntry | undefined, sizeBytes?: number): boolean {
  return linkDetailOf(entry, sizeBytes).kind === 'green';
}

/** 是否黄色（有效但不够完整下载；导出后提示用） */
export function isLinkYellow(entry: LinkEntry | undefined, sizeBytes?: number): boolean {
  return linkDetailOf(entry, sizeBytes).kind === 'yellow';
}

/** 文件行状态标签（v1.1.5.2：直接写 status:xxx，方便 ctrl+s 保存页面后统计） */
export function linkStatusLabel(entry: LinkEntry, sizeBytes?: number): string {
  const d = new Date(entry.fetchedAt);
  const p = (n: number): string => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const detail = linkDetailOf(entry, sizeBytes);
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
