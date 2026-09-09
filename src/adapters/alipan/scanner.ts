/**
 * 阿里云盘扫描器（docs/STRUCTURE.md：src/adapters/alipan/scanner.ts，v1.2.x 初稿）
 *
 * 负责 scan（get_share_token / list_by_share）与 prase（两跳：转存 /file/copy → 取直链
 * /v2/file/get_download_url）三阶段。
 * 实现依据：/home/user/.openclaw/workspace/alipan-share/ 真机实测（2026-09，repro.mjs 全链路
 * ✅：share_token → 转存 201 新 file_id → get_download_url 200 → 直链；step1.mjs 对照最小头）
 * 接口契约：src/adapters/types.ts（PanAdapter）
 *
 * 逆向结论（改动前必读，勿凭感觉改）：
 * - scan 三接口（get_share_token / get_by_share / list_by_share）全部免登录、免 UA/device，
 *   仅需 content-type；share_token（2h）走 x-share-token 头（= 接口 stoken 语义）
 * - list_by_share 是 **next_marker 游标分页**（非页码制）；parent_file_id='root' 为分享根。
 *   游标续页经 ListParams.marker/ListResult.nextMarker 与 core/treeWalker 打通（新增契约，uc/quark 不受影响）
 * - 分享根有包装层：root 直列通常只有 1 个文件夹节点（= 分享锚点，网页端从它**内容**开始展示）
 *   → 与夸克同款「根包装层自动下钻」（单目录 && 无翻页时把它的内容提升为根视图）
 * - prase = 两跳，**无游客通道**：① POST /adrive/v4/batch + /file/copy 转存到自己网盘
 *   （headers：x-share-token 源授权 + Authorization 登录态；requests 支持数组批量，内层 status 201）
 *   ② 对转存后的新 file_id 打 get_download_url（headers：Authorization + x-canary 客户端段）
 * - 登录用户也不能直下他人分享文件（实测 403 ForbiddenNoPermission），必须先转存；
 *   转存目标目录（to_parent_file_id）与登录 token（auth=Bearer xxx）由用户凭据串提供
 * - 直链是 OSS 预签名 URL：下载必须带精确 `Referer: https://www.alipan.com/`（其他值 403、缺失 400），
 *   本层只取 URL 不碰下载层；导出命令头支持见交付摘要「待验证/开放问题」
 *
 * 与夸克刻意不同（交付要求，勿照抄）：
 * - 无 isbig 大小分级 / 无游客账号自动创建 / 无 cookie 轮转 —— alipan 完全拒绝游客 prase
 * - 无下载层 cookie（__pugs/__puus 类）捕获：直链凭据 = URL 自身签名 + 固定 Referer
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
import { getAlipanAuthString, parseAlipanAuthString, type AlipanAuth } from './auth';
import {
  ALIPAN_DEFAULT_UA,
  API_BASE,
  CANARY_ADRIVE,
  CT_JSON,
  ERROR_MESSAGES,
  type AlipanBatchResponse,
  type AlipanDownloadUrlResult,
  type AlipanShareItem,
  type AlipanShareTokenResult,
} from './types';

/** 阿里云盘接口错误（携带 code 供 core/errors 分类；message 已是最终中文，可直接展示） */
export class AlipanApiError extends Error {
  readonly code: number | string;

  constructor(code: number | string, message: string) {
    super(message);
    this.name = 'AlipanApiError';
    this.code = code;
  }
}

/** 抛错误码对应文案；无映射时用 fallback 兜底（alipan 错误码多为字符串，见 types.ts TODO） */
function fail(code: number | string, fallback?: string): never {
  const message =
    typeof code === 'string'
      ? ERROR_MESSAGES[code] ?? fallback ?? `阿里云盘接口错误（code: ${code}）`
      : fallback ?? `阿里云盘接口错误（code: ${code}）`;
  throw new AlipanApiError(code, message);
}

/** 200ms 节流 sleep（根包装层下钻的内部翻页用；treeWalker 正常翻页节流归 core） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * alipan API 请求封装：经传输层 POST → 统一 JSON 解析。
 * alipan 成功 = HTTP 200 + 业务 JSON（无 {code:0} 外壳）；错误 = 非 2xx + body {code, message}，
 * code 优先展示（字符串码查 ERROR_MESSAGES，其余用上游 message 兜底）。
 */
