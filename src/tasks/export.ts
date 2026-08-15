/**
 * 统一导出（docs/STRUCTURE.md：src/tasks/export.ts）
 *
 * - exportTask：按 TaskKind 分发到 aria2 / gopeed / curl 生成器，返回 {文件名, 内容}
 * - exportTreeMd：目录树 md（默认 bars `|---` 模式，123 云盘风格；可选 indent 2 空格模式）
 * - exportLinksMd：纯直链列表（`<url>  <文件名>  <大小>`，直链字符敏感原样输出）
 *
 * 本文件只依赖 src/core/types.ts（HANDOFF §4：core 零网盘依赖，tasks 同理）。
 */

import type { ExportFile, ParseRecord, TaskKind, TaskOptions, TreeNode, TreeDetailPrefs } from '../core/types';
import { generateAria2Command } from './aria2';
import { generateGopeedJson } from './gopeed';
import { generateCurlCommand } from './curl';

/* ============================== 本地格式化 ============================== */

/** 字节 → 人类可读大小（B/KB/MB/GB/TB，最多 2 位小数并去尾零） */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = -1;
  do {
    v /= 1024;
    i += 1;
  } while (v >= 1024 && i < units.length - 1);
  const trimmed = String(parseFloat(v.toFixed(2)));
  return `${trimmed} ${units[i]}`;
}

/** ms 时间戳 → "YYYY-MM-DD HH:mm"（本地时区） */
function formatTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 取 path 最后一段作为文件名（"dir1/sub/file.zip" → "file.zip"） */
function fileNameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

/* ============================== 任务导出分发 ============================== */

/**
 * 统一导出入口：按 kind 分发到对应生成器。
 *
 * fileName：aria2 → 'aria2-command.txt'（keepStructure=true 时为单条 input-file
 * 命令，配套 pan-web-tasks.txt 内容请另取 generateAria2InputFile）；
 * gopeed → 'gopeed-tasks.json'；curl → 'curl-commands.txt'（逐条拼接）。
 */
export function exportTask(kind: TaskKind, files: ExportFile[], options: TaskOptions): { fileName: string; content: string } {
  switch (kind) {
    case 'aria2':
      return { fileName: 'aria2-command.txt', content: generateAria2Command(files, options) };
    case 'gopeed':
      return { fileName: 'gopeed-tasks.json', content: generateGopeedJson(files, options) };
    case 'curl':
      return {
        fileName: 'curl-commands.txt',
        content: files.map(f => generateCurlCommand(f, { outDir: options.outDir })).join('\n'),
      };
    default: {
      // 穷尽检查：TaskKind 新增类型时此处编译报错
      const neverKind: never = kind;
      throw new Error(`未知任务类型: ${neverKind}`);
    }
  }
}

/* ============================== 目录树 md ============================== */

/**
 * 目录树 md 导出。
 *
 * - 默认 'bars' 模式（123 云盘风格）：根为 `📁 <root>/`，子节点 `|--- ` 前缀，
 *   每深一层前缀追加 `|   `；'indent' 模式每层缩进 2 空格。
 * - 目录行附聚合大小（node.size）；文件行附大小 / etag（md5、sha1，有哪个渲染
 *   哪个）/ 分享时间（ShareFile.modifiedAt）。只有对应 detail 开关为 true 且字段
 *   存在才渲染（saveTime/platformTime 网盘字段暂不在 ShareFile 上，由 UI 层扩展）。
 * - records：同 path（node.path）的解析记录渲染为斜体注释行
 *   `*[解析 2026-08-13 14:00 成功 2次]*`（取最近一条的状态，次数为记录总数）。
 */
export function exportTreeMd(
  root: TreeNode,
  options?: { format?: 'bars' | 'indent'; detail?: TreeDetailPrefs; records?: Map<string, ParseRecord[]> },
): string {
  const format = options?.format ?? 'bars';
  // 默认全部开（HANDOFF 附件「3.默认足迹保留」：目录树详细程度默认全 ✅）
  const detail: TreeDetailPrefs = options?.detail ?? {
    fileSize: true,
    etag: true,
    shareTime: true,
    saveTime: true,
    platformTime: true,
  };
  const lines = renderNode(root, 0, format, detail, options?.records);
  return lines.join('\n');
}

/** 递归渲染单节点及其子树（返回行数组） */
function renderNode(
  node: TreeNode,
  depth: number,
  format: 'bars' | 'indent',
  detail: TreeDetailPrefs,
  records?: Map<string, ParseRecord[]>,
): string[] {
  const lines: string[] = [];
  const isRoot = depth === 0;
  // 行首前缀：bars = '|   '.repeat(depth-1) + '|--- '；indent = 2 空格 × depth
  const prefix = format === 'bars' ? (isRoot ? '' : '|   '.repeat(depth - 1) + '|--- ') : '  '.repeat(depth);
  const name = isRoot
    ? `📁 ${node.file.fileName || 'root'}/`
    : `${node.file.fileName}${node.file.dir ? '/' : ''}`;
  lines.push(prefix + name + detailSuffix(node, detail));

  const recs = records?.get(node.path);
  if (recs && recs.length > 0) lines.push(prefix + recordLine(recs));

  if (node.children) {
    for (const child of node.children) {
      lines.push(...renderNode(child, depth + 1, format, detail, records));
    }
  }
  return lines;
}

/** 节点行尾详情：目录只附聚合大小；文件附大小/etag/分享时间（按 detail 开关过滤） */
function detailSuffix(node: TreeNode, detail: TreeDetailPrefs): string {
  const parts: string[] = [];
  if (detail.fileSize && node.size > 0) parts.push(formatSize(node.size));
  if (!node.file.dir) {
    if (detail.etag) {
      const etags: string[] = [];
      if (node.file.md5) etags.push(`md5:${node.file.md5}`);
      if (node.file.sha1) etags.push(`sha1:${node.file.sha1}`);
      if (etags.length > 0) parts.push(etags.join(' '));
    }
    if (detail.shareTime && node.file.modifiedAt) parts.push(`分享时间 ${formatTime(node.file.modifiedAt)}`);
  }
  return parts.length > 0 ? `  ${parts.join('  ')}` : '';
}

/** 解析记录斜体注释行：`*[解析 <时间> <成功|失败> <n>次]*`（取最近一次状态） */
function recordLine(recs: ParseRecord[]): string {
  const sorted = [...recs].sort((a, b) => a.parsedAt - b.parsedAt);
  const latest = sorted[sorted.length - 1];
  const status = latest.ok ? '成功' : '失败';
  return `*[解析 ${formatTime(latest.parsedAt)} ${status} ${recs.length}次]*`;
}

/* ============================== 直链列表 md ============================== */

/**
 * 纯直链列表：每行 `<url>  <文件名>  <大小>`（两空格分隔；大小缺省时省略）。
 * 直链字符敏感，原样输出不做任何转义。
 */
export function exportLinksMd(files: ExportFile[]): string {
  return files
    .map(f => {
      const name = fileNameOf(f.path);
      const size = f.size !== undefined && f.size > 0 ? formatSize(f.size) : '';
      return size ? `${f.url}  ${name}  ${size}` : `${f.url}  ${name}`;
    })
    .join('\n');
}
