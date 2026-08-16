/**
 * 输入页（docs/STRUCTURE.md：src/pages/HomePage.tsx）
 *
 * 流程：粘贴链接 → detect 高亮网盘 → 点"获取文件列表"→ token 二次校验
 * → buildTree 目录树 → 足迹落库（链接/树快照/解析记录/日志）→ 进入结果页。
 */
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { PanAdapter } from '../adapters/types';
import { detectShareUrl } from '../adapters/registry';
import { LinkInput, extractShare } from '../components/LinkInput';
import { PanTable } from '../components/PanTable';
import { DownloaderModal } from '../components/DownloaderModal';
import { LoginJumpModal } from '../components/LoginJumpModal';
import { CorsJumpModal } from '../components/CorsJumpModal';
import { useToast } from '../components/Toast';
import { buildTree } from '../core/treeWalker';
import { classifyError, isCorsError } from '../core/errors';
import { getPreferences } from '../core/preferences';
import { addGlobalLog } from '../core/footprint/globalLog';
import { addLink } from '../core/footprint/links';
import { saveTree } from '../core/footprint/trees';
import { addRecord } from '../core/footprint/records';
import { appendLog } from '../core/footprint/logs';
import type { ParseSession } from '../core/types';

/** 分享链接缩写（日志/足迹命名用，如 uc-dd2ad2345e124） */
export function linkAbbr(url: string, adapterId: string): string {
  const m = url.match(/\/(?:s|share)\/([A-Za-z0-9_-]+)/);
  return `${adapterId}-${m ? m[1] : url.slice(-8)}`;
}

export interface HomePageProps {
  onParsed: (session: ParseSession) => void;
  /** 打开设置面板（CORS 弹窗引导填代理，1.1） */
  onOpenSettings: () => void;
  /** 历史页"重新解析"带入的链接（1.0.1）：变化时自动填充，autoParse=true 时自动触发解析 */
  pending?: { url: string; autoParse?: boolean } | null;
}

