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
  // v1.3.1：UC download/列表（sharepage/detail 的 list[]）响应自带 md5，
  // 部分为 16 字节摘要的 base64（如 "75zWrXnoh/KB14803+wkJg=="），需转码成 hex
  // （见 adapters/uc/hash.ts#normalizeUcMd5）；非本地计算摘要
  etagNote: 'md5（download/列表响应自带，部分需 base64 转码）',
  // v1.3.2（UAC 表扩展行，Tzz 2026-09-25 表）：分享/登录凭据有效期、续期方式、策略与 download_url 说明
  shareCredTtlNote: 'stoken 6h',
  loginCredTtlNote: '随用随取',
  sessionRenewNote: 'cookie',
  scanStrategyNote: '一次性',
  downloadStrategyNote: '15 批次',
  downloadUrlNote: '需要 cookie：pugs',
} as const;

/**
 * 下载层静态头（v1.2.x，与 *_LIMITS 并列声明）：导出/推送命令按文件注入。
 * UA 原值从旧 src/tasks/curl.ts 迁来（reverse-notes-uc.md §5 实测组合，字符串保持不变）；
 * Referer = UC 分享页。动态凭据（__pugs 同响应绑定）不走这里。
 */
export const UC_DOWNLOAD_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'uc-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 ' +
    'Channel/pckk_other_ch',
  Referer: 'https://drive.uc.cn/',
} as const;

/** detail 接口 list[] 原始元素（字段名来自真实抓包 uc_detail_sample.json） */
export interface UcDetailItem {
  fid: string;
  file_name?: string;
  dir?: boolean;
  size?: number;
  share_fid_token?: string;
  format_type?: string;
  /** 文件校验和（true 抓包：base64 形态 24 字符「xx==」或 32 位 hex，两种都有；归一化见 hash.ts） */
  md5?: string;
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

/**
 * 隐秘参数按钮弹窗的 UC 话术（v1.1.7，静态资源）。
 * 给开发者解释 detail 接口返回结构里的重要字段；示例 fid 可用缓存 stoken 直接调官方 detail API。
 */
export const UC_HIDDEN_VOLUMN_TEXT = `顺序自上而下，已过滤顾名思义的 key，下面只展示重要的
结构
{
  status, code, message, timestamp
  data {
    is_owner, list[]
  }
  metadata
}

在 list[num]
- fid：文件 or 文件夹的身份，可以在全局日志查看，jumper 也使用这个发动二次 scan
- pdir_fid：父目录（一个文件夹）的 fid，scanner 的 list 功能依赖这个
- format_type：文件格式
- l_create_at：分享者账号存储文件时间
- l_update_at：分享者账号传文件时，文件在设备上记录的时间。如果转存数值同上
- operated_at：分享创建时间
- share_fid_token：文件处于分享状态的证明，通过分享访问文件的令牌
- create_at：分享创建时间
- update_at：分享状态下文件修改时间

在 metadata
- _size, _page 分页数据`;
