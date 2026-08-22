/**
 * 导出黄色提醒弹窗（docs/STRUCTURE.md：src/components/ExportYellowModal.tsx，v1.1.7）
 *
 * 触发：导出任务包含黄色直链（有效但剩余时间不足以支撑完整下载）时弹窗。
 * 设置 → 弹窗开关 → export 包含黄色标记是否弹窗提示：开=本弹窗，关=简略 toast（话术不变）。
 */
import type { JSX } from 'react';

export interface ExportYellowModalProps {
  onClose: () => void;
}

export function ExportYellowModal({ onClose }: ExportYellowModalProps): JSX.Element {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <div className="modal-head">
          <h3 className="modal-title">部分直链可能无法支撑到下载完成</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, color: 'var(--text)' }}>
            部分文件（黄底显示）可能在完成下载前过期，请不要挂机做好续杯准备
          </p>
          <p style={{ margin: '8px 0 0', color: 'var(--text-dim)' }}>
            若需要批量导出建议单独重新解析这些文件显示为绿色再导出以免续杯翻找目录
          </p>
          <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--text-faint)' }}>
            ProTip：使用下载器推送可以方便跟踪进度，命令行建议使用 aria2 提速、通过 .aria2 格式定位下载未完成的文件
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
