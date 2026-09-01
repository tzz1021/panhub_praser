/**
 * 夸克网盘静态属性（docs/STRUCTURE.md：src/adapters/quark/types.ts）
 *
 * 存放夸克的静态常量与原始类型：API 地址、查询参数、错误码映射、特性表、
 * detail 接口原始元素等。云端策略变动（错误码/参数/限制）只需改这里。
 *
 * 实现依据：docs/reverse-notes-quark.md（2026-08-23 真机实测，分享链接）
 * 约束：本文件零运行时依赖（纯常量/类型），可被 scanner/selector/jumper 共用。
 */

/** 夸克分享 ID 形如 https://pan.quark.cn/s/xxxxxxxxxxxx（短链）或带 #/list/share 长链 */
export const SHARE_URL_RE = /^https?:\/\/(?:[a-z0-9-]+\.)*quark\.cn\/s\/([A-Za-z0-9_-]+)/i;

/** API 前缀（reverse-notes-quark.md §2：分享三连全在 drive-h.quark.cn） */
export const API_BASE = 'https://drive-h.quark.cn/1/clouddrive';
/** token/detail 通用参数（与夸克网页版抓包一致） */
export const PC_QUERY = 'pr=ucpro&fr=pc&uc_param_str=&ver=2';
/** download 必带参数（同 UC 系：entry/ft/fr/pr，漏一个即异常） */
export const DL_QUERY = 'entry=ft&fr=pc&pr=ucpro';

/** 大文件登录阈值（字节）：实测 41MB 可、51MB 23018，取“约 50MB 以上需登录” */
export const QUARK_LOGIN_SIZE = 50 * 1024 * 1024;

/**
 * download 接口定制 UA（v1.1.9.final，与 linkswift $quark.api.ua.downloadLink 同款）：
 * 夸克风控对 download 校验客户端 UA —— 非 Electron 客户端 UA 直接 401（Tengine unsafe-url 风控），
 * cookie 穿透后仍 401 就是 UA 问题。仅 download 用（token/detail 游客态无需，与 linkswift 一致）。
 * 浏览器 fetch 禁止改 User-Agent，本头经代理 JSON body 透传后在服务端注入（proxy.js 白名单放行）。
 */
export const QUARK_DL_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/3.20.0 Chrome/112.0.5615.165 Electron/24.1.3.8 Safari/537.36 Channel/pckk_other_ch';

/** 错误码 → 中文文案（与 UC 同源错误码体系，reverse-notes-quark.md §4） */
export const ERROR_MESSAGES: Record<number, string> = {
  31001: '请先登录网盘（分享者或访问者要求）',
  23018: '超出游客可获取大小限制（约 50MB），请提供登录 cookie 后重试',
  14001: '分享 ID 或 stoken 无效，请刷新重试',
  41020: '文件令牌失效，请重新解析',
  15000: '服务暂时不可用，请稍后重试',
};

/**
 * 夸克网盘特性表（偏好设置 UAC 表数据源，reverse-notes-quark.md §3/§5）：
 * - 游客可读目录树（scanner 三连全部零 cookie）；prase 小文件游客可用
 * - 下载层需要 __pugs（同 UC §12 模式，响应 Set-Cookie，3h）；>50MB 触发
 *   23018 size limit → 需要登录 cookie（整串 __pus 等）才能下载
 * - etag（md5 种类）查询需要登录 + 解密脚本，暂不支持；但 download 响应免费带 md5
 */
export const QUARK_LIMITS = {
  needsTransfer: false,
  needsLogin: true,
  canRemoveSpeedLimit: true,
  needsCookie: true, // 下载层需要 __pugs（游客态，同 UC）
  noLoginNeeded: true,
  batchOnlyAriaGopeed: false,
  loginThresholdNote: '约 50MB 以上需要登录（实测 41MB 可、51MB 23018）',
  sizeLimitNote: '游客约 50MB，登录后可大文件（linkswift 称 200MB+ 强登，未实测）',
  linkExpiryNote: '直链 6h（auth_key）/Cookie 3h',
  etagNote: 'md5 为文件标识 tag,download 响应自带非计算摘要',
} as const;

/** detail 接口 list[] 原始元素（字段来自真实抓包，只列适配器用到的） */
export interface QuarkDetailItem {
  fid: string;
  file_name?: string;
  pdir_fid?: string;
  dir?: boolean;
  size?: number;
  share_fid_token?: string;
  format_type?: string;
  file_type?: number;
  category?: number;
  created_at?: number;
  updated_at?: number;
  /** 子目录元素数（目录有值时用于展示） */
  include_items?: number;
}

/** download 接口响应元素 */
export interface QuarkDownloadItem {
  download_url?: string;
  preview_url?: string;
  file_name?: string;
  size?: number;
  md5?: string;
}

/**
 * 隐秘参数按钮弹窗的夸克话术（v1.1.7 同类，静态资源）。
 * 说明 detail 接口返回结构里的重要字段。
 */
export const QUARK_HIDDEN_VOLUMN_TEXT = `顺序自上而下，已过滤顾名思义的 key，下面只展示重要的
结构
{
  status, code, message, timestamp
  data {
    is_owner, share, list[]
  }
  metadata {
    _total, _count, _page, _size
  }
}

在 list[num]
- fid：文件 or 文件夹的身份，jumper 也使用这个发动二次 scan
- pdir_fid：父目录（一个文件夹）的 fid，scanner 的 list 功能依赖这个
- share_fid_token：文件处于分享状态的证明，prase（download 接口）必带
- format_type：文件格式；file_type：0=目录 1=文件
- include_items：目录内元素数（目录有值时）
- l_created_at / l_updated_at：分享者账号侧时间；created_at / updated_at：分享侧

在 metadata
- _total / _count / _page / _size 分页数据（根目录需 _fetch_banner=1&_fetch_share=1 才返回）`;
