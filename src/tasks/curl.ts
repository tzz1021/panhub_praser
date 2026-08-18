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
 * - v1.1.5：支持保留目录结构 —— keepStructure=true 时输出路径带相对目录并加 --create-dirs。
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

/** 取 path 去掉文件名部分作为相对目录（"dir1/sub/file.zip" → "dir1/sub"）；根目录返回空串。
 * v1.1.5.3：开头 "/" 必须剔除 —— 树路径形如 "/dir1/sub/file.zip"，保留则被 shell 当作根目录绝对路径。 */
function dirNameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i).replace(/^\/+/, '') : '';
}

/** shell 双引号串内转义：`"` → `\"`（仅用于输出路径，URL 不参与） */
function shellEscape(s: string): string {
  return s.replace(/"/g, '\\"');
}

/**
 * 生成单文件 cURL 命令：
 *   curl -L -C - [--create-dirs] -o "<outDir>/<相对目录>/<文件名>" -A "<UC UA>" -e "https://drive.uc.cn/" [-b "__pugs=..."] "<直链>"
 * keepStructure=true（v1.1.5）：输出路径带相对目录并加 --create-dirs，curl 自动建目录；
 * 否则平铺到 outDir（缺省当前目录）。
 * __pugs 取与该直链**同响应绑定**的值（§12：适配器捕获后随 LinkResult 下发，
 * 严禁用全局/跨响应值 —— 混用必 403 ucidMd5 invalid）；缺失时命令附带提示注释。
 */
export function generateCurlCommand(file: ExportFile, options?: Pick<TaskOptions, 'outDir' | 'keepStructure'>): string {
  const name = fileNameOf(file.path);
  const relDir = dirNameOf(file.path);
  const keep = Boolean(options?.keepStructure);
  // 输出路径：保留结构 = [outDir/]相对目录/文件名；平铺 = [outDir/]文件名
  const dirPart = keep && relDir ? `${relDir}/` : options?.outDir ? `${options.outDir}/` : '';
  const outPath = shellEscape(`${dirPart}${name}`);
  const createDirs = keep && relDir ? ' --create-dirs' : '';
  const cookiePart = file.cookie ? ` -b "${file.cookie.key}=${file.cookie.value}"` : '';
  const hint = file.cookie ? '' : '\n# 提示：未捕获下载凭据（UC __pugs），该文件下载可能被拒（403/掐流）。请经代理解析后重新导出。';
  return `curl -L -C -${createDirs} -o "${outPath}" -A "${UC_DOWNLOAD_UA}" -e "${UC_DOWNLOAD_REFERER}"${cookiePart} "${file.url}"${hint}`;
}
