/**
 * 资源列表获取（scanner，原 ls 术语，v1.1.5.3 开发日志改名）
 *
 * 职责：一次「获取资源列表」= getToken（分享有效性校验）→ buildTree（目录树递归遍历）。
 * 产物为 ListSnapshot（stoken + 目录树 + 统计），可被复用（reuseWindowHours 窗口内）。
 *
 * 与 prase（解析下载方式，linkFetcher.ts）严格分开：
 * - scanner：游客态浏览，不需要 cookie；慢（大宗链接数百文件 >1min），产物可缓存复用
 * - prase：按文件打 download 接口取 oss+sig + 同响应 __pugs；快，窗口内复用已解析直链
 *
 * 目录树文本渲染（renderTreeText）供全局日志打印，UI 侧对过长树自动折叠。
 */
import type { PanAdapter } from '../adapters/types';
import { buildTree } from './treeWalker';
import type { ListSnapshot, TreeNode } from './types';

/** 统计树中文件数（递归；ls 快照用，核心工具不依赖页面） */
export function countFiles(node: { children?: unknown[] }): number {
  if (!node.children) return 0;
  let n = 0;
  for (const c of node.children) {
    const item = c as { file?: { dir?: boolean }; children?: unknown[] };
    if (item.file?.dir) n += countFiles(item);
    else n += 1;
  }
  return n;
}

/** 资源列表获取配置 */
export interface ListFetchOptions {
  /** 提取码（无则空串） */
  passcode?: string;
  /** 遍历进度回调（目录节点级，用于进度条） */
  onProgress?: (done: number, total: number) => void;
}

/**
 * 执行一次完整的资源列表获取（scanner）。
 * @param adapter 适配器
 * @param shareId 分享 ID
 * @param url     分享链接（日志/快照用）
 * @param options 提取码 / 进度回调
 * @returns ListSnapshot（stoken + 目录树 + 统计）
 */
export async function fetchListSnapshot(
  adapter: PanAdapter,
  shareId: string,
  url: string,
  options?: ListFetchOptions,
): Promise<ListSnapshot> {
  // 第 1 步：token 二次校验（分享有效性：无效分享/提取码错误在此报错）
  const { stoken } = await adapter.getToken({ shareId, passcode: options?.passcode || undefined });
  // 第 2 步：目录树（递归 + 大小聚合，并发 3）
  const root = await buildTree(
    { adapter, shareId, stoken },
    {
      recursive: true,
      concurrency: 3,
      onProgress: (done, total) => options?.onProgress?.(done, total),
    },
  );
  return {
    shareId,
    url,
    adapterId: adapter.id,
    stoken,
    root,
    fetchedAt: Date.now(),
    fileCount: countFiles(root),
    totalSize: root.size,
  };
}

/** 时间戳 → HHMMSS（全局日志「当前HHMMSS」用） */
export function hhmmss(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 目录树文本渲染（全局日志打印用，非 md 导出）。
 * bars 风格：`|--- ` 前缀，每深一层追加 `|   `；目录附聚合大小，文件附大小。
 * 过长时由 UI 侧折叠（HistoryPage 全局日志渲染器检测 `=====目录树` 头自动折叠）。
 */
export function renderTreeText(root: TreeNode): string {
  const lines: string[] = [];
  const walk = (node: TreeNode, depth: number): void => {
    const isRoot = depth === 0;
    const prefix = isRoot ? '' : '|   '.repeat(depth - 1) + '|--- ';
    const name = isRoot
      ? `📁 ${node.file.fileName || 'root'}/`
      : `${node.file.fileName}${node.file.dir ? '/' : ''}`;
    const size = formatSize(node.size);
    lines.push(`${prefix}${name}${isRoot ? '' : `  (${size})`}`);
    if (node.children) {
      for (const child of node.children) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return lines.join('\n');
}

/** 字节 → 人类可读大小（本地小工具，避免引 tasks/export 的私有函数） */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = -1;
  do {
    v /= 1024;
    i += 1;
  } while (v >= 1024 && i < units.length - 1);
  return `${parseFloat(v.toFixed(2))} ${units[i]}`;
}
