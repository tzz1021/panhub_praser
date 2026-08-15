/**
 * 历史页（1.0.1）—— 解析历史时间轴
 *
 * 数据源（全部仅本地 IndexedDB）：
 * - ParseRecord 按 parsedAt 倒序（HISTORY 事件按唯一时间戳存储，见 HANDOFF 附件 §3.3）
 * - TreeSnapshot 提供标题（取第一个文件/夹名，多文件加"等"，不显示裸 URL）
 * - LinkRecord 提供备注（可编辑）
 * - LogEntry 提供"下载日志"（同一链接可对应多条日志）
 *
 * 交互：十盘 chips 作筛选器（最右侧"全部"）；相邻多次解析同一链接折叠展示；
 * 每条操作：修改备注 / 重新解析 / 下载日志。折叠与备注编辑均为前端逻辑，不改存储结构。
 */
import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { PanTable, PAN_LIST } from '../components/PanTable';
import { useToast } from '../components/Toast';
import { listLinks, removeLink, updateLinkNote, clearLinks } from '../core/footprint/links';
import { listTrees, removeTree, clearTrees } from '../core/footprint/trees';
import { listAllRecords, removeRecordsByShareId, clearRecords } from '../core/footprint/records';
import { listLogs, removeLogsByUrl, clearLogs, exportLogsMd } from '../core/footprint/logs';
import type { LinkRecord, ParseRecord, TreeSnapshot } from '../core/types';
import { formatTime } from '../utils/format';
import { linkAbbr } from './HomePage';

/** 时间轴分组：同一链接的解析事件折叠为一条 */
interface TimelineGroup {
  url: string;
  adapterId: string;
  shareId: string;
  /** 解析事件（parsedAt 倒序，最新在前） */
  records: ParseRecord[];
  /** 标题（第一个文件/夹名 + 多文件"等"） */
  title: string;
  /** 备注（LinkRecord.note，可编辑） */
  note: string;
}

/** 标题解析链：记录内标题（1.0.2 起解析时写入，多文件加"等"）→ 树快照首文件（夹）名 → 原始链接兑底 */
function titleOf(rec: ParseRecord, snap: TreeSnapshot | undefined, url: string): string {
  if (rec.title) return rec.fileCount > 1 ? `${rec.title} 等` : rec.title;
  if (!snap) return url;
  const first = snap.root.children?.[0]?.file.fileName;
  if (!first) return url;
  return snap.fileCount > 1 ? `${first} 等` : first;
}

/** 折叠相邻同链接：按 parsedAt 倒序输入，同 url 连续出现合并（不增加存储复杂度） */
function foldRecords(records: ParseRecord[]): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  for (const r of records) {
    const last = groups[groups.length - 1];
    if (last && last.url === r.url) {
      last.records.push(r);
    } else {
      groups.push({ url: r.url, adapterId: r.adapterId, shareId: r.shareId, records: [r], title: '', note: '' });
    }
  }
  return groups;
}

/** 盘标识：有 logo 图显示图，否则短字（“全部”筛选时条目前置） */
function panLogo(adapterId: string): JSX.Element | string {
  const pan = PAN_LIST.find((p) => p.id === adapterId);
  if (!pan) return adapterId.toUpperCase();
  if (pan.logo) {
    return <img src={pan.logo} alt={pan.name} style={{ width: 14, height: 14, verticalAlign: 'middle' }} />;
  }
  return <span className="chip-short">{pan.short}</span>;
}

