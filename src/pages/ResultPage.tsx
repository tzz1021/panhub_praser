/**
 * 结果页（docs/STRUCTURE.md：src/pages/ResultPage.tsx）—— 核心页
 *
 * 目录树 + 勾选 → 批量直链（15/批 + 1s 节流）→ 导出（aria2/gopeed/curl / 浏览器直下）
 * 附带：直链有效期倒计时（OSS Expires 参数）、失败重试、足迹记录/日志、md 导出。
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
import { RepeatClickHint } from '../components/RepeatClickHint';
import { useToast } from '../components/Toast';
import { fetchLinks } from '../core/linkFetcher';
import { getPreferences } from '../core/preferences';
import { addRecord } from '../core/footprint/records';
import { appendLog, listLogs, exportLogsMd } from '../core/footprint/logs';
import { addGlobalLog } from '../core/footprint/globalLog';
import { getPugs } from '../adapters/ucPugs';
import { exportTask, exportTreeMd } from '../tasks/export';
import { loadDownloaderConfig } from '../utils/downloader';
import { formatRemain, formatSize, formatTime } from '../utils/format';
import type { ExportFile, ParseSession, TaskKind, TreeNode } from '../core/types';
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
  const { adapter, shareId, stoken, url, root, parsedAt } = session;
  const { toast } = useToast();

  const prefs = useMemo(() => getPreferences(), []);
  const downloader = useMemo(() => loadDownloaderConfig(), []);

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
  const [repeatHint, setRepeatHint] = useState(false);
  const [downloaderOpen, setDownloaderOpen] = useState(false);
  // §12 顺序固化：解析（获取下载链接）阶段才需要 cookie —— 弹窗确认后预热 + 继续
  const [cookieWarn, setCookieWarn] = useState<{ files: ShareFile[] } | null>(null);
  const pendingFetch = useRef<ShareFile[] | null>(null);
  const [, setTick] = useState(0); // 倒计时刷新
  const batchClickAt = useRef<number[]>([]);

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

  /* ---------- 批量直链 ---------- */
  /**
   * 解析入口（§12 顺序固化：ls 不需要 cookie，解析才需要）：
   * 需 cookie 的网盘（UC）→ 先弹窗展示捕获状态（明文，默认开），确认后拉直链。
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
    if (adapter.cookie && getPreferences().modals.cookieWarn) {
      addGlobalLog('=====开始收集必要信息=====');
      addGlobalLog(`获取cookie：弹窗已出现，等待用户选择（当前捕获 ${getPugs() ? '有值' : '为空'}，解析后代理捕获自动更新）`);
      setCookieWarn({ files });
      return;
    }
    void doFetchLinks(files);
  };

  /** 真正执行批量直链获取（每个下载响应下发的 __pugs 与该响应的直链绑定，§12） */
  const doFetchLinks = async (files: ShareFile[]): Promise<void> => {
    // 反复点击提示（同 10s 内第 3 次点击）
    const now = Date.now();
    batchClickAt.current = batchClickAt.current.filter((t) => now - t < 10_000);
    batchClickAt.current.push(now);
    if (batchClickAt.current.length >= 3 && fetching) {
      setRepeatHint(true);
      return;
    }
    setFetching(true);
    setFetchProgress({ done: 0, total: files.length });
    try {
      const results = await fetchLinks(
        { adapter, shareId, stoken },
        files,
        { batchSize: 15, batchIntervalMs: 1000, continueOnError: true },
      );
      const map = new Map<string, LinkEntry>();
      let okCount = 0;
      results.forEach((r, i) => {
        if (r.ok) okCount++;
        map.set(files[i].fid, {
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
        addGlobalLog(`merger：下载凭据已按文件绑定（${withCookie}/${map.size} 个链接携带同响应 __pugs）`);
        if (withCookie === 0) {
          addGlobalLog('merger：未捕获到 __pugs —— 请检查代理通道（x-pugs 头）是否可用，否则导出命令将缺下载凭据');
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
          message: `批量解析：${abbr}，${okCount}/${files.length} 成功`,
        });
      }
      toast(
        okCount === files.length
          ? `解析完成：${okCount} 个文件全部成功`
          : `部分失败：${okCount}/${files.length} 成功，可重试失败项`,
        okCount === files.length ? 'success' : 'error',
      );
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

  /* ---------- 单文件解析（§12：原来“复制直链”的位置改成解析按钮） ---------- */
  const parseSingleFile = (fid: string): void => {
    const node = leafNodeOf(fid);
    if (!node || node.file.dir) {
      toast('仅支持解析文件', 'error');
      return;
    }
    const existing = links?.get(fid);
    if (existing?.ok && !fetching) {
      // 已解析成功：直接提示可导出（避免重复请求）
      toast('该文件已解析，勾选后可导出下载命令', 'info');
      return;
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

  const doExport = (kind: TaskKind): void => {
    const files = buildExportFiles(kind);
    if (files.length === 0) {
      toast('请先勾选文件并批量解析', 'error');
      return;
    }
    addGlobalLog(`=====检测到task=====\ntask类型：${kind}（${files.length} 个文件）`);
    addGlobalLog('merger：扫描暂存区，搜索 dl-link 与必要 cookie');
    const { fileName, content } = exportTask(kind, files, {
      keepStructure: kind === 'curl' ? false : keepStructure,
      outDir: downloader.savePath || undefined,
    });
    downloadFile(fileName, content);
    addGlobalLog(`merger：合并完成，已导出 ${fileName}（下载命令已就绪）`);
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
            <span className="field-hint">解析于 {formatTime(parsedAt)}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
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
              disabled={fetching}
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
      {repeatHint && <RepeatClickHint onClose={() => setRepeatHint(false)} />}
      {downloaderOpen && <DownloaderModal onClose={() => setDownloaderOpen(false)} />}
      {cookieWarn && adapter.cookie && (
        <CookieWarnModal
          panName={adapter.name}
          cookie={adapter.cookie}
          capturedValue={getPugs() ?? ''}
          onCancel={() => {
            setCookieWarn(null);
            addGlobalLog('获取cookie：用户选择“算了吧”（跳过展示，继续解析）');
            void doFetchLinks(pendingFetch.current ?? []);
          }}
          onConfirm={() => {
            setCookieWarn(null);
            addGlobalLog('获取cookie：用户已确认，继续解析');
            void doFetchLinks(pendingFetch.current ?? []);
          }}
        />
      )}
    </>
  );
}
