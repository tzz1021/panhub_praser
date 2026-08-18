/**
 * UC 网盘适配器（docs/STRUCTURE.md：src/adapters/uc.ts）
 *
 * 实现依据：docs/reverse-notes-uc.md（纯 requests + Chromium CDP 双验证，2026-08-12 完工版）
 * 接口契约：src/adapters/types.ts（PanAdapter）
 *
 * 逆向结论（改动前必读，勿凭感觉改）：
 * - API 三连全部零 cookie：token → detail（pdir_fid 递归 = 目录遍历）→ download
 * - download 必带 `?entry=ft&fr=pc&pr=UCBrowser`，漏一个直接 401 加密串
 * - 直链是 OSS 签名 URL，字符敏感：本层原样透传，不做任何 encode/decode/截断
 * - 批量节流（15 个/批 + 1s 间隔）归 core/linkFetcher 管，本文件单次调用只发一批
 * - 错误码 → 中文文案见 ERROR_MESSAGES，与 reverse-notes §4 一一对应
 */
import type {
  DownloadParams,
  DownloadResult,
  ListParams,
  ListResult,
  PanAdapter,
  PanLimits,
  ShareFile,
  ShareId,
  TokenParams,
  TokenResult,
} from './types';
import { getActiveTransport, TransportError, type TransportResponse } from '../core/transport/types';
import { capturePugsFromHeaders } from './ucPugs';

/**
 * 最近一次 UC 响应的 __pugs（§12 同响应绑定）：
 * 每次 getDownloadLinks 调用前重置，若该次响应用 x-pugs 回传了值，
 * 则绑定到该次返回的每一个 DownloadResult；否则不带 cookie（导出时提示）。
 * 注意：这是“响应级”绑定，不是全局令牌 —— 跨响应混用必然 403。
 */
let lastResponsePugs: string | null = null;

/** UC 分享 ID 形如 https://drive.uc.cn/s/dd2ad2345e124 或 /share/xxx */
const SHARE_URL_RE = /^https?:\/\/(?:[a-z0-9-]+\.)*uc\.cn\/(?:s|share)\/([A-Za-z0-9_-]+)/i;

/** API 前缀（reverse-notes §2） */
const API_BASE = 'https://pc-api.uc.cn/1/clouddrive';
/** token/detail 通用参数 */
const PC_QUERY = 'pr=UCBrowser&fr=pc';
/** download 必带参数，缺一个即 401（reverse-notes §2.3 / §3.1，踩坑最大） */
const DL_QUERY = 'entry=ft&fr=pc&pr=UCBrowser';

/**
 * UC 网盘特性表（偏好设置 UAC 表数据源，与 reverse-notes §3/§10 一致）：
 * - 游客可直接解析；下载层需要 __pugs 人机校验 cookie（游客态即可，§10.1）
 * - 直链可加速（UC 不限速）；23018 超限临界值未知，标注“临界未知”
 */
const UC_LIMITS: PanLimits = {
  needsTransfer: false,
  needsLogin: false,
  canRemoveSpeedLimit: true,
  needsCookie: true, // 下载层需要 __pugs（§10：游客态 cookie，非登录态）
  noLoginNeeded: true,
  batchOnlyAriaGopeed: false,
  sizeLimitNote: '4G 文件都不需要，临界未知',
  linkExpiryNote: '直链 3-6h/Cookie 3h',
};

/** 错误码 → 中文文案（reverse-notes §4 错误码映射表） */
const ERROR_MESSAGES: Record<number, string> = {
  31001: '请先登录网盘（分享者或访问者要求）',
  23018: '超出游客可获取大小限制，请登录后获取',
  14001: '分享 ID 或 stoken 无效，请刷新重试',
  41020: '文件令牌失效，请重新解析',
  15000: '服务暂时不可用，请稍后重试',
};

/**
 * UC 接口错误（携带 code 供 core/errors 分类；文案已是最终中文，可直接展示）
 */
export class UcApiError extends Error {
  readonly code: number | string;

  constructor(code: number | string, message: string) {
    super(message);
    this.name = 'UcApiError';
    this.code = code;
  }
}

