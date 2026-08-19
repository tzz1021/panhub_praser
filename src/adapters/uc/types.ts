/**
 * UC 网盘静态属性（docs/STRUCTURE.md：src/adapters/uc/types.ts）
 *
 * 存放 UC 的静态常量与原始类型：API 地址、查询参数、错误码映射、特性表、
 * detail 接口原始元素等。云端策略变动（错误码/参数/限制）只需改这里。
 *
 * 约束：本文件零运行时依赖（纯常量/类型），可被 scanner/selector/jumper 共用。
 */

/** UC 分享 ID 形如 https://drive.uc.cn/s/dd2ad2345e124 或 /share/xxx */
export const SHARE_URL_RE = /^https?:\/\/(?:[a-z0-9-]+\.)*uc\.cn\/(?:s|share)\/([A-Za-z0-9_-]+)/i;

/** API 前缀（reverse-notes §2） */
export const API_BASE = 'https://pc-api.uc.cn/1/clouddrive';
/** token/detail 通用参数 */
export const PC_QUERY = 'pr=UCBrowser&fr=pc';
/** download 必带参数，缺一个即 401（reverse-notes §2.3 / §3.1，踩坑最大） */
export const DL_QUERY = 'entry=ft&fr=pc&pr=UCBrowser';

/** 错误码 → 中文文案（reverse-notes §4 错误码映射表） */
export const ERROR_MESSAGES: Record<number, string> = {
  31001: '请先登录网盘（分享者或访问者要求）',
  23018: '超出游客可获取大小限制，请登录后获取',
  14001: '分享 ID 或 stoken 无效，请刷新重试',
  41020: '文件令牌失效，请重新解析',
  15000: '服务暂时不可用，请稍后重试',
};

/**
 * UC 网盘特性表（偏好设置 UAC 表数据源，与 reverse-notes §3/§10 一致）：
 * - 游客可直接解析；下载层需要 __pugs 人机校验 cookie（游客态即可，§10.1）
 * - 直链可加速（UC 不限速）；23018 超限临界值未知，标注“临界未知”
 * - oss/sig 较小有效期：直链 3-6h（实测），__pugs 固定 3h
 */
export const UC_LIMITS = {
  needsTransfer: false,
  needsLogin: false,
  canRemoveSpeedLimit: true,
  needsCookie: true, // 下载层需要 __pugs（§10：游客态 cookie，非登录态）
  noLoginNeeded: true,
  batchOnlyAriaGopeed: false,
  sizeLimitNote: '4G 文件都不需要，临界未知',
  linkExpiryNote: '直链 3-6h/Cookie 3h',
} as const;

/** detail 接口 list[] 原始元素（字段名来自真实抓包 uc_detail_sample.json） */
export interface UcDetailItem {
  fid: string;
  file_name?: string;
  dir?: boolean;
  size?: number;
  share_fid_token?: string;
  format_type?: string;
  created_at?: number;
  updated_at?: number;
}

/** download 接口响应元素 */
export interface UcDownloadItem {
  download_url?: string;
  file_name?: string;
  size?: number;
  md5?: string;
}
