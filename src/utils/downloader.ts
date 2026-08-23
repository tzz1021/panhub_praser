/**
 * 本地下载器连接（连接本地下载器弹窗的存储层 + RPC/API 直推传输层）
 *
 * - 存储：localStorage 'panhub:downloader:v1'，不涉及任何凭据敏感信息。
 * - 直推（v1.1.8）：
 *   aria2 / motrix → aria2 JSON-RPC（aria2.addUri / aria2.getVersion），同协议（motrix 内置 aria2 内核，16800）；
 *   gopeed → Gopeed REST API（v1.1.8.1 实测修正：批量 POST /api/v1/tasks/batch，
 *   鉴权用 X-Api-Token: <token>，连接测试 GET /api/v1/info——旧版 Authorization: Bearer +
 *   /api/v1/version 在 v1.9.x 均不可用：401 / 404）。
 * - 传输层不碰网盘细节：任务构建复用 src/tasks/aria2.ts / gopeed.ts（§12 按文件注入 __pugs）。
 */
export type DownloaderType = 'aria2' | 'motrix' | 'gopeed';

export interface DownloaderConfig {
  /** 下载器类型 */
  type: DownloaderType;
  /** RPC 地址 */
  rpc: string;
  /** RPC 密钥（可选） */
  secret: string;
  /** 本地保存路径（可选，不填用下载器默认） */
  savePath: string;
}

/** 各类型默认 RPC 地址与说明（参考 pdpb.cn 弹窗 hint） */
export const DOWNLOADER_PRESETS: Record<
  DownloaderType,
  { label: string; rpc: string; hint: string }
> = {
  aria2: {
    label: 'Aria2',
    rpc: 'http://127.0.0.1:6800/jsonrpc',
    hint: 'Aria2：6800，需开启 RPC（--enable-rpc）',
  },
  motrix: {
    label: 'Motrix',
    rpc: 'http://127.0.0.1:16800/jsonrpc',
    hint: 'Motrix：16800（Motrix 内置 aria2 内核）',
  },
  gopeed: {
    label: 'Gopeed',
    rpc: 'http://127.0.0.1:9999/api/v1/tasks',
    hint: 'Gopeed：127.0.0.1:9999，通讯协议需选 TCP；接口令牌填到下方密钥（无令牌留空）',
  },
};

const KEY = 'panhub:downloader:v1';

/** 默认配置（aria2，本地默认 RPC） */
export function defaultDownloaderConfig(): DownloaderConfig {
  return { type: 'aria2', rpc: DOWNLOADER_PRESETS.aria2.rpc, secret: '', savePath: '' };
}

/** 读取配置；损坏/缺失回退默认 */
export function loadDownloaderConfig(): DownloaderConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultDownloaderConfig();
    const parsed = JSON.parse(raw) as Partial<DownloaderConfig>;
    const preset = DOWNLOADER_PRESETS[parsed.type ?? 'aria2'];
    return {
      type: parsed.type ?? 'aria2',
      rpc: parsed.rpc || preset.rpc,
      secret: parsed.secret ?? '',
      savePath: parsed.savePath ?? '',
    };
  } catch {
    return defaultDownloaderConfig();
  }
}

/** 保存配置 */
export function saveDownloaderConfig(cfg: DownloaderConfig): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cfg));
  } catch {
    // 配额异常静默（配置丢失不影响主流程）
  }
}

/* ============================== 直推传输层（v1.1.8） ============================== */

import type { ExportFile, TaskOptions } from '../core/types';
import { buildAria2AddUriParams } from '../tasks/aria2';
import { buildGopeedTasks } from '../tasks/gopeed';

/** 推送结果 */
export interface PushResult {
  ok: boolean;
  /** 成功任务数 */
  success: number;
  /** 失败任务数 */
  failed: number;
  /** 人性化信息（首个失败原因 / 成功提示） */
  message: string;
}

/** 单次请求超时（ms）：本地 RPC 正常 <100ms，超时多半是没启动/地址错 */
const REQUEST_TIMEOUT = 8000;

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 网络层错误（连接失败/超时/CORS 拦截）→ 人性化文案 */
function friendlyNetError(): string {
  return (
    '无法连接下载器（请确认已启动、RPC 地址正确且允许远程连接；' +
    '若在网页端被浏览器拦截跨域，请改用导出任务文件，或使用本地部署/书签方式）'
  );
}

/** 判断是否网络层错误（区别于 RPC 业务错误，如密钥错误 401） */
function isNetworkError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === 'AbortError') return true; // 超时
  // fetch 网络失败 = TypeError（"Failed to fetch"，含 CORS 拦截）；RPC 业务错误是普通 Error
  return e instanceof TypeError;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ------------------------------ aria2 / motrix（JSON-RPC） ------------------------------ */

/**
 * aria2 JSON-RPC 调用。
 * 配了 --rpc-secret 时，`token:<secret>` 前置到 params 首位（aria2 规定）。
 */
