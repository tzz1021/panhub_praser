/**
 * 折叠状态恢复询问弹窗（docs/STRUCTURE.md：src/components/RestoreCollapsedModal.tsx，v1.1.7）
 *
 * 触发：目录树来自足迹缓存快照复用，且本地保存了上次折叠状态时，
 * 设置 → RestoreCollapsedStatus = 每次询问（默认）则弹窗。
 * 选项：不用了（丢弃上次状态）/ 好的（恢复上次折叠状态）。
 */
import type { JSX } from 'react';

export interface RestoreCollapsedModalProps {
  /** 上次保存折叠状态的时间 HH:MM（展示用） */
  savedAtLabel: string;
  onRestore: () => void;
  onDiscard: () => void;
}

export function RestoreCollapsedModal({ savedAtLabel, onRestore, onDiscard }: RestoreCollapsedModalProps): JSX.Element {
  return (
    <div className="modal-mask" onClick={onDiscard}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
        <div className="modal-head">
          <h3 className="modal-title">恢复目录折叠状态</h3>
          <button type="button" className="modal-close" onClick={onDiscard} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, color: 'var(--text)' }}>检测到 {savedAtLabel} 关闭该目录，是否回到先前折叠状态</p>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-secondary" onClick={onDiscard}>
            不用了
          </button>
          <button type="button" className="btn btn-primary" onClick={onRestore}>
            好的
          </button>
        </div>
      </div>
    </div>
  );
}
