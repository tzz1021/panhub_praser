/**
 * aria2 下载任务生成（docs/STRUCTURE.md：src/tasks/aria2.ts）
 *
 * 两种输出形态（v1.1.5.2 起全部单文件，浏览器不拦连续下载）:
 * - generateAria2Command：命令行。keepStructure=false 每文件一条平铺命令；
 *   =true 每文件一条带 --dir="相对目录" 的命令（aria2 自动建目录），不再用 input-file
 *   双文件方案（浏览器默认拦截连续下载两个文件，Tzz 反馈）。
 * - generateAria2Rpc：JSON-RPC 批量任务数组（method aria2.addUri）。
 *
 * 约定：
 * - 直链是 OSS 签名 URL（字符敏感，reverse-notes-uc.md §3.3），一律原样透传，
 *   只包引号不做任何转义。
 * - keepStructure=true 时目录取 path 去掉文件名部分；根目录文件无目录（省略 dir 行）。
 * - 文件名/路径含双引号时做 `\"` 转义（shell 双引号串内）。
 * - -C - 断点续传（--continue=true，直链 3-6h 有效，过期重新解析后仍可续传）。
 */

import type { ExportFile, TaskOptions } from '../core/types';

/** input-file 模式的任务文件名（与 generateAria2Command 输出保持配套） */
export const ARIA2_INPUT_FILE_NAME = 'pan-web-tasks.txt';

/** 取 path 最后一段作为文件名（"dir1/sub/file.zip" → "file.zip"） */
function fileNameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

/** 取 path 去掉文件名部分作为相对目录；根目录（无目录）返回空串。
 * v1.1.5.3：开头 "/" 必须剔除 —— 树路径形如 "/dir1/sub/file.zip"，保留则 aria2 当作根目录绝对路径。 */
function dirNameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i).replace(/^\/+/, '') : '';
}

/** shell 双引号串内转义：`"` → `\"`（仅用于文件名/目录，URL 不参与） */
function shellEscape(s: string): string {
  return s.replace(/"/g, '\\"');
}

/** __pugs 下载令牌（§12 同响应绑定）：有则生成 aria2 header 片段，无则空串 */
function cookieHeader(f: ExportFile): string {
  return f.cookie ? ` --header="Cookie: ${f.cookie.key}=${f.cookie.value}"` : '';
}

/** input-file 里的 header 行（§12）：`  header=Cookie: __pugs=...` */
function cookieHeaderLine(f: ExportFile): string {
  return f.cookie ? `  header=Cookie: ${f.cookie.key}=${f.cookie.value}` : '';
}

/** RPC 任务选项里的 header 数组（§12） */
function cookieHeaderArray(f: ExportFile): string[] {
  return f.cookie ? [`Cookie: ${f.cookie.key}=${f.cookie.value}`] : [];
}

/**
 * 生成 aria2 命令行（v1.1.5.2：keepStructure 也输出单文件，每行一条完整命令）。
 *
 * 不保留结构：每文件一行
 *   aria2c --continue=true [--header="Cookie: __pugs=..."] --dir="<outDir>" --out="<文件名>" "<url>"
 * 保留结构：每文件一行带相对目录（aria2 自动创建 --dir 目录）
 *   aria2c --continue=true [--header="Cookie: __pugs=..."] --dir="dir1/sub" --out="a.zip" "<url>"
 */
export function generateAria2Command(files: ExportFile[], options: TaskOptions): string {
  const keep = options.keepStructure;
  return files
    .map((f) => {
      const dir = keep ? dirNameOf(f.path) : '';
      const dirFlag = dir
        ? ` --dir="${shellEscape(dir)}"` // 相对目录，aria2 自动创建
        : options.outDir
          ? ` --dir="${shellEscape(options.outDir)}"`
          : '';
      return `aria2c --continue=true${cookieHeader(f)}${dirFlag} --out="${shellEscape(fileNameOf(f.path))}" "${f.url}"`;
    })
    .join('\n');
}

/**
 * 生成 aria2 input-file 内容（keepStructure=true 配套）。
 *
 * 格式：每文件一行 url，下一行起缩进两个空格写选项；
 * 目录行（非根目录）与文件名行都给出，根目录文件省略 dir 行。
 * 例：
 *   https://dl-uf-zb.pds.uc.cn/.../a.zip
 *     dir=dir1/sub
 *     out=a.zip
 *   https://dl-uf-zb.pds.uc.cn/.../b.zip
 *     out=b.zip
 */
export function generateAria2InputFile(files: ExportFile[]): string {
  const lines: string[] = [];
  for (const f of files) {
    lines.push(f.url); // input-file 不走 shell，直链原样
    const h = cookieHeaderLine(f);
    if (h) lines.push(h); // §12：每文件各自的 __pugs 令牌
    const dir = dirNameOf(f.path);
    if (dir) lines.push(`  dir=${dir}`);
    lines.push(`  out=${fileNameOf(f.path)}`);
  }
  return lines.join('\n');
}

/**
 * aria2.addUri 的单任务 params：`[urls, options]`。
 * RPC 密钥由调用方决定是否前置 `token:<secret>` 到 params 首位。
 */
export type Aria2AddUriParams = [string[], { dir: string; out: string; header: string[] }];

/**
 * 生成 aria2.addUri 参数数组（v1.1.8 抽取：导出 JSON 与 RPC 直推共用同一套 dir/out/header 逻辑）。
 * - keepStructure=true：dir 为相对目录（根目录文件落到 outDir 或 "."）；
 *   false：dir 统一为 outDir（缺省 "."），out 为文件名。
 * - header 恒为数组（§12：每文件各自的 __pugs 令牌；无凭据时为空数组，aria2 接受）。
 */
export function buildAria2AddUriParams(files: ExportFile[], options: TaskOptions): Aria2AddUriParams[] {
  const baseDir = options.outDir ?? '';
  return files.map((f) => {
    const out = fileNameOf(f.path);
    const relDir = dirNameOf(f.path);
    let dir: string;
    if (options.keepStructure) {
      dir = relDir ? (baseDir ? `${baseDir}/${relDir}` : relDir) : baseDir || '.';
    } else {
      dir = baseDir || '.';
    }
    return [[f.url], { dir, out, header: cookieHeaderArray(f) }];
  });
}

/**
 * 生成 aria2 JSON-RPC 批量任务数组（method aria2.addUri，格式化 JSON 字符串）。
 *
 * 每条任务：{jsonrpc, id, method, params:[[url], {dir, out}], secret: null}
 * - secret 为占位可空：aria2 若配置了 --rpc-secret，把该值换成 "token:<secret>"
 *   并插入 params 首位（[token, [url], {dir,out}]）。
 */
export function generateAria2Rpc(files: ExportFile[], options: TaskOptions): string {
  const tasks = buildAria2AddUriParams(files, options).map((params, i) => ({
    jsonrpc: '2.0',
    id: `pan-web-${i + 1}`,
    method: 'aria2.addUri',
    params,
    // 占位可空：配了 --rpc-secret 时替换为 "token:<secret>" 并塞进 params 首位
    secret: null,
  }));
  return JSON.stringify(tasks, null, 2);
}
