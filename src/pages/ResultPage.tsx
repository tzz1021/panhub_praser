/**
 * 结果页（docs/STRUCTURE.md：src/pages/ResultPage.tsx）—— 核心页
 *
 * 目录树 + 勾选 → prase 批量直链（15/批 + 1s 节流，窗口内复用已解析直链）→ 导出。
 * v1.1.4：术语分离 —— scanner（获取资源列表，原 ls）与 prase（解析下载方式）分开；
 * 头部「资源列表获取于 xx」+ 绿按钮「获取最新资源列表」强制刷新 scanner。
 * v1.1.5：直链状态标签下沉到文件行，移除顶部倒计时。
 * v1.1.5.3：移除每行 status 文本（保留行底色）；prase 产物按 fid 落库（足迹恢复复用）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { ShareFile } from '../adapters/types';
import { DirectoryTree, collectLeaves, flattenTree } from '../components/DirectoryTree';
import type { TreeRow } from '../components/DirectoryTree';
import { FileCheckbox } from '../components/FileCheckbox';
import { CookieWarnModal } from '../components/CookieWarnModal';
import { DownloaderModal } from '../components/DownloaderModal';
import { ExportFailModal } from '../components/ExportFailModal';
import { ParseFailModal } from '../components/ParseFailModal';
import { CloudflareWarnModal } from '../components/CloudflareWarnModal';
import { JumptoFolderTipModal } from '../components/JumptoFolderTipModal';
import { HiddenVolumnModal } from '../components/HiddenVolumnModal';
import { ExportYellowModal } from '../components/ExportYellowModal';
import { RestoreCollapsedModal } from '../components/RestoreCollapsedModal';
import { useToast } from '../components/Toast';
import { fetchLinks } from '../core/linkFetcher';
import { fetchListSnapshot, renderTreeText, hhmmss } from '../core/listFetcher';
import { getPreferences } from '../core/preferences';
import { addRecord } from '../core/footprint/records';
import { appendLog, listLogs, exportLogsMd } from '../core/footprint/logs';
import { addGlobalLog } from '../core/footprint/globalLog';
import { saveTree } from '../core/footprint/trees';
import { savePraseEntries, listPraseByShareId, clearPraseByShareId } from '../core/footprint/prase';
import { getPugs } from '../adapters/uc/cookies';
import { exportTask, exportTreeMd } from '../tasks/export';
import { loadDownloaderConfig } from '../utils/downloader';
import { formatRemain, formatSize, formatTime } from '../utils/format';
import { getExpiry, isLinkGreen, isLinkUsable, isLinkYellow, linkDetailOf } from '../utils/linkStatus';
import type { ExportFile, LinkEntry, LinkResult, ParseSession, TaskKind, TreeNode } from '../core/types';
import { linkAbbr } from './HomePage';

/** 文件相对路径的父目录 */
function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '/';
}