function downloadFile(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

export interface HistoryPageProps {
  /** 重新解析：回输入页并自动填充（autoParse=true 时自动触发） */
  onReparse: (url: string, autoParse?: boolean) => void;
}

export function HistoryPage({ onReparse }: HistoryPageProps): JSX.Element {
  const [groups, setGroups] = useState<TimelineGroup[]>([]);
  const [filter, setFilter] = useState<string | 'all'>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [loaded, setLoaded] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    void (async () => {
      try {
        const [links, trees, records] = await Promise.all([
          listLinks(500),
          listTrees(500),
          listAllRecords(500),
        ]);
        const noteByUrl = new Map(links.map((l: LinkRecord) => [l.url, l.note ?? '']));
        const treeByShare = new Map(trees.map((t: TreeSnapshot) => [t.shareId, t]));
        const folded = foldRecords(records);
        for (const g of folded) {
          g.note = noteByUrl.get(g.url) ?? '';
          g.title = titleOf(g.records[0], treeByShare.get(g.shareId), g.url);
        }
        setGroups(folded);
      } catch {
        toast('历史记录读取失败', 'error');
      } finally {
        setLoaded(true);
      }
    })();
  }, [toast]);

  const visible = useMemo(() => (filter === 'all' ? groups : groups.filter((g) => g.adapterId === filter)), [groups, filter]);

  const saveNote = async (url: string): Promise<void> => {
    await updateLinkNote(url, noteDraft.trim());
    setGroups((prev) => prev.map((g) => (g.url === url ? { ...g, note: noteDraft.trim() } : g)));
    setEditingNote(null);
    toast('备注已保存', 'success');
  };

  const downloadLog = async (g: TimelineGroup): Promise<void> => {
    const logs = (await listLogs(500)).filter((l) => l.url === g.url);
    const okAll = g.records.every((r) => r.ok);
    const status = logs.length === 0 ? 'u' : okAll ? 's' : 'm';
    const { fileName, content } = exportLogsMd(linkAbbr(g.url, g.adapterId), status, logs);
    downloadFile(fileName, content);
    toast(`已导出 ${fileName}`, 'success');
  };

  /** 删除一条链接：连带清掉树快照/解析记录/日志（1.1） */
  const deleteLink = async (g: TimelineGroup): Promise<void> => {
    await Promise.all([
      removeLink(g.url),
      removeTree(g.shareId),
      removeRecordsByShareId(g.shareId),
      removeLogsByUrl(g.url),
    ]);
    setGroups((prev) => prev.filter((x) => x.url !== g.url));
    toast('已删除该链接及其全部足迹', 'success');
  };

  /** 删除全部历史（链接/树/记录/日志全清，1.1） */
  const deleteAll = async (): Promise<void> => {
    await Promise.all([clearLinks(), clearTrees(), clearRecords(), clearLogs()]);
    setGroups([]);
    toast('已清空全部历史', 'success');
  };

  /** 导出历史（仅链接+时间，JSON 元数据；只做导出不做导入，1.1） */
  const exportHistory = async (): Promise<void> => {
    const links = await listLinks(500);
    const payload = links.map((l) => ({ time: new Date(l.addedAt).toISOString(), url: l.url }));
    const fileName = `panhub-praser-history-${new Date().toISOString().slice(0, 10)}.json`;
    downloadFile(fileName, JSON.stringify(payload, null, 2));
    toast(`已导出 ${payload.length} 条历史链接`, 'success');
  };

  return (
    <>
      <div className="card">
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="history-head">
            <h1 className="history-title">HISTORY · 解析历史</h1>
            <span className="field-hint">解析历史时间轴（仅本地，从未上传）</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              {visible.length > 0 && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void exportHistory()}>
                  导出 JSON
                </button>
              )}
              {visible.length > 0 && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    if (window.confirm(`确认清空全部 ${visible.length} 条历史（含日志）？此操作不可恢复`)) {
                      void deleteAll();
                    }
                  }}
                >
                  删除全部
                </button>
              )}
            </div>
          </div>
          <PanTable selectedId={filter} onSelect={setFilter} lastChip="all" />
        </div>
      </div>

      <div className="card">
        <div className="card-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
          {!loaded ? (
            <div className="empty-state">
              <span className="empty-icon">⏳</span>
              <span>加载历史中…</span>
            </div>
          ) : visible.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon">🗂</span>
              <span>暂无解析历史</span>
            </div>
          ) : (
            <div className="timeline">
              {visible.map((g) => {
                const isExpanded = expanded.has(g.url);
                const latest = g.records[0];
                const okLatest = latest.ok;
                const foldCount = g.records.length;
                return (
                  <div className="tl-item" key={g.url}>
                    <span className={`tl-dot ${okLatest ? '' : 'tl-dot--fail'}`}>{okLatest ? '✓' : '✗'}</span>
                    <div className="tl-body">
                      <div className="tl-title-row">
                        {filter === 'all' && (
                          <span className="meta-tag meta-tag--file" title={g.adapterId}>
                            {panLogo(g.adapterId)}
                          </span>
                        )}
                        <span className="tl-title">{g.title}</span>
                        <span className="meta-tag meta-tag--file">{g.adapterId.toUpperCase()}</span>
                        <span className="tl-time">{formatTime(latest.parsedAt)}</span>
                        {foldCount > 1 && (
                          <span
                            className="tl-fold"
                            onClick={() =>
                              setExpanded((prev) => {
                                const next = new Set(prev);
                                if (next.has(g.url)) next.delete(g.url);
                                else next.add(g.url);
                                return next;
                              })
                            }
                            title="展开/折叠同链接多次解析"
                          >
                            {isExpanded ? '收起' : `共 ${foldCount} 次解析`}
                          </span>
                        )}
                      </div>
                      {editingNote === g.url ? (
                        <div style={{ display: 'flex', gap: 8 }}>
                          <input
                            className="input"
                            style={{ flex: 1 }}
                            value={noteDraft}
                            onChange={(e) => setNoteDraft(e.target.value)}
                            placeholder="输入备注"
                            autoFocus
                          />
                          <button type="button" className="btn btn-primary btn-sm" onClick={() => void saveNote(g.url)}>
                            保存
                          </button>
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditingNote(null)}>
                            取消
                          </button>
                        </div>
                      ) : (
                        g.note && <div className="tl-note">📝 {g.note}</div>
                      )}
                      <div className="tl-sub">{g.url}</div>
                      {isExpanded &&
                        g.records.map((r) => (
                          <div key={r.id} className="tl-sub" style={{ paddingLeft: 12, borderLeft: '2px solid var(--border)' }}>
                            {formatTime(r.parsedAt)} · {r.ok ? '成功' : `失败${r.error ? `：${r.error}` : ''}`} · {r.fileCount} 个文件
                          </div>
                        ))}
                      <div className="tl-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            setEditingNote(g.url);
                            setNoteDraft(g.note);
                          }}
                        >
                          修改备注
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onReparse(g.url, true)}>
                          重新解析
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void downloadLog(g)}>
                          下载日志
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{ color: 'var(--danger, #d64545)' }}
                          onClick={() => {
                            if (window.confirm(`确认删除「${g.title}」的全部记录与日志？此操作不可恢复`)) {
                              void deleteLink(g);
                            }
                          }}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
