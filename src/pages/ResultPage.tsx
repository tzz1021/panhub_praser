/**
 * 结果页（docs/STRUCTURE.md：src/pages/ResultPage.tsx）—— 核心页
 *
 * 目录树 + 勾选 → prase 批量直链（15/批 + 1s 节流，窗口内复用已解析直链）→ 导出。
 * 附带：直链有效期倒计时（OSS Expires 参数）、失败重试、足迹记录/日志、md 导出。
 * v1.1.4：术语分离 —— ls（资源列表获取）与 prase（解析下载方式）分开；
 * 头部「资源列表获取于 xx」+ 绿按钮「获取最新资源列表」强制刷新 ls。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { ShareFile } from '../adapters/types';
import { DirectoryTree, collectLeaves, flattenTree } from '../components/DirectoryTree';
import type { TreeRow } from '../components/DirectoryTree';
import { FileCheckbox } from '../components/FileCheckbox';
import { BatchWarnModal } from '../components/BatchWarnModal';
import { CookieWarnModal } from '../components/CookieWarnModal';
import { DownloaderModal } from '../components/DownloaderModal';
import { ExportFailModal } from '../components/ExportFailModal';
import { ParseFailModal } from '../components/ParseFailModal';
import { useToast } from '../components/Toast';
import { fetchLinks } from '../core/linkFetcher';
import { fetchListSnapshot, renderTreeText, hhmmss } from '../core/listFetcher';
import { getPreferences } from '../core/preferences';
import { addRecord } from '../core/footprint/records';
import { appendLog, listLogs, exportLogsMd } from '../core/footprint/logs';
import { addGlobalLog } from '../core/footprint/globalLog';
import { saveTree } from '../core/footprint/trees';
import { getPugs } from '../adapters/ucPugs';
import { exportTask, exportTreeMd } from '../tasks/export';
import { loadDownloaderConfig } from '../utils/downloader';
import { formatRemain, formatSize, formatTime } from '../utils/format';
import type { ExportFile, LinkResult, ParseSession, TaskKind, TreeNode } from '../core/types';
import { linkAbbr } from './HomePage';

/** 直链结果（含获取时间，用于倒计时） */
interface LinkEntry {
  ok: boolean;
  url: string;
  error?: string;
  fetchedAt: number;
  /** 与该直链同响应绑定的下载凭据（§12；UC = __pugs），导出按文件注入 */
  cookie?: { key: string; value: string };
}

/** 从 OSS 签名 URL 解析 Expires（秒时间戳） */
function getExpiry(url: string): number | null {
  const m = url.match(/[?&]Expires=(\d+)/);
  return m ? Number(m[1]) * 1000 : null;
}

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
}

const KIND_LABEL: Record<TaskKind, string> = { aria2: 'aria2', gopeed: 'Gopeed', curl: 'cURL' };

