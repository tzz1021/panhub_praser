/**
 * 导出任务失败警告弹窗（v1.1.4 规范三弹窗之二）
 *
 * 触发：点击导出按钮但没有可导出的有效文件（未勾选 / 勾选部分未解析 /
 * 已解析但直链过期）。打开按钮发 modal（醒目），关闭发 toast（同文案）。
 * 开关：设置 → 弹窗开关 → 导出任务失败警告弹窗（默认开）。
 */
import type { JSX } from 'react';

export interface ExportFailModalProps {
  onClose: () => void;
}

export function ExportFailModal({ onClose }: ExportFailModalProps): JSX.Element {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <div className="modal-head">
          <h3 className="modal-title">无法导出任务</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, color: 'var(--text-dim)' }}>
            未选中任何文件或者选中部分含有未解析、已解析但过期的文件。
          </p>
          <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--text-faint)' }}>
            请检查所选部分是否为空；显示【重新解析】的文件表明上次解析已过期，请重新解析；
            若重新解析失败，请尝试刷新资源列表，这会清空所有暂存区的 oss 直链。
          </p>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
