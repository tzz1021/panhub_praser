/**
 * 夸克网盘扫描器（docs/STRUCTURE.md：src/adapters/quark/scanner.ts）
 *
 * 负责 token / detail / download 三个 API 步骤（"scanner" = 获取资源列表的能力）。
 * 实现依据：docs/reverse-notes-quark.md（2026-08-23 真机实测，分享链接）
 * 接口契约：src/adapters/types.ts（PanAdapter）
 *
 * 逆向结论（改动前必读，勿凭感觉改）：
 * - scanner 三连全部零 cookie（游客可读目录树）：token → detail（pdir_fid 递归）→ download
 * - detail 根目录必须 _fetch_banner=1&_fetch_share=1，否则 metadata（_total）不返回，
 *   treeWalker 会当成单页截断（>50 文件的目录树不完整）
 * - download 必带 `?entry=ft&fr=pc&pr=ucpro`；响应 Set-Cookie 下发 __pugs（3h，
 *   Domain=quark.cn）—— 直链**必须**带同响应 __pugs，否则 CDN 412（Tengine precondition）
 * - 大文件（>50MB 实测区间）download 返回 HTTP 400 + code 23018 size limit，
 *   需要登录态 cookie（整串，用户弹窗粘贴）后重试
 * - 直链是签名 URL（auth_key 6h），字符敏感：本层原样透传，不做任何加工
 * - 批量节流（15 个/批 + 1s 间隔）归 core/linkFetcher 管，本文件单次调用只发一批
 */
import type {
  DownloadParams,
  DownloadResult,
  ListParams,
  ListResult,
  ShareFile,
  TokenParams,
  TokenResult,
} from '../types';
import { getActiveTransport, TransportError, type TransportResponse } from '../../core/transport/types';
import {
  capturePugsFromHeaders,
  cookieValueOf,
  getQuarkCookieString,
  mergeQuarkSetCookies,
  setQuarkCookieString,
} from './cookies';
import { API_BASE, DL_QUERY, ERROR_MESSAGES, PC_QUERY, QUARK_DL_UA, QUARK_LOGIN_SIZE, type QuarkDetailItem, type QuarkDownloadItem } from './types';

/**
 * 最近一次夸克响应的 __pugs（§12 同响应绑定，与 UC 同一机制）：
 * 每次 getDownloadLinks 调用前重置，若该次响应用 x-pugs 回传了值，
 * 则绑定到该次返回的每一个 DownloadResult。
 */
let lastResponsePugs: string | null = null;

/** 夸克接口错误（携带 code 供 core/errors 分类；文案已是最终中文，可直接展示） */
export class QuarkApiError extends Error {
  readonly code: number | string;

  constructor(code: number | string, message: string) {
    super(message);
    this.name = 'QuarkApiError';
    this.code = code;
  }
}

/** 抛错误码对应文案；无映射时用 fallback 兜底 */
function fail(code: number | string, fallback?: string): never {
  const message =
    typeof code === 'number'
      ? ERROR_MESSAGES[code] ?? fallback ?? `夸克接口错误（code: ${code}）`
      : fallback ?? `夸克接口错误（${String(code)}）`;
  throw new QuarkApiError(code, message);
}

/**
 * 夸克 API 请求封装：经传输层 → 响应解析（**先解析 JSON body 取业务码**）。
 * 与 UC 不同：夸克业务错误（23018/41020/31001）走 HTTP 400/403 + JSON body，
 * 必须优先读 body 里的 code，否则只看到 HTTP 400 丢失分类。
 * 成功约定：`{ code: 0, data: T }`；返回 { data, metadata }（metadata 为顶层兄弟节点）。
 */
