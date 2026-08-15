/**
 * 读取 cookie 警告弹窗（docs/STRUCTURE.md：src/components/CookieWarnModal.tsx）
 *
 * v1 UC 零 cookie 不触发（HANDOFF §7：默认关，等接入需要 cookie 的网盘再启用）。
 * 一次性确认后写入偏好 modals.cookieWarn = false。
 */
import type { JSX } from 'react';

export interface CookieWarnModalProps {
  /** 网盘名称（如 "百度网盘"） */
  panName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function CookieWarnModal({ panName, onConfirm, onCancel }: CookieWarnModalProps): JSX.Element {
  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <div className="modal-head">
          <h3 className="modal-title">读取 Cookie 提示</h3>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, color: 'var(--text-dim)' }}>
            解析 <strong>{panName}</strong> 需要读取您的登录 Cookie，仅在本机使用，不会上传。
          </p>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-faint)' }}>
            日志导出时会自动对 Cookie 做删除线脱敏。可随时在设置中关闭本提示。
          </p>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            知道了，继续
          </button>
        </div>
      </div>
    </div>
  );
}
