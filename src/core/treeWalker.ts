/**
 * 目录树递归遍历（docs/STRUCTURE.md：src/core/treeWalker.ts）
 *
 * 职责：对任意 PanAdapter（core 零网盘依赖）做"单层 list → 递归建树"的通用遍历：
 * - 分页：ListResult.total（来自 metadata._total）> 已收集数时递增 page 继续拉，
 *   同目录页间节流 pageIntervalMs（默认 250ms，v1.1.6 防风控）
 * - 并发：同时最多 concurrency（默认 2，v1.1.6 从 3 降为 2）个 list 请求（手写小信号量）
 * - 聚合：目录 size = 子树递归聚合；aggregateSize=false 时目录 size 记 0 且不建 children
 * - 根节点可替换（v1.1.6 jumper）：rootFile/rootPath/rootIsShareRoot 支持从分享内
 *   某个文件夹开始扫描（风控 0B 文件夹二次获取）
 * - 容错：单个目录拉取失败 → 该目录 size 记 0、children 置 undefined，不中断整体
 *   （契约无错误字段，失败目录靠 size=0 + children=undefined 这一约定呈现，见 buildDir 注释）
 *
 * 进度语义（onProgress）：每完成一个【目录节点】触发一次 (done, total, current)，
 * done = 已完成目录数，total = 目前已发现目录数（预估总量，随遍历单调增长）。
 * 文件节点不需要发请求，不逐个回调，避免海量回调。
 */
import type { ListResult, ShareFile } from '../adapters/types';
import type { TreeContext, TreeNode, TreeWalkOptions } from './types';

/** 根目录占位文件（path="/" 时使用；fid "0" 与适配器根目录约定一致） */
const ROOT_FILE: ShareFile = {
  fid: '0',
  fileName: '分享根',
  dir: true,
  size: 0,
};

/** 每页条数（与适配器 ListParams.size 默认一致） */
const PAGE_SIZE = 50;

/** 同目录翻页间隔（默认 250ms，v1.1.6 目录翻页节流防风控） */
const DEFAULT_PAGE_INTERVAL_MS = 250;

/** sleep（翻页节流用） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 手写小信号量：限制同时进行的 list 请求数，超过上限的调用排队等待。
 * 唤醒语义：release 时若队列非空，把许可直接移交给队首等待者（active 不增不减）。
 */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  /** 执行任务（并发超限时排队） */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next(); // 许可移交：active 保持不变，新任务直接拿到槽位
    } else {
      this.active--;
    }
  }
}

/** 子路径拼接：根目录下直接 "/name"，深层 "parent/name" */
function joinPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

/**
 * 拉取一个目录的全部条目（自动翻页直到 total 收齐）。
 * 分页规则：ListResult.total 缺失视为只有一页；files.length >= total 说明收齐；
 * 单页返回空数组时兜底跳出，防止 total 异常导致死循环。
 */
async function listAll(
  ctx: TreeContext,
  sem: Semaphore,
  fid: string,
  isRoot: boolean,
  pageIntervalMs: number,
): Promise<ShareFile[]> {
  const files: ShareFile[] = [];
  let page = 1;
  for (;;) {
    const res: ListResult = await sem.run(() =>
      ctx.adapter.list({
        shareId: ctx.shareId,
        stoken: ctx.stoken,
        pdirFid: fid,
        page,
        size: PAGE_SIZE,
        isRoot,
      }),
    );
    files.push(...res.files);
    const total = res.total;
    if (total === undefined || files.length >= total || res.files.length === 0) {
      break;
    }
    page++;
    // v1.1.6 目录翻页节流：同目录页间 250ms，防大宗扫描风控
    await sleep(pageIntervalMs);
  }
  return files;
}

/**
 * 构建分享目录树（token 三连之后的第 2 步）。
 * @param ctx     遍历上下文（adapter/shareId/stoken，见 core/types.ts）
 * @param options 遍历配置（recursive/maxDepth/concurrency/aggregateSize/onProgress）
 * @returns 根节点（path="/"，file 为占位"分享根"，size = 全树聚合）
 */
export async function buildTree(
  ctx: TreeContext,
  options?: TreeWalkOptions,
): Promise<TreeNode> {
  const recursive = options?.recursive ?? true;
  const maxDepth = options?.maxDepth ?? 0; // 0 = 不限
  const concurrency = Math.max(1, options?.concurrency ?? 2); // v1.1.6：默认 2 防风控
  const pageIntervalMs = Math.max(0, options?.pageIntervalMs ?? DEFAULT_PAGE_INTERVAL_MS);
  const aggregateSize = options?.aggregateSize ?? true;
  const onProgress = options?.onProgress;
  // v1.1.6 jumper：根节点可替换为分享内某个文件夹（0B 文件夹二次获取）
  const rootFile = options?.rootFile ?? ROOT_FILE;
  const rootPath = options?.rootPath ?? '/';
  const rootIsShareRoot = options?.rootIsShareRoot ?? true;

  // 是否递归展开子目录：recursive 与 aggregateSize 同时为 true 才遍历。
  // 不聚合目录大小时按契约"size 记 0 且不建 children"，可省掉整棵子目录遍历。
  const expandDirs = recursive && aggregateSize;

  const sem = new Semaphore(concurrency);
  let done = 0; // 已完成目录数
  let total = 1; // 预估总数：已发现目录数（根算 1 个，随发现递增）

  /** 是否应该拉取/展开某个深度的目录（根 = 0；maxDepth=0 不限） */
  const shouldExpand = (depth: number): boolean => maxDepth === 0 || depth < maxDepth;

  /**
   * 递归构建目录节点。
   * 失败约定：目录拉取失败时 size 记 0、children 置 undefined（契约无错误字段，
   * 调用方/UI 可据"目录节点 children===undefined 且 size===0"判断该目录未加载成功）。
   */
  const buildDir = async (
    entry: ShareFile,
    path: string,
    depth: number,
    isRoot: boolean,
  ): Promise<TreeNode> => {
    const node: TreeNode = { file: entry, path, depth, size: 0 };

    // 根目录总是拉取（至少要展示根层）；子目录仅在允许递归且未超出 maxDepth 时拉取
    const shouldList = isRoot || (expandDirs && shouldExpand(depth));
    if (!shouldList) {
      // 未展开的目录：叶子节点（size 0、无 children），同时算作完成，参与进度统计
      done++;
      onProgress?.(done, total, node);
      return node;
    }

    try {
      const entries = await listAll(ctx, sem, entry.fid, isRoot, pageIntervalMs);
      // 兄弟目录并发构建（list 并发由信号量限流），文件节点同步生成
      const childNodes: TreeNode[] = await Promise.all(
        entries.map((child) => {
          const childPath = joinPath(path, child.fileName);
          if (child.dir) {
            total++; // 发现一个待遍历目录，更新预估总数
            return buildDir(child, childPath, depth + 1, false);
          }
          return Promise.resolve({
            file: child,
            path: childPath,
            depth: depth + 1,
            size: child.size,
          } satisfies TreeNode);
        }),
      );
      node.children = childNodes;
      // 目录大小 = 子树递归聚合（文件=自身 size；未展开/失败子目录=0）
      node.size = childNodes.reduce((sum, child) => sum + child.size, 0);
    } catch {
      // 单个目录拉取失败：size 记 0、children 置 undefined，不中断整体遍历
      node.size = 0;
      node.children = undefined;
    }
    done++;
    onProgress?.(done, total, node);
    return node;
  };

  return buildDir(rootFile, rootPath, 0, rootIsShareRoot);
}
