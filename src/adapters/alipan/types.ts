/**
 * 阿里云盘（alipan）静态属性（docs/STRUCTURE.md：src/adapters/alipan/types.ts）
 *
 * 存放 alipan 的静态常量与原始类型：API 地址、x-canary 阶段值、错误码映射、特性表、
 * list_by_share 接口原始元素等。云端策略变动（错误码/参数/限制）只需改这里。
 *
 * 实现依据：/home/user/.openclaw/workspace/alipan-share/ 真机实测（2026-09-07/08，
 * repro.mjs / headtest.mjs / step1.mjs，分享 RB8JGeZRs89 + JiP7hcgmAAW）
 * 约束：本文件零运行时依赖（纯常量/类型），可被 scanner/selector/jumper/auth 共用。
 *
 * 契约速记（改动前必读）：
 * - 分享 URL：https://www.alipan.com/s/<share_id>（根）/ …/s/<share_id>/folder/<folder_file_id>（深链）；
 *   旧域 www.aliyundrive.com 同构；API host = api.aliyundrive.com（api.alipan.com 亦可）
 * - scan 三接口（get_share_token / get_by_share / list_by_share）全部免登录：仅需 content-type，
 *   share_token 走 x-share-token 头，有效期 2h；UA/device/canary 均可省（实测）
 * - prase 是「两跳」：① 转存到自己的盘（/adrive/v4/batch + /file/copy，带 Authorization 登录态
 *   + x-share-token 源授权）② 对转存后的新 file_id 取直链（/v2/file/get_download_url）。
 *   阿里云盘没有游客直下，登录用户也不能直下他人分享文件（实测 403），必须转存
 * - 下载防盗链：直链必须带**精确** `Referer: https://www.alipan.com/`（签名 x-oss-additional-headers
 *   含 Referer；其他值 403、缺失 400）——导出命令支持见交付摘要「待验证/开放问题」
 */

/** alipan 分享 ID 形如 https://www.alipan.com/s/xxxxxxxxxx（双域：alipan.com / 旧域 aliyundrive.com） */
export const SHARE_URL_RE =
  /^https?:\/\/(?:[a-z0-9-]+\.)*(?:alipan|aliyundrive)\.com\/s\/([A-Za-z0-9_-]+)/i;

/** API 前缀（alipan-share 实测：api.aliyundrive.com 与 api.alipan.com 同构） */
export const API_BASE = 'https://api.aliyundrive.com';

/**
 * x-canary 阶段差异（web 端抓包结论）：
 * - scan 用 `client=web,app=share,version=v2.3.1`（分享页 share 应用）
 * - prase 的 get_download_url 用 `client=windows,app=adrive,version=v6.0.0`（客户端取直链）
 * 不随 frontend-id 变化；同一次解析复用内保持一致。
 * TODO（待验证）：batch/get_download_url 是否必须 UA/x-device-id/x-canary ——
 * headtest.mjs 最小头矩阵未跑完（登录 token 过期中断），当前按保守写上，见 scanner.ts 注释。
 */
export const CANARY_SHARE = 'client=web,app=share,version=v2.3.1';
export const CANARY_ADRIVE = 'client=windows,app=adrive,version=v6.0.0';

/** 请求默认 UA（用户凭据串不写 user-agent 时使用；设备标识 x-device-id 默认不带） */
export const ALIPAN_DEFAULT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

export const ALIPAN_DOWNLOAD_REFERER = 'https://www.alipan.com/';

/**
 * 下载层静态头（v1.2.x，与 *_LIMITS 并列声明）：导出/推送命令按文件注入（ExportFile.headers）。
 * Referer 为**精确值** —— 直链 OSS 签名把 Referer 绑进 x-oss-additional-headers，
 * 其他值 403、缺失 400（实测）；UA 可选（OSS 不校验），不在静态头里写死。
 */
export const ALIPAN_DOWNLOAD_HEADERS = {
  Referer: ALIPAN_DOWNLOAD_REFERER,
} as const;

/**
 * 错误码 → 中文文案（alipan 错误 = HTTP 状态 + body { code: 'xxx', message }，
 * code 多为字符串，与 uc/quark 的数字码体系不同）。
 * TODO（待验证）：目前只收录 2026-09 实测见过的语义明确码；其余走上游 message 兜底，
 * 等 token 有效后再补一轮错误矩阵（分享失效/转存失败/直链失败各状态）。
 */