async function request<T, M = unknown>(
  url: string,
  init?: RequestInit,
  step = '夸克接口',
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
    if (err instanceof TransportError) {
      if (err.kind === 'cors') {
        const hint =
          typeof window !== 'undefined' && !/pan\.quark\.cn$/i.test(window.location.hostname)
            ? '；非 pan.quark.cn 域直连被 CORS 拦截，请在设置中填写代理地址，或通过书签在网盘分享页使用'
            : '';
        throw new Error(`网络请求失败（${step}）：${err.message}${hint}`);
      }
      throw new Error(`网络请求失败（${step}）：${err.message}`);
    }
    throw err instanceof Error ? err : new Error(`网络请求失败（${step}）：${String(err)}`);
  }
  // §12 代理捕获通道：夸克响应 Set-Cookie 下发的 __pugs 经代理回传为 x-pugs（与 UC 同键）
  const pugs = capturePugsFromHeaders(res.headers);
  if (pugs) {
    lastResponsePugs = pugs;
  }
  // v1.1.9.1：登录态 __pus/__puus 服务端会定期刷新（__puus 3h 会话）——
  // 代理回传 x-quark-pus/x-quark-puus，这里自动合并回本地整串（alist 同款）
  if (res.headers['x-quark-pus'] || res.headers['x-quark-puus']) {
    const merged = mergeQuarkSetCookies(getQuarkCookieString(), res.headers);
    if (merged !== getQuarkCookieString()) setQuarkCookieString(merged);
  }
  // 先解析 body（业务错误码在 JSON 里，HTTP 状态只是外壳）
  let body: { code?: number | string; message?: string; data?: T; metadata?: M } | null = null;
  try {
    body = JSON.parse(res.body) as { code?: number | string; message?: string; data?: T; metadata?: M };
  } catch {
    body = null;
  }
  // 业务码优先：code 非 0（含 HTTP 400/403 壳内的 23018/41020/31001）
  if (body && typeof body.code === 'number' && body.code !== 0) {
    fail(body.code, body.message);
  }
  if (res.status < 200 || res.status >= 300) {
    fail(res.status, body?.message ?? (res.body?.trim() ? res.body.slice(0, 120) : `夸克接口 HTTP ${res.status}`));
  }
  if (!body || body.data === undefined) {
    fail('empty-response', body?.message ?? '夸克接口返回异常（非 JSON 或为空），请稍后重试');
  }
  return { data: body.data, metadata: body.metadata };
}

