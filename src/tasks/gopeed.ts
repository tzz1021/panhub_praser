/**
 * Gopeed 下载任务 JSON 生成（docs/STRUCTURE.md：src/tasks/gopeed.ts）
 *
 * Gopeed v1 批量添加任务格式：
 *   { "version": "1", "tasks": [{ "req": { "url": "<直链>" }, "store": { "path": "<保存路径>" } }] }
 *
 * 约定（HANDOFF §3.2 / §7）：
 * - keepStructure=true：store.path 为相对目录（path 去掉文件名部分），保留原始目录结构；
 *   根目录文件落到 "."（默认下载目录）。
 * - keepStructure=false：store.path 仅为文件名，全部保存到默认下载目录。
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

/**
 * 生成 Gopeed v1 添加任务 JSON（格式化字符串）。
 * 下载凭据（§12 同响应绑定，UC = __pugs）：有则注入 req.headers，无则不带。
 */
export function generateGopeedJson(files: ExportFile[], options: TaskOptions): string {
  const tasks = files.map(f => ({
    req: {
      url: f.url,
      ...(f.cookie ? { headers: { Cookie: `${f.cookie.key}=${f.cookie.value}` } } : {}), // §12
    },
    store: {
      // keepStructure：相对目录（根目录用 "."）；否则仅文件名
      path: options.keepStructure ? dirNameOf(f.path) || '.' : fileNameOf(f.path),
    },
  }));
  return JSON.stringify({ version: '1', tasks }, null, 2);
}