/** 下载文件（Blob 直存，文件名来自导出器） */
function downloadFile(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

export interface ResultPageProps {
  session: ParseSession;
  onBack: () => void;
  /** v1.1.6 jumper：跳转文件夹（回输入页自动触发新任务） */
  onJump: (url: string) => void;
}

const KIND_LABEL: Record<TaskKind, string> = { aria2: 'aria2', gopeed: 'Gopeed', curl: 'cURL' };

export function ResultPage({ session, onBack, onJump }: ResultPageProps): JSX.Element {
  const { adapter, shareId, url } = session;
  const { toast } = useToast();

  const prefs = useMemo(() => getPreferences(), []);
  const downloader = useMemo(() => loadDownloaderConfig(), []);

  // v1.1.4：资源列表（ls）在结果页可刷新 —— 目录树/stoken/获取时间改为本地状态
  const [root, setRoot] = useState<TreeNode>(session.root);
  const [stoken, setStoken] = useState(session.stoken);
  const [listAt, setListAt] = useState(session.parsedAt);
  const [refreshingList, setRefreshingList] = useState(false);

  // 全部叶子文件（一次计算，树固定）
  const allLeaves = useMemo(() => collectLeaves(root), [root]);
  const allDirIds = useMemo(() => {
    const set = new Set<string>();
    const walk = (n: { file: ShareFile; children?: unknown[] }): void => {
      if (n.file.dir && n.children) {
        set.add(n.file.fid);
        for (const c of n.children) walk(c as never);
      }
    };
    walk(root);
    return set;
  }, [root]);

  // v1.1.7：目录折叠状态本地保存（按分享），复用期间可恢复
  const collapsedKey = `panhub:collapsed:${session.shareId}`;
  const readCollapsed = (): { fids: string[]; savedAt: number } | null => {
    try {
      const raw = window.localStorage.getItem(collapsedKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { fids: string[]; savedAt: number };
      if (!Array.isArray(parsed?.fids)) return null;
      return parsed;
    } catch {
      return null;
    }
  };
  const writeCollapsed = (fids: ReadonlySet<string>): void => {
    try {
      window.localStorage.setItem(collapsedKey, JSON.stringify({ fids: [...fids], savedAt: Date.now() }));
    } catch {
      /* 配额/隐私模式静默 */
    }
  };
  // 折叠状态初始：复用会话（fromCache）且非「丢弃」时优先恢复上次状态，否则默认全展开
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const saved = readCollapsed();
    if (session.fromCache && saved && prefs.restoreCollapsed !== 'discard') {
      return new Set(saved.fids.length > 0 ? saved.fids : allDirIds);
    }
    return new Set(allDirIds);
  });
  // 保存折叠状态（任何展开/收起变化都记；同值重复保存无害）
  useEffect(() => {
    writeCollapsed(expanded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);
  // 复用 + 「每次询问」→ 弹窗询问是否恢复上次折叠状态
  useEffect(() => {
    if (!session.fromCache || prefs.restoreCollapsed !== 'ask') return;
    const saved = readCollapsed();
    if (!saved || saved.fids.length === 0) return;
    const d = new Date(saved.savedAt);
    const p = (n: number): string => String(n).padStart(2, '0');
    setRestoreAsk({ savedAtLabel: `${p(d.getHours())}:${p(d.getMinutes())}` });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.fromCache]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [filterText, setFilterText] = useState('');
  const [links, setLinks] = useState<Map<string, LinkEntry> | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchProgress, setFetchProgress] = useState<{ done: number; total: number } | null>(null);
  const [exportKind, setExportKind] = useState<TaskKind>('aria2');
  const [keepStructure, setKeepStructure] = useState(prefs.keepStructure);
  const [exportFail, setExportFail] = useState(false);
  const [parseFail, setParseFail] = useState<{ fileName: string } | null>(null);
  // v1.1.5.2 兜底：pages.dev 代理 + 同分秒重复解析 → 强制提示
  const [cloudflareWarn, setCloudflareWarn] = useState(false);
  // v1.1.6 jumper：0B 文件夹「转到此文件夹」提示弹窗
  const [jumpWarn, setJumpWarn] = useState<{ jumpUrl: string; folderPath: string; originalTitle: string } | null>(null);
  // v1.1.7 隐秘参数：<> 按钮弹窗（确认后新标签直连官方 API，url 在 open 时算好）
  const [hiddenVolumn, setHiddenVolumn] = useState<{ url: string; title: string; body: string } | null>(null);
  // v1.1.7 导出包含黄色标记 → 弹窗模式（设置开关控制，关=简略 toast）
  const [exportYellow, setExportYellow] = useState(false);
  // v1.1.7 折叠状态恢复询问弹窗
  const [restoreAsk, setRestoreAsk] = useState<{ savedAtLabel: string } | null>(null);
  // v1.1.7 资源列表首次获取时间：会话内固定不变（刷新只更新 listAt），
  // 头部显示「首次获取于 xx · 最后刷新于 xx」时 firstAt 即本次会话的初始获取时间
  const [firstAt] = useState(session.parsedAt);
  const [downloaderOpen, setDownloaderOpen] = useState(false);
  // §12 顺序固化：prase（解析下载方式）阶段才需要 cookie —— 弹窗确认后预热 + 继续
  const [cookieWarn, setCookieWarn] = useState<{ files: ShareFile[] } | null>(null);
  const pendingFetch = useRef<ShareFile[] | null>(null);
  const [, setTick] = useState(0); // 倒计时刷新

  // 倒计时：链接存在时每 30s 刷新
  useEffect(() => {
    if (!links) return;
    const timer = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, [links]);

  // v1.1.5.3：进入结果页从足迹恢复本分享已解析的直链（按 fid 复用）——
  // 未过期直链直接可导出/标绿，不再请求接口（proxy 被恶意刷爆时尤为重要）；读不到就正常显示解析按钮。
  useEffect(() => {
    let alive = true;
    void listPraseByShareId(session.shareId)
      .then((restored) => {
        if (!alive || restored.size === 0) return;
        setLinks((prev) => {
          const next = new Map(prev ?? []);
          for (const [fid, entry] of restored) {
            if (!next.has(fid)) next.set(fid, entry);
          }
          return next;
        });
        addGlobalLog(`scanner：从足迹恢复 ${restored.size} 条已解析直链（按 fid 复用，过期/失败项自动走原状态）`);
      })
      .catch(() => {
        /* 读不到就正常显示解析按钮，不影响主流程 */
      });
    return () => {
      alive = false;
    };
  }, [session.shareId]);

  // 过滤可见文件
  const visibleLeaves = useMemo(() => {
    if (!filterText) return allLeaves;
    const kw = filterText.toLowerCase();
    return allLeaves.filter((f) => f.fileName.toLowerCase().includes(kw));
  }, [allLeaves, filterText]);

  // 勾选集合与可见集合的交集（保证过滤后全选只影响可见）
  const selectedFiles = useMemo(() => {
    const set = new Set(checked);
    return visibleLeaves.filter((f) => set.has(f.fid));
  }, [checked, visibleLeaves]);

  // 树扁平行（按展开状态）+ fid → 树节点查找（先声明，后续 useMemo 使用）
  const flatRows: TreeRow[] = useMemo(() => flattenTree(root, expanded), [root, expanded]);
  const leafNodeOf = (fid: string): TreeNode | undefined =>
    flatRows.find((r) => r.node.file.fid === fid && !r.node.file.dir)?.node;

  // v1.1.6 显示属性：每个目录的直接文件数 / 子文件夹数（单次遍历预计算，避免逐行递归）
  const dirProps = useMemo(() => {
    const map = new Map<string, { files: number; dirs: number }>();
    const walk = (n: TreeNode): void => {
      if (!n.file.dir || !n.children) return;
      let files = 0;
      let dirs = 0;
      for (const c of n.children) {
        if (c.file.dir) {
          dirs++;
          walk(c);
        } else {
          files++;
        }
      }
      map.set(n.file.fid, { files, dirs });
    };
    walk(root);
    return map;
  }, [root]);

  // 跨文件夹判断：选中文件父目录数 > 1
  const crossFolder = useMemo(() => {
    const parents = new Set<string>();
    for (const f of selectedFiles) {
      const node = leafNodeOf(f.fid);
      if (node) parents.add(parentOf(node.path));
    }
    return parents.size > 1;
  }, [selectedFiles, flatRows]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedSize = selectedFiles.reduce((s, f) => s + (f.size ?? 0), 0);

  /* ---------- 勾选操作 ---------- */
  const toggleFile = (fid: string): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(fid)) next.delete(fid);
      else next.add(fid);
      return next;
    });
  };

  const toggleDirAll = (node: { file: ShareFile; children?: unknown[] }): void => {
    const leaves = collectLeaves(node as never);
    setChecked((prev) => {
      const next = new Set(prev);
      const allChecked = leaves.every((f) => next.has(f.fid));
      for (const f of leaves) {
        if (allChecked) next.delete(f.fid);
        else next.add(f.fid);
      }
      return next;
    });
  };

  const selectVisible = (mode: 'all' | 'invert' | 'none'): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const f of visibleLeaves) {
        if (mode === 'all') next.add(f.fid);
        else if (mode === 'none') next.delete(f.fid);
        else if (next.has(f.fid)) next.delete(f.fid);
        else next.add(f.fid);
      }
      return next;
    });
  };

  // v1.1.7：按直链状态批量勾选（绿/黄/红/未解析/已过期；基于当前解析结果离线判定）
  const selectByStatus = (kind: 'green' | 'yellow' | 'red' | 'unparsed' | 'expired'): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const f of visibleLeaves) {
        const detail = linkDetailOf(links?.get(f.fid), prefs.reuseWindowHours, f.size);
        const match =
          kind === 'green'
            ? detail.kind === 'green'
            : kind === 'yellow'
              ? detail.kind === 'yellow'
              : kind === 'red'
                ? detail.kind === 'failed' || detail.kind === 'terminated'
                : kind === 'expired'
                  ? detail.kind === 'expired'
                  : detail.kind === 'none';
        if (match) next.add(f.fid);
        else next.delete(f.fid);
      }
      return next;
    });
  };

  /* ---------- 批量直链（prase：解析下载方式） ---------- */
  /**
   * prase 入口（§12 顺序固化：ls 不需要 cookie，prase 才需要）：
   * 需 cookie 的网盘（UC）→ 先弹窗展示捕获状态（明文，默认开），确认后拉直链。
   * v1.1.4：窗口内已解析且未过期的文件直接复用（oss+sig），全部命中时跳过 cookie 弹窗。
   * 不做“跳转取 cookie”预热 —— §12 实测：oss 直链与 __pugs 必须同响应绑定，
   * 跨环境取值无意义（跳转只影响浏览器 jar，与导出链路无关）。
   */
  const requestFetchLinks = (files: ShareFile[]): void => {
    if (files.length === 0) {
      toast('请先勾选要解析的文件', 'error');
      return;
    }
    if (fetching) return;
    pendingFetch.current = files;
    addGlobalLog('=====解析下载方式（prase）=====');
    addGlobalLog(`prase：选中 ${files.length} 个文件（窗口 ${prefs.reuseWindowHours}h 内已解析直链自动复用）`);
    // 全部命中缓存直链 → 无需 cookie，直接走复用合并
    if (files.every((f) => isReusable(f.fid))) {
      addGlobalLog('prase：全部命中缓存直链，跳过 cookie 弹窗');
      void doFetchLinks(files);
      return;
    }
    if (adapter.cookie && prefs.modals.cookieWarn) {
      addGlobalLog(`prase：需要 ${adapter.cookie.displayName} —— 弹窗已出现，等待用户选择（当前捕获 ${getPugs() ? '有值' : '为空'}，解析后代理捕获自动更新）`);
      setCookieWarn({ files });
      return;
    }
    void doFetchLinks(files);
  };

  /**
   * 是否可复用缓存直链（v1.1.5.2）：绿 + 黄（窗口内且 oss 未过期）都可复用/导出，
   * 黄色只是剩余时间不够完整下载（导出后会有提示 toast）。
   */
  const isReusable = (fid: string): boolean => {
    const f = leafNodeOf(fid)?.file;
    return isLinkUsable(links?.get(fid), prefs.reuseWindowHours, f?.size);
  };

  /** 真正执行 prase（每个下载响应下发的 __pugs 与该响应的直链绑定，§12） */
  const doFetchLinks = async (files: ShareFile[]): Promise<void> => {
    setFetching(true);
    setFetchProgress({ done: 0, total: files.length });
    try {
      // ① 窗口内复用：未过期直链直接并入结果，不请求接口
      const toFetch: ShareFile[] = [];
      const reused = new Map<string, LinkEntry>();
      for (const f of files) {
        if (isReusable(f.fid)) {
          reused.set(f.fid, links!.get(f.fid)!);
        } else {
          toFetch.push(f);
        }
      }
      if (reused.size > 0) {
        addGlobalLog(`prase：复用缓存直链 ${reused.size}/${files.length}（窗口内 oss+sig 未过期，不再请求接口）`);
      }
      // ② 新文件走接口（15/批 + 1s 节流）
      let results: LinkResult[] = [];
      if (toFetch.length > 0) {
        addGlobalLog(`prase：发起接口请求 ${toFetch.length} 个（15/批 + 1s 节流）`);
        results = await fetchLinks(
          { adapter, shareId, stoken },
          toFetch,
          { batchSize: 15, batchIntervalMs: 1000, continueOnError: true },
        );
        addGlobalLog(`prase：接口完成 — ${results.filter((r) => r.ok).length}/${toFetch.length} 成功`);
      }
      const map = new Map<string, LinkEntry>();
      let okCount = 0;
      reused.forEach((entry, fid) => {
        okCount++;
        map.set(fid, entry);
      });
      results.forEach((r, i) => {
        const f = toFetch[i];
        if (r.ok) okCount++;
        map.set(f.fid, {
          ok: r.ok,
          url: r.url,
          error: r.error,
          fetchedAt: Date.now(),
          cookie: r.cookie, // §12：与该直链同响应的 __pugs
        });
      });
      setLinks((prev) => new Map([...(prev ?? []), ...map]));
      // v1.1.5.3：prase 产物按 fid 落库（开发日志足迹），下次进来自动恢复复用；
      // 失败/终止条目也落库（红色状态跨刷新保留），过期条目由 linkDetailOf 判定后走正常解析按钮
      if (prefs.footprint.keepLogs) {
        await savePraseEntries(shareId, map).catch(() => undefined);
      }
      // 捕获状态反馈（弹窗已展示过，这里给个结果）：
      if (adapter.cookie) {
        const withCookie = [...map.values()].filter((l) => l.ok && l.cookie).length;
        addGlobalLog(`prase：下载凭据已按文件绑定（${withCookie}/${map.size} 个链接携带同响应 ${adapter.cookie.key}）`);
        if (withCookie === 0) {
          addGlobalLog(`prase：未捕获到 ${adapter.cookie.key} —— 请检查代理通道（x-pugs 头）是否可用，否则导出命令将缺下载凭据`);
        }
      }
      // v1.1.5：解析结果留痕到全局日志（折叠块，仅追踪用，本日志可随时删除；不参与恢复）
      {
        const lines = files.map((f) => {
          const entry = map.get(f.fid);
          const node = leafNodeOf(f.fid);
          const path = node?.path ?? f.fileName;
          const size = f.size ? formatSize(f.size) : '大小未知';
          const type = f.formatType ? ` · ${f.formatType}` : '';
          const cred = entry?.cookie ? `${entry.cookie.key} 有(${entry.cookie.value.length}字符)` : `${adapter.cookie?.key ?? 'cookie'} 无`;
          if (!entry?.ok) return `${path} · ${size}${type} · 失败${entry?.error ? `（${entry.error}）` : ''}`;
          const remain = (() => {
            const exp = getExpiry(entry.url);
            if (exp === null) return '无Expires'; // 罕见：oss 未带过期参数
            return exp <= Date.now() ? '已过期' : `剩${formatRemain(exp - Date.now())}`;
          })();
          // v1.1.5.3：附直链 URL（分析用），折叠块可一键复制
          return `${path} · ${size}${type} · ${cred} · ${remain} · ${entry.url}`;
        });
        addGlobalLog(`=====解析结果（${files.length} 个文件 · 留痕追踪，本日志可随时删除）=====\n${lines.join('\n')}\n=====解析结果结束=====`);
      }
      const abbr = linkAbbr(url, adapter.id);
      await addRecord({
        shareId,
        url,
        adapterId: adapter.id,
        parsedAt: Date.now(),
        ok: okCount === files.length,
        fileCount: okCount,
        error: okCount === files.length ? undefined : `${files.length - okCount} 个文件失败`,
        kind: 'prase', // v1.1.7：历史页按记录类型显示「解析文件成功」
        filePath: files.length === 1 ? (leafNodeOf(files[0].fid)?.path ?? files[0].fileName) : undefined,
      });
      if (prefs.footprint.keepLogs) {
        await appendLog({
          time: Date.now(),
          level: okCount === files.length ? 'info' : 'debug',
          adapterId: adapter.id,
          url,
          message: `解析下载方式：${abbr}，${okCount}/${files.length} 成功（复用 ${reused.size}）`,
        });
      }
      // ③ 单文件解析失败 → 醒目弹窗（v1.1.4 规范：打开发 modal，关闭发 toast）
      if (files.length === 1 && okCount === 0) {
        if (prefs.modals.parseFailWarn) {
          setParseFail({ fileName: files[0].fileName });
        } else {
          toast('解析失败，该文件可能已经与供应商断开连接或者在分享中被删除，请刷新资源列表后再试', 'error');
        }
      } else {
        toast(
          okCount === files.length
            ? `解析完成：${okCount} 个文件全部成功`
            : `部分失败：${okCount}/${files.length} 成功，可重试失败项`,
          okCount === files.length ? 'success' : 'error',
        );
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : '批量解析失败', 'error');
    } finally {
      setFetching(false);
      setFetchProgress(null);
    }
  };

  const retryFailed = (): void => {
    // v1.1.5.2：不可用直链（无/失败/过期）算失败项，可一键重试；绿色/黄色不重试
    const failed = selectedFiles.filter((f) => {
      const l = links?.get(f.fid);
      return !isLinkUsable(l, prefs.reuseWindowHours, f.size);
    });
    requestFetchLinks(failed);
  };

  /* ---------- 刷新资源列表（scanner，v1.1.4）：强制重拉目录树，作废全部直链 ---------- */
  const refreshList = async (): Promise<void> => {
    if (refreshingList) return;
    setRefreshingList(true);
    setFetchProgress({ done: 0, total: 1 });
    addGlobalLog('=====获取资源列表（scanner）=====');
    addGlobalLog(`scanner：手动刷新 — ${adapter.name} · ${linkAbbr(url, adapter.id)}${session.jump ? `（jumper ${session.jump.rootPath}）` : ''}`);
    try {
      // v1.1.6 jumper：按目标文件夹重新扫描（不是分享根）；stoken 复用当前会话的（避免额外 token 接口）
      const snap = await fetchListSnapshot(adapter, shareId, url, {
        onProgress: (done, total) => setFetchProgress({ done, total }),
        stoken: session.jump ? stoken : undefined,
        rootFile: session.jump?.rootFile,
        rootPath: session.jump?.rootPath,
        rootIsShareRoot: session.jump ? false : undefined,
      });
      setRoot(snap.root);
      setStoken(snap.stoken);
      setListAt(snap.fetchedAt);
      setLinks(null); // 映射可能变化（增删文件/令牌失效），全部作废重新解析
      // v1.1.5.3：足迹里的直链结果同步作废（fid 映射可能已变化）
      await clearPraseByShareId(shareId).catch(() => undefined);
      // v1.1.6 jumper 不覆盖 trees 快照（子树根不是分享根，复用会污染整棵目录树）
      if (prefs.footprint.keepTrees && !session.jump) {
        await saveTree({
          shareId,
          url,
          adapterId: adapter.id,
          root: snap.root,
          savedAt: snap.fetchedAt,
          fileCount: snap.fileCount,
          totalSize: snap.totalSize,
          stoken: snap.stoken,
        });
      }
      await addRecord({
        shareId,
        url,
        adapterId: adapter.id,
        parsedAt: snap.fetchedAt,
        ok: true,
        fileCount: snap.fileCount,
        title: snap.root.children?.[0]?.file.fileName,
        kind: 'scanner', // v1.1.7：历史页按记录类型显示「获取列表成功」
      });
      if (prefs.footprint.keepLogs) {
        await appendLog({
          time: snap.fetchedAt,
          level: 'info',
          adapterId: adapter.id,
          url,
          message: `手动刷新资源列表：${linkAbbr(url, adapter.id)}，共 ${snap.fileCount} 个文件`,
        });
      }
      // 目录树打印到全局日志（过长自动折叠）+ 刷新标记（v1.1.4 规范日志）
      addGlobalLog(`=====目录树（${snap.fileCount} 个文件 / ${snap.totalSize} 字节）=====\n${renderTreeText(snap.root)}\n=====目录树结束=====`);
      addGlobalLog(`=====资源列表已刷新，当前${hhmmss(snap.fetchedAt)}=====`);
      toast('资源列表已刷新，直链已作废请重新解析', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addGlobalLog(`scanner：刷新失败 — ${message}`);
      toast(`刷新失败：${message}（分享可能已失效）`, 'error');
    } finally {
      setRefreshingList(false);
      setFetchProgress(null);
    }
  };

  /* ---------- 单文件解析（§12：原来“复制直链”的位置改成解析按钮） ---------- */
  /** 代理是否 pages.dev 结尾（v1.1.5.2 兜底防暴力刷 proxy 的启用条件） */
  const isPagesDevProxy = (): boolean =>
    prefs.transport.mode === 'proxy' && prefs.transport.proxyUrl.trim().toLowerCase().endsWith('pages.dev');

  const parseSingleFile = (fid: string): void => {
    const node = leafNodeOf(fid);
    if (!node || node.file.dir) {
      toast('仅支持解析文件', 'error');
      return;
    }
    const existing = links?.get(fid);
    if (existing?.ok && !fetching) {
      // 已解析成功：窗口内未过期 → 直接提示可导出（避免重复请求）；过期 → 重新解析
      if (isReusable(fid)) {
        toast('该文件已解析，勾选后可导出下载命令', 'info');
        return;
      }
      addGlobalLog(`prase：${node.file.fileName} 缓存直链已过期（窗口 ${prefs.reuseWindowHours}h），重新请求接口`);
    }
    // v1.1.5.2 兜底：手动终止后重试单文件 + pages.dev 代理 —— 与上次终止同分同秒 = 高频循环，强制提示
    // v1.1.5.3：同分秒判定太苛刻（真实点击必然跨秒导致 modal 不出现），改为「终止后 5s 内重试」窗口
    if (existing?.terminatedAt && isPagesDevProxy() && Date.now() - existing.terminatedAt < 5000) {
      addGlobalLog('prase：检测到手动终止后短时间内重复解析（疑似高频请求），已拦截并弹出提示');
      setCloudflareWarn(true);
      return;
    }
    requestFetchLinks([node.file]);
  };

  /* ---------- v1.1.6 jumper：0B 文件夹「转到此文件夹」→ 二次获取（新建相关联的链接任务） ---------- */
  /** 收集从分享根到目标文件夹的 fid 链（分享根不入链） */
  const collectFolderChain = (target: TreeNode): Array<{ fid: string; name: string }> => {
    const chain: Array<{ fid: string; name: string }> = [];
    const walk = (n: TreeNode): boolean => {
      if (n.file.fid === target.file.fid) {
        chain.push({ fid: n.file.fid, name: n.file.fileName });
        return true;
      }
      if (!n.children) return false;
      for (const c of n.children) {
        if (walk(c)) {
          chain.push({ fid: n.file.fid, name: n.file.fileName });
          return true;
        }
      }
      return false;
    };
    walk(root);
    chain.reverse(); // 根 → 目标
    if (chain[0]?.fid === root.file.fid) chain.shift(); // 分享根不入链
    return chain;
  };

  const jumpToFolder = (node: TreeNode): void => {
    if (!adapter.buildJumpUrl) {
      toast('该网盘暂不支持文件夹跳转', 'error');
      return;
    }
    const chain = collectFolderChain(node);
    const jumpUrl = adapter.buildJumpUrl(shareId, chain);
    if (!jumpUrl) {
      toast('生成跳转链接失败，请刷新资源列表后重试', 'error');
      return;
    }
    const folderPath = node.path; // 文件夹绝对路径（日志/提示展示）
    const originalTitle = root.children?.[0]?.file.fileName ?? linkAbbr(url, adapter.id); // 原任务 banner 标题
    addGlobalLog(`=====${hhmmss(Date.now())}，跳转到'${folderPath}'=====`);
    addGlobalLog(`${hhmmss(Date.now())} jumper：扫描暂存区，寻找唯一标识符`);
    if (prefs.modals.jumpTip) {
      setJumpWarn({ jumpUrl, folderPath, originalTitle });
    } else {
      doJump(jumpUrl, folderPath, originalTitle);
    }
  };

  /** 真正跳转：历史记录 link 日志最早写入 from/in，然后回输入页自动解析新任务 */
  const doJump = (jumpUrl: string, folderPath: string, originalTitle: string): void => {
    if (prefs.footprint.keepLogs) {
      void appendLog({
        time: Date.now(),
        level: 'info',
        adapterId: adapter.id,
        url: jumpUrl,
        message: `${hhmmss(Date.now())} from '${folderPath}' in '${originalTitle}'`,
      });
    }
    onJump(jumpUrl);
  };

  /* ---------- 隐秘参数（v1.1.7）：<> 按钮 → （可选弹窗）→ 新标签直连官方 API ---------- */
  const openHiddenVolumn = (node: TreeNode): void => {
    if (!adapter.hiddenVolumn || !adapter.buildHiddenVolumnUrl) {
      toast('该网盘暂不支持隐秘参数', 'error');
      return;
    }
    const url = adapter.buildHiddenVolumnUrl({ shareId, stoken, pdirFid: node.file.fid });
    if (!url) {
      toast('构造查询 URL 失败（缺少缓存信息？请刷新资源列表后再试）', 'error');
      return;
    }
    addGlobalLog(`${hhmmss(Date.now())} 隐秘参数：${node.path}（新标签直连官方 API，no-referer，不经过代理）`);
    // v1.1.7 hiddenVolumnHint：开=先弹窗说明字段含义（网盘静态话术）再跳转；关=直接新标签跳转
    if (prefs.advanced.hiddenVolumnHint) {
      setHiddenVolumn({ url, title: adapter.hiddenVolumn.title, body: adapter.hiddenVolumn.body });
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  /* ---------- 导出（浏览器直连/复制直链已移除：UC referer 白名单拒绝第三方源，§10.1.4） ---------- */
  const buildExportFiles = (): ExportFile[] => {
    // v1.1.5：curl 也支持保留目录结构（--create-dirs）；仅导出可用的直链（绿+黄，窗口内未过期）
    const keep = keepStructure;
    return selectedFiles
      .filter((f) => isLinkUsable(links?.get(f.fid), prefs.reuseWindowHours, f.size))
      .map((f) => {
        const node = leafNodeOf(f.fid);
        const path = node?.path ?? f.fileName;
        const entry = links!.get(f.fid)!;
        return {
          path: keep ? path : path.split('/').pop() ?? f.fileName,
          url: entry.url,
          size: f.size,
          cookie: entry.cookie, // §12：每文件与其直链同响应的 __pugs，merger 按文件注入
          fid: f.fid, // v1.1.5.2：导出后按 fid 查状态做黄色提醒
        };
      });
  };

  const handleExport = (kind: TaskKind): void => {
    if (fetching) {
      toast('正在解析中，请稍候', 'error');
      return;
    }
    // v1.1.5：curl 已支持保留目录结构（--create-dirs），跨文件夹不再拦截；BatchWarnModal 移除
    doExport(kind);
  };

  const EXPORT_FAIL_MSG = '未选中任何文件或者选中部分含有未解析、已解析但过期的文件';

  const doExport = (kind: TaskKind): void => {
    const files = buildExportFiles();
    if (files.length === 0) {
      // v1.1.4 规范：打开按钮发 modal（醒目），关闭发 toast
      if (prefs.modals.exportFailWarn) {
        addGlobalLog(`task：导出失败 — ${EXPORT_FAIL_MSG}`);
        setExportFail(true);
      } else {
        toast(EXPORT_FAIL_MSG, 'error');
      }
      return;
    }
    addGlobalLog(`=====导出任务（task）=====\ntask：类型 ${kind} · ${files.length} 个文件${keepStructure ? '（保留目录结构）' : ''}`);
    addGlobalLog('task：扫描已解析文件，按文件注入同响应下载凭据（__pugs）');
    const { fileName, content } = exportTask(kind, files, {
      keepStructure,
      outDir: downloader.savePath || undefined,
    });
    downloadFile(fileName, content);
    addGlobalLog(`task：合并完成，已生成 ${fileName}（下载命令已就绪）`);
    toast(`已导出 ${fileName}`, 'success');
    // v1.1.5.2：导出的直链里有黄色（有效但剩余时间不够完整下载）→ 提醒用户
    // v1.1.7：设置 → 弹窗开关 exportYellowWarn：开=弹窗，关=简略 toast（话术不变）
    const exportedWithFid = files.filter((f) => f.fid !== undefined);
    const yellowFiles = exportedWithFid.filter((f) => isLinkYellow(links?.get(f.fid as string), prefs.reuseWindowHours, f.size));
    if (yellowFiles.length > 0) {
      addGlobalLog(`task：${yellowFiles.length}/${exportedWithFid.length} 个直链剩余有效期不足以支撑完整下载（黄色状态），已提示用户`);
      if (prefs.modals.exportYellowWarn) {
        setExportYellow(true);
      } else {
        setTimeout(() => {
          toast('部分直链可能无法支持到下载完成了。。建议尽快开始下载或重新解析（一键续杯）', 'warning');
        }, 3200);
      }
    }
  };

  const exportTreeMdFile = (): void => {
    const content = exportTreeMd(root, { format: prefs.treeFormat, detail: prefs.treeDetail });
    downloadFile(`tree-${linkAbbr(url, adapter.id)}.md`, content);
  };

  const exportLogsFile = async (): Promise<void> => {
    const logs = await listLogs(200);
    const abbr = linkAbbr(url, adapter.id);
    const status = logs.length === 0 ? 'u' : links && [...links.values()].every((l) => l.ok) ? 's' : 'm';
    const { fileName, content } = exportLogsMd(abbr, status, logs);
    downloadFile(fileName, content);
    toast(`已导出 ${fileName}`, 'success');
  };

  /* ---------- 渲染 ---------- */
  // v1.1.5.2：仅统计可用直链（绿+黄）；选中含绿色文件时批量解析按钮置灰（防重复刷 prase）
  const linkedOkCount = links ? selectedFiles.filter((f) => isLinkUsable(links.get(f.fid), prefs.reuseWindowHours, f.size)).length : 0;
  const hasGreenSelected = selectedFiles.some((f) => isLinkGreen(links?.get(f.fid), prefs.reuseWindowHours, f.size));

  return (
    <>
      {/* 工具条：返回 + 链接信息 + 资源列表获取时间（v1.1.5：直链倒计时下沉到文件行标签） */}
      <div className="card">
        <div className="card-head">
          <div className="card-title-row">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
              ← 返回
            </button>
            <h2 className="card-title" style={{ fontSize: 15 }}>
              {adapter.name} · {shareId}
            </h2>
            <span className="field-hint">
              {/* v1.1.7：刷新后显示「首次获取于 xx · 最后刷新于 xx」 */}
              {listAt > firstAt
                ? `资源列表首次获取于 ${formatTime(firstAt)} · 最后刷新于 ${formatTime(listAt)}`
                : `资源列表获取于 ${formatTime(listAt)}`}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-emerald-soft btn-sm"
              onClick={() => void refreshList()}
              disabled={refreshingList || fetching}
              title="重新拉取目录树（作废全部已解析直链）"
            >
              {refreshingList ? `刷新中 ${fetchProgress?.done ?? 0}/${fetchProgress?.total ?? 0}` : '获取最新资源列表'}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={exportTreeMdFile} title="导出目录树 md">
              导出目录树
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void exportLogsFile()} title="导出解析日志">
              导出日志
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDownloaderOpen(true)}>
              连接本地下载器
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => requestFetchLinks(selectedFiles)}
              disabled={fetching || refreshingList || hasGreenSelected}
              title={hasGreenSelected ? '选中部分文件直链仍有效（绿色），无需重复解析；如需解析其他文件请取消勾选绿色文件' : undefined}
            >
              {fetching ? `解析中 ${fetchProgress?.done ?? 0}/${fetchProgress?.total ?? 0}` : '批量获取下载链接'}
            </button>
          </div>
        </div>
        <div className="card-body" style={{ paddingTop: 12 }}>
          <FileCheckbox
            selectedCount={selectedFiles.length}
            totalFiles={allLeaves.length}
            onSelectAll={() => selectVisible('all')}
            onSelectInvert={() => selectVisible('invert')}
            onSelectNone={() => selectVisible('none')}
            onSelectByStatus={selectByStatus}
            filterText={filterText}
            onFilterChange={setFilterText}
          />
        </div>
      </div>

      {/* 资源列表 */}
      <div className="card">
        <div className="card-head">
          <div className="card-title-row">
            <h2 className="card-title">资源列表</h2>
            <span className="field-hint" style={{ fontSize: 12 }}>
              已选 {selectedFiles.length} 个文件 · {formatSize(selectedSize)}
              {crossFolder && ' · 跨文件夹'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {linkedOkCount > 0 && selectedFiles.length > linkedOkCount && (
              <button type="button" className="btn btn-emerald-soft btn-sm" onClick={retryFailed}>
                重试失败项（{selectedFiles.length - linkedOkCount}）
              </button>
            )}
            <span className="field-hint">导出：</span>
            <div className="segment">
              {(Object.keys(KIND_LABEL) as TaskKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={exportKind === k ? 'active' : ''}
                  onClick={() => setExportKind(k)}
                  disabled={fetching}
                >
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => handleExport(exportKind)}
              disabled={fetching}
            >
              导出 {KIND_LABEL[exportKind]} 任务
            </button>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12.5, color: 'var(--text-dim)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={keepStructure}
                onChange={(e) => setKeepStructure(e.target.checked)}
              />
              保留目录结构
            </label>
          </div>
        </div>
        <div className="card-body" style={{ paddingTop: 0 }}>
          <DirectoryTree
            rows={flatRows}
            expanded={expanded}
            checked={checked}
            links={links ?? new Map()}
            reuseWindowHours={prefs.reuseWindowHours}
            onToggleDir={(fid) =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(fid)) next.delete(fid);
                else next.add(fid);
                return next;
              })
            }
            onToggleFile={toggleFile}
            onToggleDirAll={toggleDirAll}
            onParseFile={parseSingleFile}
            busy={fetching}
            onJumpToFolder={jumpToFolder}
            showDirProps={prefs.showDirProps}
            dirProps={dirProps}
            onHiddenVolumn={openHiddenVolumn}
            showHiddenVolumn={prefs.advanced.enabled && prefs.advanced.showHiddenVolumn}
            showEtag={prefs.showEtag}
            showLinkDetail={prefs.showLinkDetail}
          />
        </div>
      </div>

      {exportFail && (
        <ExportFailModal
          onClose={() => {
            setExportFail(false);
            // 关闭发 toast（v1.1.4 规范：打开按钮发 modal，关闭发 toast）
            toast(EXPORT_FAIL_MSG, 'error');
          }}
        />
      )}
      {parseFail && (
        <ParseFailModal
          fileName={parseFail.fileName}
          onClose={() => {
            setParseFail(null);
            toast('解析失败，该文件可能已经与供应商断开连接或者在分享中被删除，请刷新资源列表后再试', 'error');
          }}
          onRefresh={() => {
            setParseFail(null);
            void refreshList();
          }}
        />
      )}
      {cloudflareWarn && <CloudflareWarnModal onClose={() => setCloudflareWarn(false)} />}
      {jumpWarn && (
        <JumptoFolderTipModal
          folderPath={jumpWarn.folderPath}
          onConfirm={() => {
            const j = jumpWarn;
            setJumpWarn(null);
            doJump(j.jumpUrl, j.folderPath, j.originalTitle);
          }}
          onCancel={() => setJumpWarn(null)}
        />
      )}
      {downloaderOpen && <DownloaderModal onClose={() => setDownloaderOpen(false)} />}
      {cookieWarn && adapter.cookie && (
        <CookieWarnModal
          panName={adapter.name}
          cookie={adapter.cookie}
          capturedValue={getPugs() ?? ''}
          onCancel={() => {
            // v1.1.5：算了吧 = 主动终止本次解析（不再是跳过继续）
            // v1.1.5.3：批量同样标红 —— 整批请求用的是同一个 cookie，终止即整批失败（status:red 手动终止）
            const files = pendingFetch.current ?? [];
            setCookieWarn(null);
            const terminated = new Map<string, LinkEntry>();
            const now = Date.now();
            for (const f of files) {
              // 已解析且仍可用的文件不受影响（复用直链不因终止作废）
              if (isReusable(f.fid)) continue;
              terminated.set(f.fid, { ok: false, url: '', error: '手动终止', fetchedAt: now, terminatedAt: now });
            }
            if (terminated.size > 0) {
              setLinks((prev) => {
                const next = new Map(prev ?? []);
                for (const [fid, entry] of terminated) next.set(fid, entry);
                return next;
              });
              // 终止标记也落库（红色状态跨刷新保留）
              if (prefs.footprint.keepLogs) {
                void savePraseEntries(shareId, terminated).catch(() => undefined);
              }
            }
            addGlobalLog(
              files.length === 1
                ? `prase：用户主动终止解析 — ${files[0].fileName}（cookie 弹窗选“算了吧”，已标红）`
                : `prase：用户主动终止解析 — ${files.length} 个文件的批量任务（cookie 弹窗选“算了吧”，已全部标红）`,
            );
            toast('用户主动终止解析', 'info');
          }}
          onConfirm={() => {
            setCookieWarn(null);
            addGlobalLog('prase：用户已确认，继续解析');
            void doFetchLinks(pendingFetch.current ?? []);
          }}
        />
      )}
      {/* v1.1.7 隐秘参数弹窗（确认后新标签直连官方 API，no-referer） */}
      {hiddenVolumn && (
        <HiddenVolumnModal
          title={hiddenVolumn.title}
          body={hiddenVolumn.body}
          onOpen={() => {
            window.open(hiddenVolumn.url, '_blank', 'noopener,noreferrer');
            setHiddenVolumn(null);
          }}
          onClose={() => setHiddenVolumn(null)}
        />
      )}
      {/* v1.1.7 导出包含黄色标记 → 弹窗（设置开关 exportYellowWarn，关=简略 toast） */}
      {exportYellow && <ExportYellowModal onClose={() => setExportYellow(false)} />}
      {/* v1.1.7 复用会话恢复折叠状态询问弹窗 */}
      {restoreAsk && (
        <RestoreCollapsedModal
          savedAtLabel={restoreAsk.savedAtLabel}
          onRestore={() => {
            // 好的：显式恢复已保存的折叠状态（初始展开态已应用，这里再应用一次兜底）
            const saved = readCollapsed();
            if (saved) setExpanded(new Set(saved.fids.length > 0 ? saved.fids : allDirIds));
            setRestoreAsk(null);
          }}
          onDiscard={() => {
            // 不用了：丢弃上次状态，回到默认全展开
            setExpanded(new Set(allDirIds));
            setRestoreAsk(null);
          }}
        />
      )}
    </>
  );
}