export function HomePage({ onParsed, onOpenSettings, pending }: HomePageProps): JSX.Element {
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [detected, setDetected] = useState<PanAdapter | null>(null);
  const [passcode, setPasscode] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [downloaderOpen, setDownloaderOpen] = useState(false);
  const [loginJump, setLoginJump] = useState<{ message: string } | null>(null);
  const [corsJump, setCorsJump] = useState<{ message: string } | null>(null);
  const { toast } = useToast();
  const [initialValue, setInitialValue] = useState('');
  const lastPending = useRef('');

  /**
   * CORS 兑底跳转（备用形式，1.0.3）：打开分享页新标签供书签解析用，
   * 退出本站（pagehide）时执行清理函数自动关闭新标签（JS 只能关自己 open 的窗口）。
   * 不再定时关闭（1.0.2 的 30s 自动关会让解析进行中被打断）。
   */
  const openShareFallback = (shareUrl: string): void => {
    const win = window.open(shareUrl, '_blank');
    if (!win) {
      toast('浏览器拦截了弹窗，请手动打开分享页或开启书签', 'error');
      return;
    }
    const cleanup = (): void => {
      try {
        if (!win.closed) win.close(); // 只关我们打开的标签
      } catch {
        /* 跨域/已接管时忽略 */
      }
      window.removeEventListener('pagehide', cleanup);
    };
    window.addEventListener('pagehide', cleanup);
  };

  // 历史页"重新解析"：填充输入框，必要时自动触发解析
  useEffect(() => {
    if (!pending || pending.url === lastPending.current) return;
    lastPending.current = pending.url;
    setInitialValue(pending.url);
    if (pending.autoParse) {
      const adapter = detectShareUrl(pending.url);
      if (adapter) {
        const pc = extractShare(pending.url).passcode ?? '';
        setPasscode(pc);
        // 等 React 提交后触发（detect 已由 LinkInput 回调同步）
        setTimeout(() => void handleFetch({ adapter, url: pending.url, passcode: pc }), 200);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  const handleDetect = (adapter: PanAdapter | null, u: string): void => {
    setDetected(adapter);
    setUrl(u);
    setHighlightId(adapter ? adapter.id : null);
  };

  const handleFetch = async (overrides?: { adapter?: PanAdapter; url?: string; passcode?: string }): Promise<void> => {
    const adapter = overrides?.adapter ?? detected;
    const shareUrl = overrides?.url ?? url;
    const pc = overrides?.passcode ?? passcode;
    if (!adapter) {
      toast('识别失败，请检查格式是否正确', 'error');
      return;
    }
    const shareId = adapter.parseShareId(shareUrl);
    if (!shareId) {
      toast('识别失败，请检查格式是否正确', 'error');
      return;
    }
    // §12/顺序固化：获取资源列表 = 游客态浏览（ls 不需要 cookie），直接解析目录树；
    // cookie（UC __pugs）只在结果页“解析下载链接”阶段才需要（single-link 示例日志顺序）
    addGlobalLog('=====获取资源列表已点击=====');
    await runParse(adapter, shareUrl, pc);
  };

  /**
   * 实际解析流程（获取文件列表：游客态请求，不需要 cookie，§12）
   */
  const runParse = async (adapter: PanAdapter, shareUrl: string, pc: string): Promise<void> => {
    const shareId = adapter.parseShareId(shareUrl);
    if (!shareId) {
      toast('识别失败，请检查格式是否正确', 'error');
      return;
    }
    // 全局日志：任务开始 + 设置快照（开发调试用）
    const prefs = getPreferences();
    addGlobalLog(`收到任务：${linkAbbr(shareUrl, adapter.id)}。正在记录活动`);
    addGlobalLog('=====开始读取当前设置=====');
    addGlobalLog(`供应商：${adapter.name}`);
    addGlobalLog(`CORS策略：${prefs.transport.mode === 'proxy' ? 'proxy代理' : 'direct直连'}`);
    if (adapter.cookie) addGlobalLog(`其他需要的参数：${adapter.cookie.displayName}（未登录态cookie）`);
    addGlobalLog(`读取cookie提示：${prefs.modals.cookieWarn ? '开启' : '关闭'}`);
    setBusy(true);
    setProgress({ done: 0, total: 1 });
    const abbr = linkAbbr(shareUrl, adapter.id);
    try {
      // token 二次校验（分享有效性检测：无效分享/提取码错误会在此报错）
      const { stoken } = await adapter.getToken({ shareId, passcode: pc || undefined });
      // 目录树（递归 + 大小聚合，并发 3）
      const root = await buildTree(
        { adapter, shareId, stoken },
        {
          recursive: true,
          concurrency: 3,
          onProgress: (done, total) => setProgress({ done, total }),
        },
      );
      // 足迹落库（仅本地）
      const prefs = getPreferences();
      const now = Date.now();
      if (prefs.footprint.keepLinks) {
        await addLink({ url: shareUrl, adapterId: adapter.id, shareId });
      }
      if (prefs.footprint.keepTrees) {
        const fileCount = countFiles(root);
        await saveTree({
          shareId,
          url: shareUrl,
          adapterId: adapter.id,
          root,
          savedAt: now,
          fileCount,
          totalSize: root.size,
          stoken, // 回溯复用需要（历史“再次解析”窗口内免代理），见 adapters/types.ts reuseWindowHours
        });
      }
      await addRecord({
        shareId,
        url: shareUrl,
        adapterId: adapter.id,
        parsedAt: now,
        ok: true,
        fileCount: countFiles(root),
        title: root.children?.[0]?.file.fileName, // 首个文件（夹）名，历史页标题用（1.0.2）
      });
      if (prefs.footprint.keepLogs) {
        await appendLog({ time: now, level: 'info', adapterId: adapter.id, url: shareUrl, message: `解析成功：${abbr}，共 ${countFiles(root)} 个文件` });
      }
      onParsed({ adapter, url: shareUrl, shareId, stoken, root, parsedAt: now });
      addGlobalLog('响应成功：已获取文件列表；目录树已写入暂存区；HomePage已刷新：等待操作');
    } catch (err) {
      const { category, message } = classifyError(err);
      const now = Date.now();
      await addRecord({ shareId, url: shareUrl, adapterId: adapter.id, parsedAt: now, ok: false, fileCount: 0, error: message });
      const prefs = getPreferences();
      if (prefs.footprint.keepLogs) {
        await appendLog({ time: now, level: 'fatal', adapterId: adapter.id, url: shareUrl, message: `解析失败：${message}` });
      }
      if (isCorsError(err)) {
        // CORS 拦截：PC 端无书签时兑底（1.0.1）；自动跳转改为"备用"形式，默认弹窗（1.0.3）
        if (prefs.modals.corsAutoJump) {
          openShareFallback(shareUrl);
          toast('CORS 拦截：已跳转分享页，新标签页用于解析请勿关闭，退出本站自动清理', 'info');
        } else {
          setCorsJump({ message });
        }
      } else if (category === 'need-login' && prefs.modals.loginJump) {
        setLoginJump({ message });
      } else {
        toast(message, 'error');
      }
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <>
      {/* 分享链接填写栏（上） */}
      <LinkInput
        onDetect={handleDetect}
        onPasscode={setPasscode}
        onFetchFiles={() => void handleFetch()}
        onOpenDownloader={() => setDownloaderOpen(true)}
        busy={busy}
        initialValue={initialValue}
      />
      {/* 解析进度（可选展示） */}
      {busy && progress && (
        <div className="card">
          <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 13, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
              解析目录中 {progress.done}/{progress.total}
            </span>
            <div className="progress">
              <div
                className="progress-bar"
                style={{
                  width: progress.total > 0 ? `${Math.min(100, (progress.done / progress.total) * 100)}%` : '10%',
                }}
              />
            </div>
          </div>
        </div>
      )}
      {/* 网盘种类横向表格（下） */}
      <PanTable highlightId={highlightId} />

      {downloaderOpen && <DownloaderModal onClose={() => setDownloaderOpen(false)} />}
      {loginJump && (
        <LoginJumpModal
          message={loginJump.message}
          onClose={() => setLoginJump(null)}
          onJump={() => {
            setLoginJump(null);
            if (detected && url) window.open(url, '_blank');
          }}
        />
      )}
      {corsJump && (
        <CorsJumpModal
          message={corsJump.message}
          onClose={() => setCorsJump(null)}
          onOpenSettings={onOpenSettings}
        />
      )}
    </>
  );
}

/** 统计树中文件数（递归） */
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
