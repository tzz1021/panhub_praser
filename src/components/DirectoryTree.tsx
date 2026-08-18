/**
 * 目录树（docs/STRUCTURE.md：src/components/DirectoryTree.tsx）
 *
 * 展示性组件：树形缩进 + 勾选（文件）/ 展开收起（目录）+ 大小/时间/操作列。
 * 目录行显示 static 图标区分 file/folder（参考 pdpb.cn）。
 * 勾选状态由父级（ResultPage）持有，本组件只渲染与回调。
 */
import type { JSX } from 'react';
import type { ShareFile } from '../adapters/types';
import type { LinkEntry, TreeNode } from '../core/types';
import { formatSize, formatTime } from '../utils/format';
import { linkDetailOf, type LinkDetail, type LinkStatusKind } from '../utils/linkStatus';

/** 树节点扁平行（ResultPage 预计算：按展开状态拍平 + 缩进） */
export interface TreeRow {
  node: TreeNode;
  depth: number;
}

export interface DirectoryTreeProps {
  rows: TreeRow[];
  /** 已展开的目录 fid 集合 */
  expanded: ReadonlySet<string>;
  /** 已勾选的文件 fid 集合 */
  checked: ReadonlySet<string>;
  /** fid → 直链结果（批量解析后；含获取时间/终止标记，v1.1.5） */
  links: ReadonlyMap<string, LinkEntry>;
  /** 复用窗口小时（直链新鲜/过期判定，与设置一致） */
  reuseWindowHours: number;
  onToggleDir: (fid: string) => void;
  onToggleFile: (fid: string) => void;
  onToggleDirAll: (node: TreeNode) => void;
  /** 单文件解析（§12：原“复制直链”位置改解析按钮）；缺省不显示 */
  onParseFile?: (fid: string) => void;
  /** 解析进行中（禁用按钮，防连点） */
  busy?: boolean;
}

export function DirectoryTree({
  rows,
  checked,
  links,
  onToggleDir,
  onToggleFile,
  onToggleDirAll,
  onParseFile,
  busy,
  reuseWindowHours,
}: DirectoryTreeProps): JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-icon">📂</span>
        <span>暂无解析数据</span>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="file-table">
        <thead>
          <tr>
            <th className="col-name">名称</th>
            <th className="col-num">大小</th>
            <th className="col-num">创建时间</th>
            <th className="col-action">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ node, depth }) => {
            const f = node.file;
            const isDir = Boolean(f.dir);
            const link = links.get(f.fid);
            const detail: LinkDetail = linkDetailOf(link, reuseWindowHours, f.size);
            const status: LinkStatusKind = detail.kind === 'green' ? 'green' : detail.kind === 'yellow' ? 'yellow' : detail.kind === 'failed' || detail.kind === 'terminated' ? 'red' : 'white';
            const rowClass =
              status === 'green' ? 'file-row--green' : status === 'yellow' ? 'file-row--yellow' : status === 'red' ? 'file-row--red' : '';
            return (
              <tr key={f.fid} className={rowClass}>
                <td className="col-name">
                  <div className="tree-row">
                    {depth > 0 && <span className="tree-spacer">{'\u00A0'.repeat((depth - 1) * 4)}├─ </span>}
                    <input
                      type="checkbox"
                      checked={isDir ? dirChecked(node, checked) : checked.has(f.fid)}
                      onChange={() => (isDir ? onToggleDirAll(node) : onToggleFile(f.fid))}
                      title={isDir ? '勾选/取消该目录下全部文件' : undefined}
                    />
                    <span
                      className="tree-row file-name"
                      style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: isDir ? 'pointer' : 'default' }}
                      onClick={isDir ? () => onToggleDir(f.fid) : undefined}
                    >
                      <span className="file-icon">{isDir ? '📁' : '📄'}</span>
                      <span className={isDir ? 'file-name file-name--dir' : 'file-name'}>{f.fileName}</span>
                    </span>
                    <span className={`meta-tag ${isDir ? 'meta-tag--folder' : 'meta-tag--file'}`}>
                      {isDir ? 'folder' : 'file'}
                    </span>
                  </div>
                </td>
                <td className="col-num">{formatSize(node.size)}</td>
                <td className="col-num">{formatTime(f.modifiedAt)}</td>
                <td className="col-action">
                  {/* v1.1.5.3：移除每行 status:xxx 文本（保留四色行底色 + 状态按钮） */}
                  {!isDir && detail.kind === 'failed' && onParseFile && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => onParseFile(f.fid)}
                      disabled={busy}
                      title="网络等不可抗拒因素导致失败，点击重试"
                    >
                      重试
                    </button>
                  )}
                  {!isDir && detail.kind === 'expired' && onParseFile && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => onParseFile(f.fid)}
                      disabled={busy}
                      title="直链已过期，一键续杯（重新获取下载链接）"
                    >
                      一键续杯
                    </button>
                  )}
                  {!isDir && detail.kind === 'terminated' && onParseFile && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => onParseFile(f.fid)}
                      disabled={busy}
                      title="上次手动终止，重新解析该文件"
                    >
                      重新解析
                    </button>
                  )}
                  {!isDir && detail.kind === 'none' && onParseFile && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => onParseFile(f.fid)}
                      disabled={busy}
                      title="解析该文件（需 cookie 的网盘会先弹窗）"
                    >
                      解析
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 目录勾选态：子树全部勾选才显示勾选 */
function dirChecked(node: TreeNode, checked: ReadonlySet<string>): boolean {
  if (!node.children) return false;
  return node.children.every((c) => (c.file.dir ? dirChecked(c, checked) : checked.has(c.file.fid)));
}

/** 工具：把树拍平成行（按 expanded 展开状态），供 ResultPage 使用 */
export function flattenTree(root: TreeNode, expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (node: TreeNode, depth: number): void => {
    rows.push({ node, depth });
    if (node.file.dir && node.children && expanded.has(node.file.fid)) {
      for (const child of node.children) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

/** 工具：收集某节点下全部叶子文件 */
export function collectLeaves(node: TreeNode, out: ShareFile[] = []): ShareFile[] {
  if (node.children) {
    for (const c of node.children) collectLeaves(c, out);
  } else if (!node.file.dir) {
    out.push(node.file);
  }
  return out;
}
