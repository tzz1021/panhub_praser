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
 * - 容错（v1.3.2 失败可见）：单个目录拉取失败 → 该目录记 scanError（业务码 + 文案），
 *   size 记 0、children 置 undefined，不中断整体；同时推进 issues（ScanIssue，kind:'failed'）
 * - 大宗过滤（v1.3.2）：某目录一级对象数 > bulkThreshold → 记 bulkSkipped 且不递归
 *   （保持折叠，可用「转到此文件夹」单独扫描）；同时推进 issues（kind:'bulk'）
 *   不变量：scanError 与 bulkSkipped 互斥（失败优先），两者存在时 children 必为 undefined。
 *   反例（禁止）：用 children===undefined && size===0 表达任何语义 —— 空目录/失败/大宗混在一起
 *
 * 进度语义（onProgress）：每完成一个【目录节点】触发一次 (done, total, current)，
 * done = 已完成目录数，total = 目前已发现目录数（预估总量，随遍历单调增长）。
 * 文件节点不需要发请求，不逐个回调，避免海量回调。
 */
import type { ListResult, ShareFile } from '../adapters/types';
import type { ScanIssue, TreeContext, TreeNode, TreeWalkOptions } from './types';

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
 *
 * v1.3.2 大宗过滤（快通道）：首屏 total 存在且 > bulkThreshold 时**立刻返回**
 * （不再翻页；调用方据此判定大宗并丢弃已收条目）。
 * @returns files = 已收条目（快通道提前返回时为首页条目）；total = 首屏 total（无则 undefined）
 */
async function listAll(
  ctx: TreeContext,
  sem: Semaphore,
  fid: string,
  isRoot: boolean,
  pageIntervalMs: number,
  bulkThreshold = 0,
): Promise<{ files: ShareFile[]; total?: number }> {
  const files: ShareFile[] = [];
  let levelTotal: number | undefined; // 首屏（一级）total，无 total 的网盘保持 undefined
  let page = 1;
  // v1.2.x alipan：next_marker 游标制分页 —— 上一次响应的游标原样传回适配器翻页
  let marker: string | undefined;
  // 游标制兜底上限（50 条/页 × 200 页 = 1 万条/目录），防异常游标链死循环
  const MAX_MARKER_PAGES = 200;
  for (;;) {
    const res: ListResult = await sem.run(() =>
      ctx.adapter.list({
        shareId: ctx.shareId,
        stoken: ctx.stoken,
        pdirFid: fid,
        page,
        size: PAGE_SIZE,
        isRoot,
        marker, // 页码制网盘（uc/quark）忽略
      }),
    );
    files.push(...res.files);
    if (page === 1) {
      levelTotal = typeof res.total === 'number' ? res.total : undefined;
      // v1.3.2 快通道：一级 total 已超阈值 → 立刻判定大宗，不再翻页、不递归
      if (bulkThreshold > 0 && levelTotal !== undefined && levelTotal > bulkThreshold) {
        return { files, total: levelTotal };
      }
    }
    // 单页空返回：兜底跳出（与 total 制同规则），防异常导致死循环
    if (res.files.length === 0) {
      break;
    }
    // 游标制优先：有 nextMarker 就按游标翻页，total 制逻辑仅对页码制网盘生效
    const nextMarker = typeof res.nextMarker === 'string' && res.nextMarker !== '' ? res.nextMarker : null;
    if (nextMarker) {
      if (page >= MAX_MARKER_PAGES) {
        break;
      }
      marker = nextMarker;
      page++;
      await sleep(pageIntervalMs); // v1.1.6 同款：同目录页间节流，防大宗扫描风控
      continue;
    }
    const total = res.total;
    if (total === undefined || files.length >= total) {
      break;
    }
    page++;
    // v1.1.6 目录翻页节流：同目录页间 250ms，防大宗扫描风控
    await sleep(pageIntervalMs);
  }
  return { files, total: levelTotal };
}