/** 原始字段 → 接口 ShareFile（snake_case → camelCase） */
function toShareFile(item: QuarkDetailItem): ShareFile {
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

/** 第 1 步：获取分享访问令牌 stoken（reverse-notes-quark §2.1；与 UC 同构） */
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

/**
 * 构造 detail 接口查询 URL（v1.1.7 隐秘参数：浏览器直连官方 API，不经过代理）。
 * @param pdirFid 目标文件夹 fid（根目录 "0"）
 */
export function buildDetailUrl(shareId: string, stoken: string, pdirFid: string): string {
  const query = new URLSearchParams({
    pr: 'ucpro',
    fr: 'pc',
    uc_param_str: '',
    ver: '2',
    pwd_id: shareId,
    stoken,
    pdir_fid: pdirFid,
    force: '0',
    _page: '1',
    _size: '50',
    _fetch_banner: pdirFid === '0' ? '1' : '0',
    _fetch_share: pdirFid === '0' ? '1' : '0',
    fetch_relate_conversation: '0',
    _fetch_total: '1',
    _sort: 'file_type:asc,file_name:asc',
  });
  return `${API_BASE}/share/sharepage/detail?${query.toString()}`;
}

/** v1.1.7 隐秘参数：构造官方 API 查询 URL（浏览器直连，不走代理） */
export function buildHiddenVolumnUrl(params: { shareId: string; stoken: string; pdirFid: string }): string {
  return buildDetailUrl(params.shareId, params.stoken, params.pdirFid);
}

/** 第 2 步：单层目录/文件列表（reverse-notes-quark §2.2；目录遍历由 core/treeWalker 递归调用）
 *
 * 夸克分享根有包装层：pdir_fid=0 返回分享文件夹本身（分享标题），网页端是从
 * 文件夹**内容**开始展示的。因此根目录且只返回 1 个目录时自动下钻一层（等价网页视图，
 * 避免目录树多出一层“分享标题”）；多条目/单文件根保持原样。
 */
async function list(params: ListParams): Promise<ListResult> {
  const fetchOnce = async (pdirFid: string, isRoot: boolean): Promise<ListResult> => {
    const query = new URLSearchParams({
      pr: 'ucpro',
      fr: 'pc',
      uc_param_str: '',
      ver: '2',
      pwd_id: params.shareId,
      stoken: params.stoken,
      pdir_fid: pdirFid, // 根目录传 "0"
      force: '0',
      _page: String(params.page ?? 1),
      _size: String(params.size ?? 50),
      // v1.1.9 实测：根目录不带这两个 metadata（_total）不返回，treeWalker 分页会截断
      _fetch_banner: isRoot ? '1' : '0',
      _fetch_share: isRoot ? '1' : '0',
      fetch_relate_conversation: '0',
      _fetch_total: '1',
      _sort: 'file_type:asc,file_name:asc',
    });
    const { data, metadata } = await request<
      { list?: QuarkDetailItem[] },
      { _total?: number; _count?: number }
    >(`${API_BASE}/share/sharepage/detail?${query.toString()}`, {
      headers: { 'Content-Type': 'application/json' },
    }, '获取目录列表');
    return {
      files: (data.list ?? []).map(toShareFile),
      total: metadata?._total,
    };
  };

  let res = await fetchOnce(params.pdirFid, Boolean(params.isRoot));
  // 根包装层下钻：根目录 && 单条目 && 是目录 → 直接返回其内容（网页等价视图）
  if (params.isRoot && res.files.length === 1 && res.files[0].dir) {
    res = await fetchOnce(res.files[0].fid, false);
  }
  return res;
}

/** 第 3 步：批量获取下载直链（reverse-notes-quark §2.3；每次调用 = 一批，节流归 linkFetcher） */
async function getDownloadLinks(params: DownloadParams): Promise<DownloadResult[]> {
  if (params.fids.length === 0) {
    return [];
  }
  if (params.fids.length !== params.fidsTokens.length) {
    throw new Error('fids 与 fidsTokens 数量不一致（适配层调用错误）');
  }
  // §12 同响应绑定：本次调用开始时重置，只有本次响应的 __pugs 才能配本次的直链
  lastResponsePugs = null;
  // 登录态 cookie（用户弹窗提供整串，v1.1.9.1）：有则随 download 请求发送（>50MB 文件必需，23018 时必填）
  const loginCookie = getQuarkCookieString();
  const { data } = await request<QuarkDownloadItem[]>(
    `${API_BASE}/file/download?${DL_QUERY}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // v1.1.9.final：夸克 download 校验 Electron 客户端 UA（非定制 UA → 401 unsafe-url 风控），
        // 与 linkswift 同款；浏览器禁改 User-Agent，经代理 JSON body 透传后在服务端注入（direct 模式无效）
        'User-Agent': QUARK_DL_UA,
        ...(loginCookie ? { Cookie: loginCookie } : {}),
      },
      body: JSON.stringify({
        fids: params.fids,
        fids_token: params.fidsTokens,
        pwd_id: params.shareId,
        stoken: params.stoken,
      }),
    },
    '获取下载直链',
  );
  // 同响应 pugs（无则不带 cookie，导出命令会附提示）
  const pugs = lastResponsePugs;
  return data.map((item) => {
    if (!item.download_url) {
      fail('no-download-url', '下载接口未返回直链，请重试');
    }
    const result: DownloadResult = {
      url: item.download_url, // 签名 URL，原样透传，禁止任何加工
      fileName: item.file_name,
      size: item.size,
      hash: item.md5, // 夸克 dl 响应给 md5（v1.1.9.final：字段通用化 hash，导出注释行校验下载完整性）
    };
    // v1.1.9.final：凭据按文件大小分流 ——
    // 大文件（≥50MB，登录态）：oss 校验令牌**只有 __puus**；绝不返回完整登录 cookie
    //   （导出文件可能被分享/上传，整串泄露即账号被盗风险）；__pus 是长期凭证更不可出。
    // 小文件（游客态）：与 UC 同机制，绑定同响应 __pugs 即可。
    const isBig = (item.size ?? 0) >= QUARK_LOGIN_SIZE;
    if (isBig) {
      const puus = cookieValueOf(loginCookie, '__puus');
      if (puus) {
        result.cookieString = `__puus=${puus}`;
        result.cookie = { key: '__puus', value: puus };
      }
    } else if (pugs) {
      result.cookieString = `__pugs=${pugs}`;
      result.cookie = { key: '__pugs', value: pugs };
    }
    return result;
  });
}

/** scanner 能力集合（registry.ts 组装成完整 PanAdapter） */
export const quarkScanner = {
  getToken,
  list,
  getDownloadLinks,
};
