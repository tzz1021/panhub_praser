/**
 * cURL 下载命令生成（docs/STRUCTURE.md：src/tasks/curl.ts）
 *
 * 单文件一条命令；批量时调用方逐条生成再拼接（export.ts 的 exportTask 已处理）。
 * 下载层静态头（UA/Referer 等）v1.2.x 起按文件从 ExportFile.headers 取 ——
 * ResultPage 组装时把该会话 adapter.downloadHeaders 合并进每文件（UC/夸克 =
 * 各自客户端 UA + 分享页 Referer；alipan = 精确 Referer https://www.alipan.com/）。
 *
 * 约定：
 * - 直链是 OSS 签名 URL（字符敏感），原样透传，只包引号不做任何转义。
 * - 输出路径（outDir + 文件名）含双引号时转义为 `\"`。
 * - `-C -` 断点续传（直链 3-6h 有效，过期重新解析拿新直链后仍可续传）。
 * - v1.1.5：支持保留目录结构 —— keepStructure=true 时输出路径带相对目录并加 --create-dirs。
 */

import type { ExportFile, TaskOptions } from '../core/types';

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

/** shell 双引号串内转义：`"` → `\"`（仅用于输出路径，URL/头值不参与；头值来自适配器常量，无引号） */
function shellEscape(s: string): string {
  return s.replace(/"/g, '\\"');
}

/**
 * 静态下载头（v1.2.x，ExportFile.headers = adapter.downloadHeaders 声明值）→ curl 参数片段：
 * User-Agent → `-A "…"`；Referer → `-e "…"`；其余 → `-H "name: value"`。
 * cookie 不进这里（动态凭据走 -b）；无静态头返回空串（命令不带 -A/-e）。
 */
function headerFlags(f: ExportFile): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(f.headers ?? {})) {
    if (!v) continue;
    const key = k.toLowerCase();
    if (key === 'user-agent') out.push(`-A "${v}"`);
    else if (key === 'referer') out.push(`-e "${v}"`);
    else out.push(`-H "${k}: ${v}"`);
  }
  return out.join(' ');
}

/**
 * 生成单文件 cURL 命令：
 *   curl -L -C - [--create-dirs] -o "<outDir>/<相对目录>/<文件名>" [-A/-e/-H 静态头] [-b "cookie"] "<直链>"
 * keepStructure=true（v1.1.5）：输出路径带相对目录并加 --create-dirs，curl 自动建目录；
 * 否则平铺到 outDir（缺省当前目录）。
 * __pugs 取与该直链**同响应绑定**的值（§12：适配器捕获后随 LinkResult 下发，
 * 严禁用全局/跨响应值 —— 混用必 403 ucidMd5 invalid）；缺失且该网盘需要下载凭据
 * （credLabel 存在）时命令附带提示注释（alipan 无下载层 cookie，不带提示）。
 */
export function generateCurlCommand(file: ExportFile, options?: Pick<TaskOptions, 'outDir' | 'keepStructure'>): string {
  const name = fileNameOf(file.path);
  const relDir = dirNameOf(file.path);
  const keep = Boolean(options?.keepStructure);
  // 输出路径：保留结构 = [outDir/]相对目录/文件名；平铺 = [outDir/]文件名
  const dirPart = keep && relDir ? `${relDir}/` : options?.outDir ? `${options.outDir}/` : '';
  const outPath = shellEscape(`${dirPart}${name}`);
  const createDirs = keep && relDir ? ' --create-dirs' : '';
  const staticFlags = headerFlags(file);
  const staticPart = staticFlags ? ` ${staticFlags}` : '';
  const cookiePart = file.cookieString
    ? ` -b "${file.cookieString}"`
    : file.cookie
      ? ` -b "${file.cookie.key}=${file.cookie.value}"`
      : '';
  // v1.2.x：提示只在「该网盘确实需要下载凭据（credLabel）且本次没拿到」时写（alipan/无 credLabel 网盘不写）
  const hint = file.cookie || file.cookieString || !file.credLabel ? '' : `\n# 提示：未捕获下载凭据（${file.credLabel}），该文件下载可能被拒（403/掐流）。请经代理解析后重新导出。`;
  // v1.1.9.final：hash 注释行（夸克 = dl 响应 md5；其他网盘可能 sha1）—— 下载后自行校验完整性
  const hashLine = file.hash ? `\n# hash: ${file.hash}` : '';
  return `curl -L -C -${createDirs} -o "${outPath}"${staticPart}${cookiePart} "${file.url}"${hashLine}${hint}`;
}