/** 从适配器抛出的错误里取业务码（数字/字符串码原样用，其余记 'unknown'） */
function extractCode(err: unknown): number | string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'number' || typeof code === 'string' ? code : 'unknown';
}

/** 遍历产物：目录树根节点 + 扫描问题清单（v1.3.2） */
export interface TreeWalkResult {
  root: TreeNode;
  /** 本次遍历的问题清单（失败目录 / 大宗跳过目录；空数组 = 全部正常） */
  issues: ScanIssue[];
}

/**
 * 构建分享目录树（token 三连之后的第 2 步）。
 * @param ctx     遍历上下文（adapter/shareId/stoken，见 core/types.ts）
 * @param options 遍历配置（recursive/maxDepth/concurrency/aggregateSize/bulkThreshold/onProgress）
 * @returns 根节点（path="/"，file 为占位"分享根"，size = 全树聚合）
 */
export async function buildTree(
  ctx: TreeContext,
  options?: TreeWalkOptions,
): Promise<TreeNode> {
  return (await buildTreeWithIssues(ctx, options)).root;
}

/**
 * 同 buildTree，额外返回遍历期间收集的 issues（v1.3.2：失败/大宗可见，listFetcher 回填 ListSnapshot）。
 */
export async function buildTreeWithIssues(
  ctx: TreeContext,
  options?: TreeWalkOptions,
): Promise<TreeWalkResult> {
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
  // v1.3.2 大宗目录阈值：0/缺省 = 关闭本机制（行为与 1.3.1 完全一致）
  const rawBulkThreshold = options?.bulkThreshold ?? 0;
  const bulkThreshold =
    Number.isFinite(rawBulkThreshold) && rawBulkThreshold > 0
      ? Math.floor(rawBulkThreshold)
      : 0;
  /** 扫描问题清单（失败 + 大宗跳过），随遍历推进 */
  const issues: ScanIssue[] = [];

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
   * v1.3.2 语义约定（三种「0B 目录」严格分开，禁止只看 children/size）：
   * - 加载失败：scanError 有值（code/message），size=0、children=undefined
   * - 大宗跳过：bulkSkipped 有值（count/threshold），size=0、children=undefined
   * - 空目录：无 scanError/bulkSkipped，children=[]（真·空）
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
      const { files: entries, total: levelTotal } = await listAll(
        ctx,
        sem,
        entry.fid,
        isRoot,
        pageIntervalMs,
        bulkThreshold,
      );
      // v1.3.2 大宗判定（只看一级对象数）：快通道用首屏 total，慢通道（无 total 的
      // alipan/xunlei）用收齐后的一级条目数；超阈值 → 保持折叠、不递归、不建 children
      const levelCount = levelTotal !== undefined ? levelTotal : entries.length;
      if (bulkThreshold > 0 && levelCount > bulkThreshold) {
        node.bulkSkipped = { count: levelCount, threshold: bulkThreshold };
        node.size = 0;
        node.children = undefined;
        issues.push({
          path,
          fid: entry.fid,
          kind: 'bulk',
          count: levelCount,
          threshold: bulkThreshold,
        });
        done++;
        onProgress?.(done, total, node);
        return node;
      }
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
    } catch (err) {
      // 单个目录拉取失败（v1.3.2 失败可见）：记 scanError + size=0 + children=undefined，
      // 不中断整体遍历；同时推进 issues 供结果页 banner/行内提示/全局日志排查
      const code = extractCode(err);
      const message = err instanceof Error ? err.message : String(err);
      node.scanError = { code, message };
      node.size = 0;
      node.children = undefined;
      issues.push({ path, fid: entry.fid, kind: 'failed', code, message });
    }
    done++;
    onProgress?.(done, total, node);
    return node;
  };

  const root = await buildDir(rootFile, rootPath, 0, rootIsShareRoot);
  return { root, issues };
}
