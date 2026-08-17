/**
 * 单文件解析失败警告弹窗（v1.1.4 规范三弹窗之三）
 *
 * 触发：单文件解析（prase）失败 —— 分享可能已与供应商断开连接或文件被删除。
 * 打开按钮发 modal（醒目），关闭发 toast（同文案）；主按钮直达「获取最新资源列表」。
 * 开关：设置 → 弹窗开关 → 单文件解析失败警告弹窗（默认开）。
 */
import type { JSX } from 'react';

export interface ParseFailModalProps {
  /** 失败的文件名（展示用） */
  fileName: string;
  /** 关闭（发 toast） */
  onClose: () => void;
  /** 刷新资源列表（主操作） */
  onRefresh: () => void;
}

export function ParseFailModal({ fileName, onClose, onRefresh }: ParseFailModalProps): JSX.Element {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <div className="modal-head">
          <h3 className="modal-title">单文件解析失败</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, color: 'var(--text-dim)' }}>
            <strong>{fileName}</strong> 解析失败，该文件可能已经与供应商断开连接或者在分享中被删除，
            请刷新资源列表后再试。
          </p>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            关闭
          </button>
          <button type="button" className="btn btn-primary" onClick={onRefresh}>
            刷新资源列表
          </button>
        </div>
      </div>
    </div>
  );
}
