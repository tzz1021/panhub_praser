/**
 * UAC 表的**行定义**与**未适配网盘的补充数据**（v1.3.2，来源：Tzz 2026-09-25 表）
 *
 * 数据源约定（不破坏原有分层）：
 * - 已注册适配器的单元格值一律取自该适配器的 `limits`（即 `adapters/<网盘>/types.ts` 里的 `*_LIMITS`），
 *   本文件只声明「有哪些行、每行取哪个字段」；
 * - 尚未适配因此没有 adapter 的网盘（此处：毒盘/迅雷/123）用 `UAC_EXTRA_LIMITS` 补充，
 *   以后接入适配器时把值搬进对应 `*_LIMITS` 并删掉这里的条目即可。
 *
 * 两种形态（同一份数据，纯前端切换，**任意切换都不发请求**）：
 * - 精简（`brief: true`，6 行）= 收起态，日常够用；
 * - 详细（13 行，顺序同 Tzz 表）= 展开态，含凭据有效期/续期方案/scan·restore·download 策略。
 */
import type { PanLimits } from '../../adapters/types';

/** 未适配网盘的 UAC 补充数据（key = PanTable 的 pan id） */
export const UAC_EXTRA_LIMITS: Record<string, Partial<PanLimits>> = {
  baidu: {
    altRenewNote: 'AlistOAuth（实测失败，可能账号限制）',
  },
  xunlei: {
    scanStrategyNote: '官方 30，此处不限',
    restoreStrategyNote: '不允许接收者是分享者',
    altRenewNote: 'Alist(SDK) 反代，会与手机 app 互踢',
  },
  '123': {
    altRenewNote: 'AlistOAuth',
  },
};

/** 一行 UAC 数据 */
export interface UacRow {
  /** 行标题（表格最左列） */
  label: string;
  /** 是否属于精简形态（收起时仍显示） */
  brief: boolean;
  /** 单元格取值：适配器 limits → 补充数据 → '—' */
  cell: (lim: Partial<PanLimits> | undefined) => string;
}

/** 布尔单元格：true → ✓，false → ✗，未知 → — */
const boolCell =
  (key: 'needsTransfer' | 'needsLogin' | 'canRemoveSpeedLimit') =>
  (lim: Partial<PanLimits> | undefined): string => {
    const v = lim?.[key];
    return typeof v === 'boolean' ? (v ? '✓' : '✗') : '—';
  };

/** 文本单元格：去空后为空/未定义 → — */
const textCell =
  (key: keyof PanLimits) =>
  (lim: Partial<PanLimits> | undefined): string => {
    const v = lim?.[key];
    return typeof v === 'string' && v.trim() !== '' ? v : '—';
  };

/** 详细形态 13 行（顺序 = Tzz 2026-09-25 表；brief 行 = 精简形态 6 行） */
export const UAC_ROWS: UacRow[] = [
  { label: '是否需要转存', brief: true, cell: boolCell('needsTransfer') },
  { label: '是否需要登录', brief: true, cell: boolCell('needsLogin') },
  { label: '能否提速', brief: true, cell: boolCell('canRemoveSpeedLimit') },
  { label: '分享凭据有效期', brief: false, cell: textCell('shareCredTtlNote') },
  { label: '登录凭据有效期', brief: false, cell: textCell('loginCredTtlNote') },
  { label: 'web会话激活，通用CDP续期', brief: false, cell: textCell('sessionRenewNote') },
  { label: '其他续期方案', brief: false, cell: textCell('altRenewNote') },
  { label: '获取目录树scan策略', brief: false, cell: textCell('scanStrategyNote') },
  { label: '转存restore策略(支持复用)', brief: false, cell: textCell('restoreStrategyNote') },
  { label: '下载download策略', brief: false, cell: textCell('downloadStrategyNote') },
  { label: 'download_url有效期', brief: true, cell: textCell('linkExpiryNote') },
  { label: 'download_url额外说明', brief: true, cell: textCell('downloadUrlNote') },
  { label: 'hash种类/支持情况', brief: true, cell: textCell('etagNote') },
];

/** 合并适配器 limits 与补充数据（适配器优先，补充数据只补空缺字段） */
export function mergeUacLimits(
  adapterLimits: Partial<PanLimits> | undefined,
  extra: Partial<PanLimits> | undefined,
): Partial<PanLimits> | undefined {
  if (!adapterLimits) return extra;
  if (!extra) return adapterLimits;
  return { ...extra, ...adapterLimits };
}
