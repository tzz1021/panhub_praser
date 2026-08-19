/**
 * PanAdapter 接口 —— 网盘适配层统一契约（docs/STRUCTURE.md：src/adapters/types.ts）
 *
 * 设计约束（HANDOFF §4）：
 * - UI 永不 import 具体适配器，只走 registry + PanAdapter 接口
 * - core/ 零网盘依赖：treeWalker/linkFetcher 只操作本接口
 * - 所有方法签名显式、TS strict 可编译；新增网盘按 src/adapters/README.md 接入
 *
 * 命名：kebab-case 文件、camelCase 字段/方法。
 */

/** 分享链接解析出的分享 ID（UC 的 pwd_id） */
export type ShareId = string;

/** 分享访问令牌（UC 的 stoken），后续接口都要携带 */
export type Stoken = string;

/** 网盘文件/目录条目（对应 UC detail 接口 list[] 元素） */
export interface ShareFile {
  /** 文件/目录 ID（下载、遍历子目录用） */
  fid: string;
  /** 文件名 */
  fileName: string;
  /** 是否为目录 */
  dir: boolean;
  /** 大小（字节）；目录为 0 */
  size: number;
  /** 分享文件令牌（文件必带，下载用；目录无） */
  shareFidToken?: string;
  /** 格式（application/zip 等） */
  formatType?: string;
  /** 修改时间戳（ms，网盘支持时提供） */
  modifiedAt?: number;
  /** 标识符（md5/sha1，网盘支持时提供） */
  md5?: string;
  sha1?: string;
}

/** 获取分享令牌参数（UC：POST sharepage/token） */
export interface TokenParams {
  /** 分享 ID（pwd_id） */
  shareId: ShareId;
  /** 提取码；无提取码时传空字符串 */
  passcode?: string;
}

/** 获取分享令牌结果 */
export interface TokenResult {
  stoken: Stoken;
}

/** 列目录参数（UC：GET sharepage/detail，pdir_fid 递归即目录遍历） */
export interface ListParams {
  shareId: ShareId;
  stoken: Stoken;
  /** 父目录 fid；根目录用 "0" */
  pdirFid: string;
  /** 页码，默认 1 */
  page?: number;
  /** 每页数量，默认 50 */
  size?: number;
  /** 是否为根目录（UC 根目录需带 _fetch_banner/_fetch_share 扩展字段） */
  isRoot?: boolean;
}

/** 列目录结果 */
export interface ListResult {
  files: ShareFile[];
  /** 总数（网盘返回时提供） */
  total?: number;
}

/** 批量取直链参数（UC：POST file/download?entry=ft&fr=pc&pr=UCBrowser） */
export interface DownloadParams {
  shareId: ShareId;
  stoken: Stoken;
  /** 文件 ID 列表 */
  fids: string[];
  /** 与 fids 一一对应的分享文件令牌 */
  fidsTokens: string[];
}

/** 单文件直链结果 */
export interface DownloadResult {
  /** OSS 签名直链（字符敏感，复制必须走原生剪贴板 API） */
  url: string;
  fileName?: string;
  size?: number;
  md5?: string;
  /**
   * 与该直链**同响应绑定**的下载凭据（§12 实测：跨响应/跨环境混用一律
   * 403 ucidMd5 invalid）。UC = 本次 download 响应 Set-Cookie 下发的 __pugs。
   * 缺省（响应未下发/直连拿不到）= 导出时该文件命令不注入 cookie 并附提示。
   */
  cookie?: { key: string; value: string };
}

/**
 * 网盘特性表（偏好设置 UAC 表数据源，见 HANDOFF 附件「1.UAC选项」）
 * 各字段默认值按「不误导用户」原则：v1 UC 零 cookie，needsCookie 默认 false。
 */
export interface PanLimits {
  /** 是否需要转存才能操作 */
  needsTransfer: boolean;
  /** 是否需要登录（游客可用的网盘此项 false） */
  needsLogin: boolean;
  /** 登录阈值说明（如夸克 "200mb+才需要"） */
  loginThresholdNote?: string;
  /** 能否移除限速 */
  canRemoveSpeedLimit: boolean;
  /** 是否需要读取 cookie（默认 false；v1 UC API 零 cookie） */
  needsCookie: boolean;
  /** 完全不需要登录 */
  noLoginNeeded: boolean;
  /** 批量解析是否仅支持 aria2/gopeed（跨文件夹批量时） */
  batchOnlyAriaGopeed: boolean;
  /** 游客大小限制说明（如 UC "4G 文件都不需要，临界未知"） */
  sizeLimitNote?: string;
  /** oss/sig 较小有效期说明（如 UC "直链 3-6h/Cookie 3h；未知不填显示 —） */
  linkExpiryNote?: string;
}

/**
 * 网盘适配器统一接口（detect / token / tree / download / limits）
 *
 * 「tree」由 core/treeWalker 调用本接口的 list() 递归完成（深度/并发/聚合归 core），
 * 适配器只负责单层目录列表 —— 与 STRUCTURE.md 职责划分一致。
 */
/** 网盘下载层需要的 cookie 规格（reverse-notes-uc.md §10；null/缺省 = 不需要） */
export interface CookieRequirement {
  /** cookie 名（如 "__pugs"） */
  key: string;
  /** 展示名（如 "双下划线pugs"） */
  displayName: string;
  /** 未捕获到值时的供应商专属排查话术 */
  missingHint: string;
  /** 标准长度（v1.1.5：弹窗展示「标准长度 xxx」供用户核对；未知可不填） */
  standardLength?: number;
}

export interface PanAdapter {
  /** 唯一标识（kebab-case，如 "uc"） */
  readonly id: string;
  /** 展示名（如 "UC 网盘"） */
  readonly name: string;
  /** 网盘特性表 */
  readonly limits: PanLimits;
  /** 该网盘是否识别此分享链接 */
  detect(url: string): boolean;
  /** 下载层 cookie 规格（UC 需要 __pugs；无 = 不需要 cookie） */
  readonly cookie?: CookieRequirement;
  /** 从分享链接提取分享 ID；无法识别返回 null */
  parseShareId(url: string): ShareId | null;
  /**
   * 0B 文件夹跳转链接（v1.1.6）：fid 链 → 分享页跳转长链接；不支持返回 null。
   * 风控集群导致目录树拉取失败时，用它二次获取该文件夹的资源列表。
   */
  buildJumpUrl?(shareId: ShareId, segments: Array<{ fid: string; name: string }>): string | null;
  /** 解析跳转长链接：返回 shareId + fid 链；非跳转链接返回 null */
  parseJumpUrl?(url: string): { shareId: ShareId; segments: Array<{ fid: string; name: string }> } | null;
  /** 获取分享访问令牌（token 三连第一步） */
  getToken(params: TokenParams): Promise<TokenResult>;
  /** 获取单层目录/文件列表（目录遍历由 core/treeWalker 递归调用） */
  list(params: ListParams): Promise<ListResult>;
  /** 批量获取下载直链（core/linkFetcher 按 15 个/批 + 1s 节流调用） */
  getDownloadLinks(params: DownloadParams): Promise<DownloadResult[]>;
}