export const ERROR_MESSAGES: Record<string, string> = {
  ForbiddenNoPermission_File: '无权访问该文件（阿里云盘不允许直接下载他人分享文件，必须转存到自己的网盘后取直链）',
  ForbiddenNoPermission: '无权限执行该操作，请检查登录态与目标目录权限',
  // 转存内层 400（batch responses[].body.code；2026-09 实测语义）
  QuotaExhausted_Drive: '转存空间不足，请清理目标目录或换账号',
  // 登录态失效（get_download_url / batch 401 body.code）—— 提示重新填写即可，别的不用动
  AccessTokenInvalid: 'auth 已过期，请重新填写（回 alipan.com 重新复制 Authorization）',
  AccessTokenExpired: 'auth 已过期，请重新填写（回 alipan.com 重新复制 Authorization）',
};

/** 转存内层错误码 → 友好中文（无映射时 fallback 到上游 message 兜底，scanner 里内联） */
export const COPY_ERROR_MESSAGES: Record<string, string> = {
  // 403 ForbiddenNoPermission.File（copy 该文件无权限，单文件失败不阻断整批）
  ForbiddenNoPermission_File: '该文件无权转存（分享者未开放或文件已被移除），请跳过或刷新资源列表后重试',
  // 400 QuotaExhausted.Drive：目标网盘空间不足（整批转存都会失败）
  QuotaExhausted_Drive: '转存空间不足，请清理目标目录或换账号',
};

/** alipan 请求/响应内容类型（分享态 vs 登录态仅由 headers 区分） */
export const CT_JSON = 'application/json';

/**
 * 阿里云盘特性表（偏好设置 UAC 表数据源）：
 * - 目录树可游客读（scan 三接口免登录）；但 prase = 两跳（转存 + 取直链），
 *   完全拒绝游客，登录态 + 转存目标目录是硬前提 → 无 isbig 大小分级、无游客账号
 * - 下载层无 __pugs 类自动捕获凭据（直链是 OSS 预签名，带精确 Referer 即可下载）
 * - etag：分享态列表不返回任何 hash（转存后可查，暂未支持）
 */
export const ALIPAN_LIMITS = {
  needsTransfer: true, // 两跳：分享文件必须先转存到自己网盘
  needsLogin: true,
  canRemoveSpeedLimit: false, // 非会员下载限速情况未实测，按「不可」展示（不误导原则）
  needsCookie: false, // 下载层无自动捕获 cookie（直链带 Referer 即可）
  noLoginNeeded: false,
  batchOnlyAriaGopeed: false,
  sizeLimitNote: '游客不可解析：分享目录树可游客查看，直链必须登录态转存（无大小分级）',
  linkExpiryNote: '以 get_download_url 返回的 expire_time 为准（未实测区间）',
  etagNote: '不支持（分享态列表不返回 hash）',
} as const;

/** list_by_share 接口 items[] 原始元素（字段来自真实抓包，只列适配器用到的；
 * 时间戳是 ISO 字符串（如 2022-12-24T03:55:53.481Z），非毫秒数） */
export interface AlipanShareItem {
  file_id: string;
  name?: string;
  type?: 'file' | 'folder';
  parent_file_id?: string;
  share_id?: string;
  drive_id?: string;
  domain_id?: string;
  /** 仅文件有 */
  size?: number;
  file_extension?: string;
  mime_extension?: string;
  mime_type?: string;
  category?: string;
  created_at?: string;
  updated_at?: string;
}

/** /v2/share_link/get_share_token 响应（share_token 有效期 2h，走 x-share-token 头） */
export interface AlipanShareTokenResult {
  share_token?: string;
  expire_time?: string;
  expires_in?: number;
}

/** /adrive/v4/batch 响应（requests 数组 → responses 按序对应，内层 status 201 = 成功） */
export interface AlipanBatchResponse {
  responses?: Array<{
    id?: string;
    status?: number;
    body?: {
      file_id?: string;
      drive_id?: string;
      domain_id?: string;
      code?: string;
      message?: string;
    };
  }>;
}

/** /v2/file/get_download_url 响应（OSS 预签名直链 + 过期时间） */
export interface AlipanDownloadUrlResult {
  url?: string;
  expire_time?: string;
}
