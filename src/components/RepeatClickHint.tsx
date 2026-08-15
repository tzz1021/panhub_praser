/**
 * 反复点击"批量解析"提示（docs/STRUCTURE.md：src/components/RepeatClickHint.tsx）
 *
 * 短时间重复点击批量解析按钮时提示，避免重复请求。
 */
import type { JSX } from 'react';

export interface RepeatClickHintProps {
  onClose: () => void;
}

export function RepeatClickHint({ onClose }: RepeatClickHintProps): JSX.Element {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 380 }}>
        <div className="modal-head">
          <h3 className="modal-title">提示</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, color: 'var(--text-dim)' }}>
            已检测到重复点击"批量解析"。解析任务正在进行中，请耐心等待，无需重复操作。
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
