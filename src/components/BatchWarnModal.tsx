/**
 * 批量解析提示弹窗（docs/STRUCTURE.md：src/components/BatchWarnModal.tsx）
 *
 * 跨文件夹批量仅支持 aria2/gopeed（需保留目录结构）；cURL / 浏览器直下不支持。
 * 触发：勾选跨目录文件且导出方式选了 curl / 浏览器直下。
 */
import type { JSX } from 'react';

export interface BatchWarnModalProps {
  /** 用户当前选择的导出方式（用于文案） */
  kindLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function BatchWarnModal({ kindLabel, onConfirm, onCancel }: BatchWarnModalProps): JSX.Element {
  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <div className="modal-head">
          <h3 className="modal-title">批量解析提示</h3>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, color: 'var(--text-dim)' }}>
            勾选的文件跨越多个文件夹，{kindLabel} 不支持保留目录结构。
          </p>
          <p style={{ margin: 0, color: 'var(--text-dim)' }}>
            跨文件夹批量解析<strong>仅支持 aria2 / gopeed</strong>（自动开启保留目录结构）。
          </p>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              onConfirm();
            }}
          >
            改用 aria2
          </button>
        </div>
      </div>
    </div>
  );
}