export function ResultPage({ session, onBack }: ResultPageProps): JSX.Element {
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

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(allDirIds)); // 默认全展开
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [filterText, setFilterText] = useState('');
  const [links, setLinks] = useState<Map<string, LinkEntry> | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchProgress, setFetchProgress] = useState<{ done: number; total: number } | null>(null);
  const [exportKind, setExportKind] = useState<TaskKind>('aria2');
  const [keepStructure, setKeepStructure] = useState(prefs.keepStructure);
  const [batchWarn, setBatchWarn] = useState<TaskKind | null>(null);
  const [exportFail, setExportFail] = useState(false);
  const [parseFail, setParseFail] = useState<{ fileName: string } | null>(null);
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
   * 是否可复用缓存直链（v1.1.4）：已有成功直链 + 在 reuseWindowHours 窗口内 + oss 未过期。
   * 过期判定：URL 带 Expires 时要求剩余时间 > 60s；无 Expires 参数只按窗口判定。
   */
  const isReusable = (fid: string): boolean => {
    if (prefs.reuseWindowHours <= 0) return false;
    const existing = links?.get(fid);
    if (!existing?.ok || !existing.url) return false;
    const age = Date.now() - existing.fetchedAt;
    if (age >= prefs.reuseWindowHours * 3600_000) return false;
    const exp = getExpiry(existing.url);
    return exp === null || exp > Date.now() + 60_000;
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
      // 捕获状态反馈（弹窗已展示过，这里给个结果）：
      if (adapter.cookie) {
        const withCookie = [...map.values()].filter((l) => l.ok && l.cookie).length;
        addGlobalLog(`prase：下载凭据已按文件绑定（${withCookie}/${map.size} 个链接携带同响应 ${adapter.cookie.key}）`);
        if (withCookie === 0) {
          addGlobalLog(`prase：未捕获到 ${adapter.cookie.key} —— 请检查代理通道（x-pugs 头）是否可用，否则导出命令将缺下载凭据`);
        }
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
    const failed = selectedFiles.filter((f) => {
      const l = links?.get(f.fid);
      return !l || !l.ok;
    });
    requestFetchLinks(failed);
  };

  /* ---------- 刷新资源列表（ls，v1.1.4）：强制重拉目录树，作废全部直链 ---------- */
  const refreshList = async (): Promise<void> => {
    if (refreshingList) return;
    setRefreshingList(true);
    setFetchProgress({ done: 0, total: 1 });
    addGlobalLog('=====获取资源列表（ls）=====');
    addGlobalLog(`ls：手动刷新 — ${adapter.name} · ${linkAbbr(url, adapter.id)}`);
    try {
      const snap = await fetchListSnapshot(adapter, shareId, url, {
        onProgress: (done, total) => setFetchProgress({ done, total }),
      });
      setRoot(snap.root);
      setStoken(snap.stoken);
      setListAt(snap.fetchedAt);
      setLinks(null); // 映射可能变化（增删文件/令牌失效），全部作废重新解析
      if (prefs.footprint.keepTrees) {
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
      addGlobalLog(`ls：刷新失败 — ${message}`);
      toast(`刷新失败：${message}（分享可能已失效）`, 'error');
    } finally {
      setRefreshingList(false);
      setFetchProgress(null);
    }
  };

  /* ---------- 单文件解析（§12：原来“复制直链”的位置改成解析按钮） ---------- */
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
    requestFetchLinks([node.file]);
  };

  /* ---------- 导出（浏览器直连/复制直链已移除：UC referer 白名单拒绝第三方源，§10.1.4） ---------- */
  const buildExportFiles = (kind: TaskKind): ExportFile[] => {
    const keep = kind === 'curl' ? false : keepStructure;
    return selectedFiles
      .filter((f) => links?.get(f.fid)?.ok)
      .map((f) => {
        const node = leafNodeOf(f.fid);
        const path = node?.path ?? f.fileName;
        const entry = links!.get(f.fid)!;
        return {
          path: keep ? path : path.split('/').pop() ?? f.fileName,
          url: entry.url,
          size: f.size,
          cookie: entry.cookie, // §12：每文件与其直链同响应的 __pugs，merger 按文件注入
        };
      });
  };

  const handleExport = (kind: TaskKind): void => {
    if (fetching) {
      toast('正在解析中，请稍候', 'error');
      return;
    }
    if (crossFolder && kind === 'curl') {
      setBatchWarn('curl');
      return;
    }
    doExport(kind);
  };

  const EXPORT_FAIL_MSG = '未选中任何文件或者选中部分含有未解析、已解析但过期的文件';

  const doExport = (kind: TaskKind): void => {
    const files = buildExportFiles(kind);
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
    addGlobalLog(`=====导出任务（task）=====\ntask：类型 ${kind} · ${files.length} 个文件${kind === 'curl' ? '' : keepStructure ? '（保留目录结构）' : ''}`);
    addGlobalLog('task：扫描已解析文件，按文件注入同响应下载凭据（__pugs）');
    const { fileName, content } = exportTask(kind, files, {
      keepStructure: kind === 'curl' ? false : keepStructure,
      outDir: downloader.savePath || undefined,
    });
    downloadFile(fileName, content);
    addGlobalLog(`task：合并完成，已生成 ${fileName}（下载命令已就绪）`);
    toast(`已导出 ${fileName}`, 'success');
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
  const linkedOkCount = links ? selectedFiles.filter((f) => links.get(f.fid)?.ok).length : 0;
  const firstLink = links ? [...links.values()].find((l) => l.ok && l.url) : undefined;
  const expiry = firstLink ? getExpiry(firstLink.url) : null;
  const remain = expiry ? expiry - Date.now() : null;

  return (
    <>
      {/* 工具条：返回 + 链接信息 + 直链有效期 */}
      <div className="card">
        <div className="card-head">
          <div className="card-title-row">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
              ← 返回
            </button>
            <h2 className="card-title" style={{ fontSize: 15 }}>
              {adapter.name} · {shareId}
            </h2>
            {links && (
              <span className="meta-tag" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}>
                直链已生成
                {remain !== null && ` · 剩余 ${formatRemain(remain)}`}
                {remain !== null && remain < 0 && '（已过期，请重新解析）'}
              </span>
            )}
            <span className="field-hint">资源列表获取于 {formatTime(listAt)}</span>
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
              disabled={fetching || refreshingList}
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
                disabled={exportKind === 'curl'}
              />
              保留目录结构{exportKind === 'curl' ? '（仅 aria2/gopeed）' : ''}
            </label>
          </div>
        </div>
        <div className="card-body" style={{ paddingTop: 0 }}>
          <DirectoryTree
            rows={flatRows}
            expanded={expanded}
            checked={checked}
            links={links ?? new Map()}
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
          />
        </div>
      </div>

      {batchWarn && (
        <BatchWarnModal
          kindLabel={KIND_LABEL[batchWarn]}
          onCancel={() => setBatchWarn(null)}
          onConfirm={() => {
            setBatchWarn(null);
            setExportKind('aria2');
            setKeepStructure(true);
            doExport('aria2');
          }}
        />
      )}
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
      {downloaderOpen && <DownloaderModal onClose={() => setDownloaderOpen(false)} />}
      {cookieWarn && adapter.cookie && (
        <CookieWarnModal
          panName={adapter.name}
          cookie={adapter.cookie}
          capturedValue={getPugs() ?? ''}
          onCancel={() => {
            setCookieWarn(null);
            addGlobalLog('prase：用户选择“算了吧”（跳过 cookie 展示，继续解析）');
            void doFetchLinks(pendingFetch.current ?? []);
          }}
          onConfirm={() => {
            setCookieWarn(null);
            addGlobalLog('prase：用户已确认，继续解析');
            void doFetchLinks(pendingFetch.current ?? []);
          }}
        />
      )}
    </>
  );
}
