/**
 * 文件勾选工具条（docs/STRUCTURE.md：src/components/FileCheckbox.tsx）
 * 全选 / 反选 / 清空 + 名称过滤（结果页"资源列表"头部）。
 */
import type { JSX } from 'react';

export interface FileCheckboxProps {
  selectedCount: number;
  totalFiles: number;
  onSelectAll: () => void;
  onSelectInvert: () => void;
  onSelectNone: () => void;
  /** v1.1.7：按直链状态批量勾选（绿/黄/红/未解析/已过期） */
  onSelectByStatus: (kind: 'green' | 'yellow' | 'red' | 'unparsed' | 'expired') => void;
  filterText: string;
  onFilterChange: (text: string) => void;
}

export function FileCheckbox({
  selectedCount,
  totalFiles,
  onSelectAll,
  onSelectInvert,
  onSelectNone,
  onSelectByStatus,
  filterText,
  onFilterChange,
}: FileCheckboxProps): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 13, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
        已选 <strong style={{ color: 'var(--primary)' }}>{selectedCount}</strong> / {totalFiles}
      </span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onSelectAll}>
        全选
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onSelectInvert}>
        反选
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onSelectNone}>
        清空
      </button>
      <span style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 2px' }} />
      {/* v1.1.7：按直链状态批量勾选（带复选框语义，基于当前解析结果离线判定） */}
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onSelectByStatus('green')} title="勾选全部绿色（有效期足够支撑完整下载）">
        选中所有绿色标记
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onSelectByStatus('yellow')} title="勾选全部黄色（有效但剩余时间可能不够完整下载）">
        选中所有黄色标记
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onSelectByStatus('red')} title="勾选全部红色（失败/手动终止）">
        选中所有红色标记
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onSelectByStatus('unparsed')} title="勾选全部未解析（白色）">
        选中所有未解析
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onSelectByStatus('expired')} title="勾选全部已过期（超窗口/oss Expires 过期）">
        选中所有已过期
      </button>
      <input
        className="input"
        style={{ width: 160, padding: '6px 10px', fontSize: 13 }}
        placeholder="按名称过滤…"
        value={filterText}
        onChange={(e) => onFilterChange(e.target.value)}
      />
    </div>
  );
}