/** 抛错误码对应文案；无映射时用 fallback 兜底 */
function fail(code: number | string, fallback?: string): never {
  const message =
    typeof code === 'number'
      ? ERROR_MESSAGES[code] ?? fallback ?? `UC 接口错误（code: ${code}）`
      : fallback ?? `UC 接口错误（${String(code)}）`;
  throw new UcApiError(code, message);
}

/**
 * UC API 请求封装：经传输层（core/transport，1.1）→ HTTP 状态检查 → JSON 解析 → code 业务码检查
 * 成功约定：`{ code: 0, data: T }`（与 LinkSwift 判断 `res.code !== 0` 一致）
 * 返回 `{ data, metadata }`：metadata 为顶层兄弟节点（如 detail 的 _total），可选用
 * @param step 阶段名（如"获取分享令牌"），错误信息带上前缀 → debug 日志可定位到具体 API（1.0.3）
 */
async function request<T, M = unknown>(
  url: string,
  init?: RequestInit,
  step = 'UC 接口',
): Promise<{ data: T; metadata?: M }> {
  let res: TransportResponse;
  try {
    res = await getActiveTransport().request({
      url,
      method: init?.method as 'GET' | 'POST' | undefined,
      headers: init?.headers as Record<string, string> | undefined,
      body: init?.body as string | undefined,
    });
  } catch (err) {
    // 传输层错误：直连被 CORS 拦 / 代理不可达，给出可执行提示
    if (err instanceof TransportError) {
      if (err.kind === 'cors') {
        const hint =
          typeof window !== 'undefined' && !/drive\.uc\.cn$/i.test(window.location.hostname)
            ? '；非 drive.uc.cn 域直连被 CORS 拦截，请在设置中填写代理地址，或通过书签在网盘分享页使用'
            : '';
        throw new Error(`网络请求失败（${step}）：${err.message}${hint}`);
      }
      throw new Error(`网络请求失败（${step}）：${err.message}`);
    }
    throw err instanceof Error ? err : new Error(`网络请求失败（${step}）：${String(err)}`);
  }
  // §10.2/§12 代理捕获通道：UC 响应 Set-Cookie 下发的 __pugs 经代理回传为 x-pugs；
  // 这里收口落库（全局，供弹窗展示）并记录响应级值（供同响应绑定）
  const pugs = capturePugsFromHeaders(res.headers);
  if (pugs) {
    lastResponsePugs = pugs;
  }
  if (res.status === 401) {
    fail(401, '请检查请求参数完整性（entry 参数缺失或触发风控）');
  }
  if (res.status < 200 || res.status >= 300) {
    fail(res.status, `UC 接口 HTTP ${res.status}`);
  }
  let body: { code?: number; message?: string; data?: T; metadata?: M } | null = null;
  try {
    body = JSON.parse(res.body) as { code?: number; message?: string; data?: T; metadata?: M };
  } catch {
    fail('invalid-json', 'UC 接口返回异常（非 JSON），请稍后重试');
  }
  if (!body) {
    fail('empty-response', 'UC 接口返回为空，请稍后重试');
  }
  if (body.code !== 0 || body.data === undefined) {
    fail(body.code ?? 'unknown-code', body.message);
  }
  return { data: body.data, metadata: body.metadata };
}

/** detail 接口 list[] 原始元素（字段名来自真实抓包 uc_detail_sample.json） */
interface UcDetailItem {
  fid: string;
  file_name?: string;
  dir?: boolean;
  size?: number;
  share_fid_token?: string;
  format_type?: string;
  created_at?: number;
  updated_at?: number;
}

/** 原始字段 → 接口 ShareFile（snake_case → camelCase） */
function toShareFile(item: UcDetailItem): ShareFile {
  return {
    fid: item.fid,
    fileName: item.file_name ?? '',
    dir: Boolean(item.dir),
    size: item.size ?? 0,
    shareFidToken: item.share_fid_token,
    formatType: item.format_type,
    modifiedAt: item.updated_at ?? item.created_at,
  };
}