async function aria2Rpc(cfg: DownloaderConfig, method: string, params: unknown[]): Promise<unknown> {
  const payload: { jsonrpc: string; id: string; method: string; params: unknown[] } = {
    jsonrpc: '2.0',
    id: `panhub-${Date.now()}`,
    method,
    params,
  };
  if (cfg.secret) payload.params = [`token:${cfg.secret}`, ...params];
  const res = await fetchWithTimeout(
    cfg.rpc,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
    REQUEST_TIMEOUT,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { error?: { message?: string; code?: number }; result?: unknown };
  if (data.error) throw new Error(data.error.message ?? `RPC 错误（${String(data.error.code ?? '?')}）`);
  return data.result;
}

/** aria2.addUri 逐任务直推；首个网络错误即中止（避免连接失败时逐条等超时） */
async function pushAria2(cfg: DownloaderConfig, files: ExportFile[], options: TaskOptions): Promise<PushResult> {
  const paramsList = buildAria2AddUriParams(files, options);
  let success = 0;
  let failed = 0;
  let firstErr = '';
  for (const params of paramsList) {
    try {
      await aria2Rpc(cfg, 'aria2.addUri', params);
      success += 1;
    } catch (e) {
      if (isNetworkError(e)) {
        return { ok: false, success, failed: paramsList.length - success, message: friendlyNetError() };
      }
      failed += 1;
      if (!firstErr) firstErr = errMsg(e);
    }
  }
  return {
    ok: failed === 0,
    success,
    failed,
    message: failed === 0 ? '全部任务已推送到下载器' : `成功 ${success}，失败 ${failed}：${firstErr}`,
  };
}

/* ------------------------------ gopeed（REST API） ------------------------------ */

/** 由配置的 tasks 端点反推 API 根：`.../api/v1/tasks` → `...`；用户自填根地址则原样用 */
function gopeedBase(rpc: string): string {
  const idx = rpc.lastIndexOf('/api/v1/tasks');
  return idx > 0 ? rpc.slice(0, idx) : rpc.replace(/\/+$/, '');
}

/** Gopeed API 调用：鉴权用 X-Api-Token（v1.9.x 实测，不是 Authorization Bearer）；响应 code!==0 视为失败 */
async function gopeedFetch(cfg: DownloaderConfig, path: string, init?: RequestInit): Promise<unknown> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (cfg.secret) headers['X-Api-Token'] = cfg.secret;
  const res = await fetchWithTimeout(gopeedBase(cfg.rpc) + path, { ...init, headers }, REQUEST_TIMEOUT);
  type GopeedResp = { code?: number; msg?: string; status?: number };
  let data: GopeedResp | null = null;
  try {
    data = (await res.json()) as GopeedResp;
  } catch {
    // 非 JSON 响应：仅用 HTTP 状态判断
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}${data?.msg ? `（${data.msg}）` : ''}`);
  if (data && typeof data.code === 'number' && data.code !== 0) {
    throw new Error(data.msg || `Gopeed 错误码 ${data.code}`);
  }
  return data;
}

/**
 * Gopeed 批量任务一次 POST /api/v1/tasks/batch（v1.1.8.1：REST reqs 格式，真机实测）。
 * 用户未填保存路径时先取 Gopeed 配置的默认下载目录作为 baseDir（保证 keepStructure 落到正确目录）。
 */
async function pushGopeed(cfg: DownloaderConfig, files: ExportFile[], options: TaskOptions): Promise<PushResult> {
  let baseDir = options.outDir ?? '';
  if (!baseDir) {
    try {
      const resp = (await gopeedFetch(cfg, '/api/v1/config', { method: 'GET' })) as {
        data?: { downloadDir?: string };
      } | null;
      baseDir = resp?.data?.downloadDir ?? '';
    } catch {
      // 取不到就用空串，Gopeed 端仍有默认目录兜底（initOptions）
    }
  }
  const payload = buildGopeedTasks(files, { ...options, outDir: baseDir || undefined });
  await gopeedFetch(cfg, '/api/v1/tasks/batch', { method: 'POST', body: JSON.stringify(payload) });
  return { ok: true, success: files.length, failed: 0, message: `全部 ${files.length} 个任务已推送到 Gopeed` };
}

/* ------------------------------ 对外入口 ------------------------------ */

/**
 * 测试连接（弹窗「测试连接」按钮）。
 * aria2/motrix → aria2.getVersion；gopeed → GET /api/v1/info（v1.9.x，/api/v1/version 已 404）。
 */
export async function testDownloaderConnection(cfg: DownloaderConfig): Promise<{ ok: boolean; message: string }> {
  try {
    if (cfg.type === 'gopeed') {
      const data = (await gopeedFetch(cfg, '/api/v1/info', { method: 'GET' })) as {
        data?: { version?: string };
      } | null;
      return { ok: true, message: `连接成功（Gopeed ${data?.data?.version ?? ''}）`.trim() };
    }
    const result = (await aria2Rpc(cfg, 'aria2.getVersion', [])) as { version?: string } | null;
    const label = DOWNLOADER_PRESETS[cfg.type].label;
    return { ok: true, message: `连接成功（${label} ${result?.version ?? ''}）`.trim() };
  } catch (e) {
    const base = isNetworkError(e) ? friendlyNetError() : `连接失败：${errMsg(e)}`;
    return { ok: false, message: base };
  }
}

/**
 * 把解析好的直链任务推送到本地下载器（结果页「推送下载器」按钮）。
 * 按配置类型分发：aria2/motrix → JSON-RPC；gopeed → REST API。
 */
export async function pushFilesToDownloader(
  cfg: DownloaderConfig,
  files: ExportFile[],
  options: TaskOptions,
): Promise<PushResult> {
  if (files.length === 0) {
    return { ok: false, success: 0, failed: 0, message: '没有可推送的任务' };
  }
  if (!cfg.rpc) {
    return { ok: false, success: 0, failed: files.length, message: '未配置下载器地址，请先打开「连接本地下载器」填写' };
  }
  try {
    if (cfg.type === 'gopeed') {
      return await pushGopeed(cfg, files, options);
    }
    return await pushAria2(cfg, files, options); // aria2 / motrix 同协议
  } catch (e) {
    return { ok: false, success: 0, failed: files.length, message: errMsg(e) };
  }
}
