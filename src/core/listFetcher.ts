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
import { addGlobalLog } from './footprint/globalLog';
import { buildTreeWithIssues } from './treeWalker';
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
  /**
   * v1.1.6 jumper：预置 stoken（从大宗 scanner 入库数据获取），非空时跳过 token 接口调用。
   * stoken 是分享访问令牌，没有它 detail 接口全部 401。
   */
  stoken?: string;
  /** v1.1.6 jumper：根节点条目（目标文件夹；缺省分享根占位） */
  rootFile?: import('../adapters/types').ShareFile;
  /** v1.1.6 jumper：根节点路径（目标文件夹绝对路径；缺省 "/"） */
  rootPath?: string;
  /** v1.1.6 jumper：根节点是否分享根（jumper 传 false，不带 banner/share 扩展字段） */
  rootIsShareRoot?: boolean;
  /**
   * v1.3.2 大宗目录阈值（一级对象数超此值则该目录不展开）；0/缺省 = 关闭。
   * 直接透传 buildTree（preferences.bulkThreshold，改动后下次获取资源列表生效）。
   */
  bulkThreshold?: number;
  /**
   * 扫描深度（契约 §3.4）：0/缺省 = 不限；1 = 只列根层（语义 depth < maxDepth、根 = 0）。
   * 调用方传 prefs.scanDepth；jumper（转到此文件夹）二次获取时深度从 0 重算。
   */
  maxDepth?: number;
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
  // v1.1.6 jumper：stoken 已由调用方从足迹缓存提供（大宗 scanner 入库数据），跳过 token 接口
  let stoken = options?.stoken ?? '';
  if (!stoken) {
    ({ stoken } = await adapter.getToken({ shareId, passcode: options?.passcode || undefined }));
  }
  // 第 2 步：目录树（递归 + 大小聚合，并发 2 + 同目录翻页节流 250ms，v1.1.6）
  // v1.3.2：遍历同时收集 issues（失败目录 / 大宗跳过目录），回填 ListSnapshot.issues
  const { root, issues } = await buildTreeWithIssues(
    { adapter, shareId, stoken },
    {
      recursive: true,
      concurrency: 2,
      onProgress: (done, total) => options?.onProgress?.(done, total),
      // v1.1.6 jumper：从分享内文件夹开始扫描（0B 文件夹二次获取）
      rootFile: options?.rootFile,
      rootPath: options?.rootPath,
      rootIsShareRoot: options?.rootIsShareRoot,
      // v1.3.2：大宗目录阈值透传（0/缺省 = 关闭）
      bulkThreshold: options?.bulkThreshold,
      // v1.3.2（§3.4）：扫描深度透传（0/缺省 = 不限）
      maxDepth: options?.maxDepth,
    },
  );
  // 失败目录写全局日志（v1.3.2 契约 §1）：便于事后排查哪些目录没扫到
  for (const issue of issues) {
    if (issue.kind === 'failed') {
      addGlobalLog(
        `scanner：目录 ${issue.path} 未加载成功（业务码 ${issue.code}）：${issue.message}`,
      );
    }
  }
  return {
    shareId,
    url,
    adapterId: adapter.id,
    stoken,
    root,
    fetchedAt: Date.now(),
    fileCount: countFiles(root),
    totalSize: root.size,
    issues,
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
 * bars 风格：`|--- ` 前缀，每深一层追加 `|   `；目录附聚合大小 + fid（v1.1.6，
 * 供分析 0B 文件夹手动拼跳转链接；导出目录树 md 不包含这些数据），文件附大小。
 * 过长时由 UI 侧折叠（HistoryPage 全局日志渲染器检测 `=====目录树` 头自动折叠）。
 * v1.3.2：目录行额外标注失败（业务码）/大宗跳过（便于全局日志排查），其他格式不变。
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
    // v1.1.6：目录行附 fid（0B 文件夹排查/手动跳转用），文件行不附
    const fidPart = node.file.dir ? ` · fid:${node.file.fid}` : '';
    // v1.3.2：失败/大宗目录行内标注（两者互斥，失败优先）
    const note = node.scanError
      ? `（未加载成功·业务码 ${node.scanError.code}）`
      : node.bulkSkipped
        ? `（大宗目录 ${node.bulkSkipped.count} 项，已跳过）`
        : '';
    lines.push(`${prefix}${name}${isRoot ? '' : `  (${size}${fidPart})`}${note}`);
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