async function request<T>(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  step = '阿里云盘接口',
): Promise<T> {
  let res: TransportResponse;
  try {
    res = await getActiveTransport().request({
      url: `${API_BASE}${path}`,
      method: 'POST',
      headers: { 'content-type': CT_JSON, ...headers },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err instanceof TransportError) {
      if (err.kind === 'cors') {
        // 浏览器禁改 UA 且 alipan API 无 CORS 白名单：直连只在 alipan 官方域页面（书签注入）可行
        const hint =
          typeof window !== 'undefined' &&
          !/\.(?:alipan|aliyundrive)\.com$/i.test(window.location.hostname)
            ? '；非 alipan.com 域直连被 CORS 拦截，请在设置中填写代理地址，或通过书签在分享页使用'
            : '';
        throw new Error(`网络请求失败（${step}）：${err.message}${hint}`);
      }
      throw new Error(`网络请求失败（${step}）：${err.message}`);
    }
    throw err instanceof Error ? err : new Error(`网络请求失败（${step}）：${String(err)}`);
  }
  // 先解析 body（业务错误码在 JSON body 里，HTTP 状态只是外壳）
  let parsed: { code?: number | string; message?: string } | null = null;
  try {
    parsed = JSON.parse(res.body) as { code?: number | string; message?: string };
  } catch {
    parsed = null;
  }
  if (res.status < 200 || res.status >= 300) {
    fail(
      parsed?.code ?? res.status,
      parsed?.message ?? (res.body?.trim() ? res.body.slice(0, 120) : `阿里云盘接口 HTTP ${res.status}`),
    );
  }
  if (!parsed) {
    fail('bad-response', '阿里云盘接口返回异常（非 JSON 或为空），请稍后重试');
  }
  return parsed as T;
}

/** 原始字段 → 接口 ShareFile（alipan snake_case → camelCase） */
function toShareFile(item: AlipanShareItem): ShareFile {
  const dir = item.type !== 'file'; // 'folder'（或字段缺失）一律按目录
  return {
    fid: item.file_id,
    fileName: item.name ?? '',
    dir,
    size: item.size ?? 0,
    // 关键适配说明：alipan 没有 share_fid_token 字段 —— 这里借该字段存分享内 file_id，
    // 满足 core/linkFetcher「有令牌才发请求」的契约（linkFetcher 只做 truthy 判断）；
    // 适配器 prase 时实际用的是 params.fids + share_id，fidsTokens 被忽略。
    // TODO（开放问题）：更干净的做法是 core 契约不再要求文件令牌，等 Tzz 决策。
    shareFidToken: dir ? undefined : item.file_id,
    // 格式展示：短扩展名（mp4/zip…）优先，其次 mime 全称
    formatType: item.mime_extension ?? item.file_extension ?? item.mime_type,
    // alipan 时间戳是 ISO 字符串，转 ms
    modifiedAt: item.updated_at ? Date.parse(item.updated_at) || undefined : undefined,
  };
}

/** 第 1 步：获取分享访问令牌 share_token（2h；走 x-share-token 头） */
async function getToken(params: TokenParams): Promise<TokenResult> {
  const data = await request<AlipanShareTokenResult>(
    '/v2/share_link/get_share_token',
    { share_id: params.shareId, share_pwd: params.passcode ?? '' }, // 无密码分享场景留空（契约）
    {},
    '获取分享令牌',
  );
  if (!data?.share_token) {
    fail('no-share-token', '获取分享令牌失败，分享可能已失效');
  }
  return { stoken: data.share_token };
}

/** 单页 list_by_share 请求（parent_file_id 用 'root' 表示分享根；有 marker 则续页） */
async function fetchListPage(
  shareId: string,
  shareToken: string,
  parentFileId: string,
  limit: number,
  marker?: string,
): Promise<{ items: AlipanShareItem[]; nextMarker?: string }> {
  const body: Record<string, unknown> = {
    share_id: shareId,
    parent_file_id: parentFileId,
    limit,
    order_by: 'name',
    order_direction: 'DESC',
  };
  if (marker) body.marker = marker;
  const data = await request<{ items?: AlipanShareItem[]; next_marker?: string }>(
    '/adrive/v2/file/list_by_share',
    body,
    // scan 阶段免登录：仅需 x-share-token；UA/device/canary 均已实测可省（step1.mjs 对照）
    { 'x-share-token': shareToken },
    '获取目录列表',
  );
  return { items: data.items ?? [], nextMarker: data.next_marker };
}

/**
 * 第 2 步：单层目录/文件列表（目录遍历由 core/treeWalker 递归调用）。
 *
 * 分享根包装层处理（与夸克同款「自动下钻」）：isRoot 且第一页只有一个文件夹节点且无翻页
 * 时，视为「分享锚点文件夹」→ 把它**整棵内容**（内部翻页收齐）提升为根视图返回。
 * 其余情况走标准游标分页：每页返回 files + nextMarker，由 treeWalker 原样回传续页。
 */
async function list(params: ListParams): Promise<ListResult> {
  const shareId = params.shareId;
  const shareToken = params.stoken;
  const limit = params.size ?? 50;
  const rootMode = params.pdirFid === '0'; // UC 系约定：'0' = 分享根
  const parent = rootMode ? 'root' : params.pdirFid;

  // 根包装层下钻（仅 isRoot 首页、无游标时尝试；多锚点/大根列表保持原样走普通分页）
  if (params.isRoot && (params.page ?? 1) === 1 && !params.marker) {
    const first = await fetchListPage(shareId, shareToken, 'root', limit);
    const items = first.items;
    if (items.length === 1 && items[0].type === 'folder' && !first.nextMarker) {
      // 锚点文件夹内容可能 >50：内部翻页收齐（页间 250ms 节流 + 兜底上限，防风控/死循环）
      const anchor = items[0];
      const files: AlipanShareItem[] = [];
      let marker: string | undefined;
      let pages = 0;
      do {
        const page = await fetchListPage(shareId, shareToken, anchor.file_id, limit, marker);
        files.push(...page.items);
        marker = page.nextMarker;
        pages++;
        if (marker && pages < 200) await sleep(250);
      } while (marker && pages < 200);
      return { files: files.map(toShareFile), total: files.length };
    }
    return { files: items.map(toShareFile), nextMarker: first.nextMarker };
  }
  const page = await fetchListPage(shareId, shareToken, parent, limit, params.marker);
  return { files: page.items.map(toShareFile), nextMarker: page.nextMarker };
}

/**
 * 构造 prase 阶段的请求头（两跳共用）：
 * - content-type + Authorization（登录态，转存/取直链必需）
 * - user-agent：用户凭据串写了就用，否则默认 UA（"默认头只写 UA"，不默认加 x-device-id）
 * - x-device-id：仅当用户在凭据串里显式提供
 * - extra 按接口补：batch = x-share-token；get_download_url = x-canary（客户端段）
 * TODO（待验证 a/c）：UA/x-device-id/x-canary 在 batch 与 get_download_url 是否可省、
 * to_drive_id 是否必须显式 —— headtest.mjs 最小头矩阵未跑完（token 过期中断），当前按保守写上。
 */
function praseHeaders(auth: AlipanAuth, extra: Record<string, string> = {}): Record<string, string> {
  const bearer = auth.auth.startsWith('Bearer ') ? auth.auth : `Bearer ${auth.auth}`;
  const headers: Record<string, string> = {
    'content-type': CT_JSON,
    Authorization: bearer,
    'user-agent': auth.userAgent ?? ALIPAN_DEFAULT_UA,
  };
  if (auth.xDeviceId) headers['x-device-id'] = auth.xDeviceId;
  return { ...headers, ...extra };
}

/** 第 3 步：批量获取下载直链（prase 两跳；每次调用 = 一批，节流归 linkFetcher） */
async function getDownloadLinks(params: DownloadParams): Promise<DownloadResult[]> {
  if (params.fids.length === 0) {
    return [];
  }
  // 凭据唯一来源：用户凭据串（无游客通道）。缺 auth/目标目录 → 抛 need-login 哨兵码
  // （31001 复用夸克哨兵约定：ResultPage 据此弹登录态填写窗，见交付摘要开放问题）
  const authString = getAlipanAuthString();
  const auth = parseAlipanAuthString(authString);
  if (!auth.auth) {
    fail(31001, '阿里云盘解析需要登录态：请填写 auth（Bearer token）。分享文件必须先转存到你的网盘才能取直链（游客不可解析）');
  }
  if (!auth.toParentFileId) {
    fail(31001, '阿里云盘解析需要转存目标目录：请补 to_parent_file_id（你自己网盘里目标文件夹的 file_id）');
  }

  // ① 转存（一次 batch 数组批量；每个文件一个 /file/copy 请求，id 自编号、响应按序对应）
  // TODO（开放问题 d/幂等）：copy 文件夹节点 = 单次 copy（file_id 可为文件夹），UI 目前只对
  // file 节点 prase（与夸克一致）；重试会再次转存 → auto_rename 产生重复副本，去重方案待设计
  const batch = await request<AlipanBatchResponse>(
    '/adrive/v4/batch',
    {
      requests: params.fids.map((fileId, i) => ({
        body: {
          file_id: fileId,
          share_id: params.shareId,
          auto_rename: true,
          to_parent_file_id: auth.toParentFileId,
          // to_drive_id 是否必须显式未验证完（开放问题 b）—— 有则带，无则省略（服务端默认落自己盘）
          ...(auth.driveId ? { to_drive_id: auth.driveId } : {}),
        },
        headers: { 'Content-Type': 'application/json' },
        id: String(i),
        method: 'POST',
        url: '/file/copy',
      })),
      resource: 'file',
    },
    // batch 头：content-type + x-share-token（源授权）+ Authorization（登录态）
    // TODO（待验证 a）：x-canary/UA/device 是否可省未验证完 —— 需要时补 CANARY_ADRIVE
    praseHeaders(auth, { 'x-share-token': params.stoken }),
    '转存到自己的网盘',
  );
  const responses = batch.responses ?? [];
  // 响应按 id 对应（id = 字符串序号）；异常时回退按数组序
  const byId = (i: number) => responses.find((r) => r.id === String(i)) ?? responses[i];
  const copiedIds: string[] = [];
  for (let i = 0; i < params.fids.length; i++) {
    const inner = byId(i);
    const status = inner?.status;
    const fileId = inner?.body?.file_id;
    if (status !== 201 || !fileId) {
      // 内层失败：body 带 alipan code/message；整批失败（与夸克批语义一致）
      fail(
        inner?.body?.code ?? (status ?? 'copy-failed'),
        `第 ${i + 1} 个文件转存失败：${inner?.body?.message ?? `内层 status ${status ?? '未知'}`}`,
      );
    }
    copiedIds.push(fileId);
  }

  // ② 对每个转存后的新 file_id 取直链（逐发，防风控）
  // to_drive_id：优先用 copy 响应返回的 drive_id（实测即自己账号 drive_id，.repro.json 佐证），
  // 其次用户显式填的；都无则省略（开放问题 b/c：自动获取端点未定）
  const results: DownloadResult[] = [];
  for (let i = 0; i < copiedIds.length; i++) {
    const driveId = byId(i)?.body?.drive_id ?? auth.driveId;
    const body: Record<string, string> = { file_id: copiedIds[i] };
    if (driveId) body.drive_id = driveId;
    const dl = await request<AlipanDownloadUrlResult>(
      '/v2/file/get_download_url',
      body,
      // get_download_url 头：Authorization + x-canary 客户端段（契约必带值）
      praseHeaders(auth, { 'x-canary': CANARY_ADRIVE }),
      '获取下载直链',
    );
    if (!dl?.url) {
      fail('no-download-url', `第 ${i + 1} 个文件未返回直链，请重试`);
    }
    // OSS 预签名 URL 原样透传；文件名/大小以目录树为准（本接口不返回）
    results.push({ url: dl.url });
  }
  return results;
}

/** scanner 能力集合（registry.ts 组装成完整 PanAdapter） */
export const alipanScanner = {
  getToken,
  list,
  getDownloadLinks,
};
