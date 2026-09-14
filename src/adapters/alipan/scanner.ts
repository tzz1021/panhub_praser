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
import { ossUrlExpiryMs } from '../../utils/linkStatus';
import { getAlipanAuthString, parseAlipanAuthString, type AlipanAuth } from './auth';
import {
  alipanAccountKey,
  carriedTargetOf,
  isAlipanExpiredAuthCode,
  rememberAlipanCarriedFiles,
} from './carry';
import {
  ALIPAN_DEFAULT_UA,
  API_BASE,
  CANARY_ADRIVE,
  CANARY_SHARE,
  COPY_ERROR_MESSAGES,
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

/** 抛错误码对应文案；无映射时用 fallback 兜底（alipan 错误码多为字符串，见 types.ts）。
 * code 可能带 '.'（如 ForbiddenNoPermission.File），映射表键用 '_' 归一后二次查找。 */
function fail(code: number | string, fallback?: string): never {
  const key = typeof code === 'string' ? code.replace(/\./g, '_') : '';
  const message =
    typeof code === 'string'
      ? ERROR_MESSAGES[code] ?? (key ? COPY_ERROR_MESSAGES[key] ?? ERROR_MESSAGES[key] : undefined) ?? fallback ?? `阿里云盘接口错误（code: ${code}）`
      : fallback ?? `阿里云盘接口错误（code: ${code}）`;
  throw new AlipanApiError(code, message);
}

/** 错误码 → 中文（与 fail 同一归一规则；不抛错，供逐文件失败项用） */
function errorTextOf(code: number | string | undefined, fallback: string): string {
  if (typeof code !== 'string' || !code) return fallback;
  const key = code.replace(/\./g, '_');
  return ERROR_MESSAGES[code] ?? COPY_ERROR_MESSAGES[key] ?? ERROR_MESSAGES[key] ?? fallback;
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
    // v1.2.x 契约收窄后 alipan 不借 shareFidToken 存 file_id：core/linkFetcher 不再要求逐文件令牌，
    // 文件标识统一用 fid = file_id（uc/quark 才需要 shareFidToken，缺它=解析失败）。
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
 * - user-agent：用户凭据串写了就用，否则默认 UA（"默认头只写 UA 常量"，不默认加 x-device-id）
 * - x-device-id：仅当用户在凭据串里显式提供（UA/device 非必需，实测）
 * - extra 按接口补：batch = x-share-token + x-canary share 段（CANARY_SHARE）；
 *   get_download_url = x-canary 客户端段（CANARY_ADRIVE，实测成功组合）
 * 头部与传输层/代理白名单对齐：authorization / x-share-token / x-canary / x-device-id
 * 均在 proxy.js forwardHeaders 放行列表内（见 functions/api/proxy.js 头注释）。
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

/**
 * 单文件取直链（get_download_url）：成功返回 DownloadResult，失败返回带 error/errorCode 的结果。
 * 不抛错 —— 逐文件失败不阻断整批，由调用方按下标回填（core linkFetcher 原样透传）。
 */
async function fetchDownloadUrl(
  auth: AlipanAuth,
  fileId: string,
  driveId: string | undefined,
  index: number,
  file: ShareFile,
): Promise<DownloadResult> {
  const body: Record<string, string> = { file_id: fileId };
  if (driveId) body.drive_id = driveId;
  let dl: AlipanDownloadUrlResult;
  try {
    dl = await request<AlipanDownloadUrlResult>(
      '/v2/file/get_download_url',
      body,
      // get_download_url 头：Authorization + x-canary 客户端段（client=windows,app=adrive,v6.0.0，实测成功）
      praseHeaders(auth, { 'x-canary': CANARY_ADRIVE }),
      '获取下载直链',
    );
  } catch (err) {
    // 逐文件取直链失败（如 auth 过期 401 AccessTokenInvalid → 友好文案 + code 透传，UI 据此弹填写窗）
    return {
      url: '',
      error: err instanceof Error ? err.message : `第 ${index + 1} 个文件获取直链失败，请重试`,
      errorCode: err instanceof AlipanApiError ? err.code : 'download-url-failed',
    };
  }
  if (!dl?.url) {
    return { url: '', error: `第 ${index + 1} 个文件未返回直链，请重试`, errorCode: 'no-download-url' };
  }
  // OSS 预签名 URL 原样透传；文件名以目录树为准（本接口返回 size/hash）
  // v1.2.x fix（09-11 真机）：上游过期字段为 expiration（ISO，15min）；expire_time 为历史误写，保留兼容。
  // 解析失败才回退 URL 签名参数（aliyundrive.cloud 直链当前无可解析的签名过期参数）
  const expireRaw = dl.expiration ?? dl.expire_time;
  const expireMs = expireRaw ? Date.parse(expireRaw) || undefined : undefined;
  return {
    url: dl.url,
    expiresAt: expireMs ?? ossUrlExpiryMs(dl.url) ?? undefined,
    // v1.2.x fix：上游返回 sha1（content_hash，配 content_hash_name）+ size，接进校验/大小字段
    hash: dl.content_hash || undefined,
    size: dl.size ?? file.size,
  };
}

/** 第 3 步：批量获取下载直链（prase 两跳；每次调用 = 一批，节流归 linkFetcher）
 *
 * v1.2.x 契约收窄：files 由调用方保证顺序（alipan 无 shareFidToken，fid = file_id）。
 * 逐文件失败（copy 内层非 201 / 取直链异常）在**对应下标**产出 DownloadResult.error +
 * errorCode（core linkFetcher 原样回填，不整批 throw）；仅凭据缺失/HTTP 层失败整批抛。
 *
 * v1.3 滚动更新（carry-over）：缓存命中（缓存账号 === 本次 auth 账号 + 该原 file_id 有映射）
 * → 直接对上次转存得到的 file_id 取直链（**跳过 copy**）；未命中 → 正常 copy 并把新 file_id
 * 写回缓存。缓存里的 file_id 已失效（用户删了转存文件等）也回退 copy；**登录态过期不重试**
 * （规格 3：已发出的一次请求失败即判定，滚动更新提示由 UI 侧消费 carryOver.onExpired）。
 *
 * 幂等决策（v1.2.x 拍板，勿改）：**不做幂等转存** —— X-signature 体系查不了 user 接口、
 * copy 后新 file_id 无法与源文件跟踪绑定，auto_rename 副本累积接受（重复 prase/重试会
 * 在目标目录留下「xxx(2)」副本，去重需服务端侧另案）。
 */
async function getDownloadLinks(params: DownloadParams): Promise<DownloadResult[]> {
  if (params.files.length === 0) {
    return [];
  }
  // 凭据唯一来源：用户凭据串（无游客通道）。缺 auth/drive_id/目标目录 → 抛 need-login 哨兵码
  // （31001 复用夸克哨兵约定：ResultPage 据此弹登录态填写窗）
  const authString = getAlipanAuthString();
  const auth = parseAlipanAuthString(authString);
  if (!auth.auth) {
    fail(31001, '阿里云盘解析需要登录态：请填写 auth（Bearer token）。分享文件必须先转存到你的网盘才能取直链（游客不可解析）');
  }
  if (!auth.driveId) {
    fail(31001, '阿里云盘解析需要账号 drive_id：请补 drive_id（自己账号的 drive_id，抓包与 auth 同源，见弹窗说明）');
  }
  if (!auth.toParentFileId) {
    fail(31001, '阿里云盘解析需要转存目标目录：请补 to_parent_file_id（你自己网盘里目标文件夹的 file_id）');
  }

  // 账号身份（离线解 JWT；解不出时降级用 drive_id）—— 滚动更新命中的比对键
  const accountKey = alipanAccountKey(auth);
  // 结果按下标填（命中 / 转存两路混发，顺序与入参一致）
  const resultByIdx: DownloadResult[] = new Array<DownloadResult>(params.files.length);
  // 需要走 copy 的下标（未命中 + 缓存失效回退）
  const needCopy: number[] = [];

  // ① 滚动更新命中：直接取直链（跳过 copy，省空间、避免「空间满了」）
  for (let i = 0; i < params.files.length; i++) {
    const file = params.files[i];
    const carried = carriedTargetOf(accountKey, file.fid);
    if (!carried) {
      needCopy.push(i);
      continue;
    }
    const hit = await fetchDownloadUrl(auth, carried.fileId, carried.driveId ?? auth.driveId, i, file);
    if (hit.url) {
      resultByIdx[i] = hit;
      continue;
    }
    // 缓存里的 file_id 已失效（file 被删/换号等）→ 回退正常 copy；登录态过期不重试（规格 3）
    if (isAlipanExpiredAuthCode(hit.errorCode)) {
      resultByIdx[i] = hit;
      continue;
    }
    needCopy.push(i);
  }

  // ② 转存（只对需要 copy 的文件；一次 batch 数组批量，id 自编号、响应按序对应）
  // 头组合 = content-type + Authorization + x-share-token（源授权）+ x-canary share 段
  // （v1.2.x 实测成功组合：batch 用 CANARY_SHARE = client=web,app=share,version=v2.3.1；
  // UA/device 可省不写死；TODO 待验证：x-canary 是否可省 —— 与 repro.mjs 全链路保持一致）
  const batchPos = new Map<number, number>(); // 原下标 → batch 内序号（响应按 id 对应）
  let responses: NonNullable<AlipanBatchResponse['responses']> = [];
  if (needCopy.length > 0) {
    const batch = await request<AlipanBatchResponse>(
      '/adrive/v4/batch',
      {
        requests: needCopy.map((origIdx, pos) => {
          batchPos.set(origIdx, pos);
          return {
            body: {
              file_id: params.files[origIdx].fid,
              share_id: params.shareId,
              auto_rename: true,
              to_parent_file_id: auth.toParentFileId,
              // v1.2.x 拍板：drive_id 列为必填（copy 显式 to_drive_id）；若实测可省再降级可选
              to_drive_id: auth.driveId,
            },
            headers: { 'Content-Type': 'application/json' },
            id: String(pos),
            method: 'POST',
            url: '/file/copy',
          };
        }),
        resource: 'file',
      },
      praseHeaders(auth, { 'x-share-token': params.stoken, 'x-canary': CANARY_SHARE }),
      '转存到自己的网盘',
    );
    responses = batch.responses ?? [];
  }

  // ③ 逐文件：copy 成功 → 对转存后的新 file_id 取直链（逐发，防风控），并记下映射待回写缓存；
  // copy 失败/取直链失败 → 该项产出失败结果（error + errorCode 透传），不阻断其余文件
  const copied: Record<string, string> = {};
  for (const origIdx of needCopy) {
    const pos = batchPos.get(origIdx) ?? 0;
    const inner = responses.find((r) => r.id === String(pos)) ?? responses[pos]; // 异常时回退按数组序
    const status = inner?.status;
    const fileId = inner?.body?.file_id;
    if (status !== 201 || !fileId) {
      const code = inner?.body?.code ?? `copy-failed-${status ?? 'unknown'}`;
      resultByIdx[origIdx] = {
        url: '',
        error: errorTextOf(code, `第 ${origIdx + 1} 个文件转存失败：${inner?.body?.message ?? `内层 status ${status ?? '未知'}`}`),
        errorCode: code,
      };
      continue;
    }
    copied[params.files[origIdx].fid] = fileId;
    // 取直链的 drive_id：优先 copy 响应返回的 drive_id（实测即自己账号 drive_id，.repro.json 佐证），
    // 其次用户显式填的（凭据串 drive_id 字段）
    const driveId = inner?.body?.drive_id ?? auth.driveId;
    resultByIdx[origIdx] = await fetchDownloadUrl(auth, fileId, driveId, origIdx, params.files[origIdx]);
  }

  // ④ 回写缓存（只记本次成功转存的映射；账号变化 = 整条重置，见 carry.ts）
  if (Object.keys(copied).length > 0) {
    rememberAlipanCarriedFiles(accountKey, auth.driveId, copied);
  }
  return resultByIdx;
}

/** scanner 能力集合（registry.ts 组装成完整 PanAdapter） */
export const alipanScanner = {
  getToken,
  list,
  getDownloadLinks,
};
