/**
 * Gopeed 下载任务 JSON 生成（docs/STRUCTURE.md：src/tasks/gopeed.ts）
 *
 * v1.1.8.1：改为 Gopeed REST API 格式（v1.9.x 实测）。
 * 旧格式 { version:"1", tasks:[{req,store}] } 是早期 UI 导入格式，v1.9.x 已不支持
 * （web UI 无此导入；POST /api/v1/tasks 也不认），废弃。
 *
 * REST API（dev-api / openapi，v1.9.3 真机实测）：
 * - 批量：POST /api/v1/tasks/batch
 *   { "reqs": [ { "req": { "url": "<直链>", "extra": { "header": { "Cookie": "..." } } },
 *                "opts": { "name": "file.zip", "path": "<保存目录>" } } ] }
 * - 鉴权：X-Api-Token: <接口令牌>（不是 Authorization: Bearer）
 * - 保存目录语义：opts.path 为绝对目录，缺省 "" 时用 Gopeed 配置的默认下载目录
 *   （DownloaderStoreConfig.downloadDir）；opts.name 指定文件名。
 * - 请求头（§12 同响应绑定，UC = __pugs）：req.extra.header（单数 header）
 *
 * 约定：
 * - keepStructure=true：opts.path = baseDir + 相对目录（path 去掉文件名部分）；
 *   根目录文件落到 baseDir。baseDir 由调用方传入（推送时未填 savePath 会先取
 *   Gopeed 配置的 downloadDir，见 downloader.ts pushGopeed）。
 * - keepStructure=false：opts.path = baseDir（可能为空串 → Gopeed 默认下载目录）。
 * - 直链是 OSS 签名 URL（字符敏感），原样透传，不做任何转义。
 */

import type { ExportFile, TaskOptions } from '../core/types';

/** 取 path 去掉文件名部分作为相对目录；根目录（无目录）返回空串。
 * v1.1.5.3：开头 "/" 必须剔除 —— 树路径形如 "/dir1/sub/file.zip"，保留则 Gopeed 当作根目录绝对路径。 */
function dirNameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i).replace(/^\/+/, '') : '';
}

/** 取 path 最后一段作为文件名（"dir1/sub/file.zip" → "file.zip"） */
function fileNameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

/** Gopeed REST 批量任务元素（POST /api/v1/tasks/batch 的 reqs 数组元素） */
export interface GopeedTaskItem {
  req: {
    url: string;
    /** 仅当文件带下载凭据（§12，UC = __pugs）时才有；header 为单数键 */
    extra?: { header: Record<string, string> };
  };
  opts: {
    /** 文件名（不填则 Gopeed 取 URL 末尾段） */
    name: string;
    /** 保存目录（绝对路径；空串 = Gopeed 默认下载目录） */
    path: string;
  };
}

/** 下载凭据（§12 同响应绑定）：cookieString（多凭据整串）优先，否则 key=value 单凭据 */
function cookieOf(f: ExportFile): string {
  if (f.cookieString) return f.cookieString;
  return f.cookie ? `${f.cookie.key}=${f.cookie.value}` : '';
}

/** Gopeed REST 批量添加任务 payload */
export interface GopeedBatchPayload {
  reqs: GopeedTaskItem[];
}

/**
 * 生成 Gopeed REST 批量添加任务 payload（v1.1.8 抽取：导出 JSON 与 API 直推共用；
 * v1.1.8.1 改 REST 格式）。
 * 下载凭据（§12 同响应绑定，UC = __pugs）：有则注入 req.extra.header.Cookie，无则不带 extra。
 */
export function buildGopeedTasks(files: ExportFile[], options: TaskOptions): GopeedBatchPayload {
  const baseDir = options.outDir ?? '';
  const reqs = files.map((f) => {
    const relDir = dirNameOf(f.path);
    let path: string;
    if (options.keepStructure) {
      path = relDir ? (baseDir ? `${baseDir}/${relDir}` : relDir) : baseDir;
    } else {
      path = baseDir;
    }
    return {
      req: {
        url: f.url,
        ...(cookieOf(f) ? { extra: { header: { Cookie: cookieOf(f) } } } : {}), // §12
      },
      opts: {
        name: fileNameOf(f.path),
        path,
      },
    };
  });
  return { reqs };
}

/**
 * 生成 Gopeed REST 批量添加任务 JSON（格式化字符串，可直接 `curl -d @文件` 推送）。
 */
export function generateGopeedJson(files: ExportFile[], options: TaskOptions): string {
  return JSON.stringify(buildGopeedTasks(files, options), null, 2);
}