/** 第 1 步：获取分享访问令牌 stoken（reverse-notes §2.1） */
async function getToken(params: TokenParams): Promise<TokenResult> {
  const { data } = await request<{ stoken?: string }>(
    `${API_BASE}/share/sharepage/token?${PC_QUERY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pwd_id: params.shareId,
        passcode: params.passcode ?? '',
      }),
    },
    '获取分享令牌',
  );
  if (!data?.stoken) {
    fail('no-stoken', '获取分享令牌失败，分享可能已失效');
  }
  return { stoken: data.stoken };
}

/** 第 2 步：单层目录/文件列表（reverse-notes §2.2；目录遍历由 core/treeWalker 递归调用） */
async function list(params: ListParams): Promise<ListResult> {
  const query = new URLSearchParams({
    pwd_id: params.shareId,
    stoken: params.stoken,
    pdir_fid: params.pdirFid, // 根目录传 "0"
    force: '0',
    _page: String(params.page ?? 1),
    _size: String(params.size ?? 50),
    _fetch_banner: params.isRoot ? '1' : '0', // 根目录 1，子目录 0
    _fetch_share: params.isRoot ? '1' : '0',
    _fetch_total: '1',
    _sort: '',
    pr: 'UCBrowser',
    fr: 'pc',
  });
  const { data, metadata } = await request<
    { list?: UcDetailItem[] },
    { _total?: number; _count?: number }
  >(`${API_BASE}/share/sharepage/detail?${query.toString()}`, {
    headers: { 'Content-Type': 'application/json' },
  }, '获取目录列表');
  return {
    files: (data.list ?? []).map(toShareFile),
    total: metadata?._total,
  };
}

/** 第 3 步：批量获取下载直链（reverse-notes §2.3；每次调用 = 一批，节流归 linkFetcher） */
async function getDownloadLinks(params: DownloadParams): Promise<DownloadResult[]> {
  if (params.fids.length === 0) {
    return [];
  }
  if (params.fids.length !== params.fidsTokens.length) {
    throw new Error('fids 与 fidsTokens 数量不一致（适配层调用错误）');
  }
  // §12 同响应绑定：本次调用开始时重置，只有本次响应的 __pugs 才能配本次的直链
  lastResponsePugs = null;
  const { data } = await request<
    Array<{ download_url?: string; file_name?: string; size?: number; md5?: string }>
  >(`${API_BASE}/file/download?${DL_QUERY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fids: params.fids,
      fids_token: params.fidsTokens,
      pwd_id: params.shareId,
      stoken: params.stoken,
    }),
  }, '获取下载直链');
  // 同响应 pugs（无则不带 cookie，导出命令会附提示）
  const cookie = lastResponsePugs ? { key: '__pugs' as const, value: lastResponsePugs } : undefined;
  return data.map((item) => {
    if (!item.download_url) {
      fail('no-download-url', '下载接口未返回直链，请重试');
    }
    return {
      url: item.download_url, // OSS 签名 URL，原样透传，禁止任何加工
      fileName: item.file_name,
      size: item.size,
      md5: item.md5,
      cookie, // §12：每文件携带与其直链同响应的 __pugs
    };
  });
}

/** 分享链接识别（drive.uc.cn/s/<pwd_id> 或 /share/<pwd_id>） */
function detect(url: string): boolean {
  return SHARE_URL_RE.test(url);
}

/** 提取分享 ID；无法识别返回 null */
function parseShareId(url: string): ShareId | null {
  return SHARE_URL_RE.exec(url)?.[1] ?? null;
}

/** UC 适配器实例（注册进 registry 后即启用，UI 侧无需改动） */
export const ucAdapter: PanAdapter = {
  id: 'uc',
  name: 'UC 网盘',
  limits: UC_LIMITS,
  cookie: {
    key: '__pugs',
    displayName: '双下划线pugs',
    standardLength: 208, // reverse-notes-uc.md §11.4 实测长度，弹窗核对用（v1.1.5）
    missingHint: '没有请检查你的杂鱼浏览器是不是开启了cookie存储限制或者无痕模式，开发者请检查插件比如AdGuard可能会拦截标签页开启',
  },
  detect,
  parseShareId,
  getToken,
  list,
  getDownloadLinks,
};
