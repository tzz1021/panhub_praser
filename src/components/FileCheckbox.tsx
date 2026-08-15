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
  filterText: string;
  onFilterChange: (text: string) => void;
}

export function FileCheckbox({
  selectedCount,
  totalFiles,
  onSelectAll,
  onSelectInvert,
  onSelectNone,
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
