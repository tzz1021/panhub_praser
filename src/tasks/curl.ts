/**
 * cURL 下载命令生成（docs/STRUCTURE.md：src/tasks/curl.ts）
 *
 * 单文件一条命令；批量时调用方逐条生成再拼接（export.ts 的 exportTask 已处理）。
 * UA / Referer 组合见 docs/reverse-notes-uc.md §5（UC 实测最佳实践）。
 *
 * 约定：
 * - 直链是 OSS 签名 URL（字符敏感），原样透传，只包引号不做任何转义。
 * - 输出路径（outDir + 文件名）含双引号时转义为 `\"`。
 * - `-C -` 断点续传（直链 3-6h 有效，过期重新解析拿新直链后仍可续传）。
 * - cURL 不支持保留目录结构，outDir 只做平铺输出目录。
 */

import type { ExportFile, TaskOptions } from '../core/types';

/** UC 客户端 UA（reverse-notes-uc.md §5 实测组合） */
export const UC_DOWNLOAD_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'uc-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 ' +
  'Channel/pckk_other_ch';

/** 下载 Referer（UC 分享页，reverse-notes-uc.md §5） */
export const UC_DOWNLOAD_REFERER = 'https://drive.uc.cn/';

/** 取 path 最后一段作为文件名（"dir1/sub/file.zip" → "file.zip"） */
function fileNameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

/** shell 双引号串内转义：`"` → `\"`（仅用于输出路径，URL 不参与） */
function shellEscape(s: string): string {
  return s.replace(/"/g, '\\"');
}

/**
 * 生成单文件 cURL 命令：
 *   curl -L -C - -o "<outDir>/<文件名>" -A "<UC UA>" -e "https://drive.uc.cn/" [-b "__pugs=..."] "<直链>"
 * __pugs 取与该直链**同响应绑定**的值（§12：适配器捕获后随 LinkResult 下发，
 * 严禁用全局/跨响应值 —— 混用必 403 ucidMd5 invalid）；缺失时命令附带提示注释。
 */
export function generateCurlCommand(file: ExportFile, options?: Pick<TaskOptions, 'outDir'>): string {
  const name = fileNameOf(file.path);
  // 输出路径 = outDir + 文件名；含双引号统一转义
  const outPath = shellEscape(options?.outDir ? `${options.outDir}/${name}` : name);
  const cookiePart = file.cookie ? ` -b "${file.cookie.key}=${file.cookie.value}"` : '';
  const hint = file.cookie ? '' : '\n# 提示：未捕获下载凭据（UC __pugs），该文件下载可能被拒（403/掐流）。请经代理解析后重新导出。';
  return `curl -L -C - -o "${outPath}" -A "${UC_DOWNLOAD_UA}" -e "${UC_DOWNLOAD_REFERER}"${cookiePart} "${file.url}"${hint}`;
}
