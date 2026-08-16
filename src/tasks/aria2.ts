/**
 * aria2 下载任务生成（docs/STRUCTURE.md：src/tasks/aria2.ts）
 *
 * 三种输出形态：
 * - generateAria2Command：命令行。keepStructure=false 每文件一条；=true 只出一条
 *   `aria2c --continue=true --input-file=pan-web-tasks.txt`，配套内容由
 *   generateAria2InputFile 生成（调用方按同名文件导出）。
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
import { getPugs } from '../adapters/ucPugs';

/** input-file 模式的任务文件名（与 generateAria2Command 输出保持配套） */
export const ARIA2_INPUT_FILE_NAME = 'pan-web-tasks.txt';

/** 取 path 最后一段作为文件名（"dir1/sub/file.zip" → "file.zip"） */
function fileNameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

/** 取 path 去掉文件名部分作为相对目录；根目录（无目录）返回空串 */
function dirNameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '';
}

/** shell 双引号串内转义：`"` → `\"`（仅用于文件名/目录，URL 不参与） */
function shellEscape(s: string): string {
  return s.replace(/"/g, '\\"');
}

/** __pugs 下载令牌（§10）：有则生成 aria2 header 片段，无则空串 */
function cookieHeader(): string {
  const pugs = getPugs();
  return pugs ? ` --header="Cookie: __pugs=${pugs}"` : '';
}

/** input-file 里的 header 行（§10）：`  header=Cookie: __pugs=...` */
function cookieHeaderLine(): string {
  const pugs = getPugs();
  return pugs ? `  header=Cookie: __pugs=${pugs}` : '';
}

/** RPC 任务选项里的 header 数组（§10） */
function cookieHeaderArray(): string[] {
  const pugs = getPugs();
  return pugs ? [`Cookie: __pugs=${pugs}`] : [];
}

/**
 * 生成 aria2 命令行（keepStructure=true 时为单条 input-file 命令）。
 *
 * 不保留结构：每文件一行
 *   aria2c --continue=true [--header="Cookie: __pugs=..."] --dir="<outDir>" --out="<文件名>" "<url>"
 * 保留结构：单行
 *   aria2c --continue=true --input-file=pan-web-tasks.txt
 */
export function generateAria2Command(files: ExportFile[], options: TaskOptions): string {
  if (options.keepStructure) {
    // 目录结构写进 input-file（每文件 dir/out 选项），命令只留一条
    return `aria2c --continue=true --input-file=${ARIA2_INPUT_FILE_NAME}`;
  }
  // 平铺到下载目录：outDir 未给时省略 --dir
  const dirFlag = options.outDir ? ` --dir="${shellEscape(options.outDir)}"` : '';
  return files
    .map(f => `aria2c --continue=true${cookieHeader()}${dirFlag} --out="${shellEscape(fileNameOf(f.path))}" "${f.url}"`)
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
  const headerLine = cookieHeaderLine();
  const lines: string[] = [];
  for (const f of files) {
    lines.push(f.url); // input-file 不走 shell，直链原样
    if (headerLine) lines.push(headerLine); // §10：__pugs 令牌
    const dir = dirNameOf(f.path);
    if (dir) lines.push(`  dir=${dir}`);
    lines.push(`  out=${fileNameOf(f.path)}`);
  }
  return lines.join('\n');
}

/**
 * 生成 aria2 JSON-RPC 批量任务数组（method aria2.addUri，格式化 JSON 字符串）。
 *
 * 每条任务：{jsonrpc, id, method, params:[[url], {dir, out}], secret: null}
 * - secret 为占位可空：aria2 若配置了 --rpc-secret，把该值换成 "token:<secret>"
 *   并插入 params 首位（[token, [url], {dir,out}]）。
 * - keepStructure=true：dir 为相对目录（根目录文件落到 outDir 或 "."）；
 *   false：dir 统一为 outDir（缺省 "."），out 为文件名。
 */
export function generateAria2Rpc(files: ExportFile[], options: TaskOptions): string {
  const baseDir = options.outDir ?? '';
  const tasks = files.map((f, i) => {
    const out = fileNameOf(f.path);
    const relDir = dirNameOf(f.path);
    let dir: string;
    if (options.keepStructure) {
      dir = relDir ? (baseDir ? `${baseDir}/${relDir}` : relDir) : baseDir || '.';
    } else {
      dir = baseDir || '.';
    }
    return {
      jsonrpc: '2.0',
      id: `pan-web-${i + 1}`,
      method: 'aria2.addUri',
      params: [[f.url], { dir, out, header: cookieHeaderArray() }], // §10：__pugs 令牌经 header 注入
      // 占位可空：配了 --rpc-secret 时替换为 "token:<secret>" 并塞进 params 首位
      secret: null,
    };
  });
  return JSON.stringify(tasks, null, 2);
}
