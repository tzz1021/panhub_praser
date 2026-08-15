/**
 * 需要登录 → 跳转提示弹窗（docs/STRUCTURE.md：src/components/LoginJumpModal.tsx）
 *
 * HANDOFF §7：JS 只能关闭自己打开的标签页。本弹窗区分两种跳转：
 * - onJump（打开分享页登录）：打开的是新标签，可自动关闭
 * - 用户自己开的标签：无法关闭，仅提示
 */
import type { JSX } from 'react';
import { useToast } from './Toast';

export interface LoginJumpModalProps {
  message: string;
  onClose: () => void;
  /** 打开登录页（新标签） */
  onJump: () => void;
  /** 是否在新标签打开后自动关闭它（跟随偏好 modals.autoCloseTab） */
  autoClose?: boolean;
}

export function LoginJumpModal({ message, onClose, onJump, autoClose = true }: LoginJumpModalProps): JSX.Element {
  const { toast } = useToast();
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
        <div className="modal-head">
          <h3 className="modal-title">需要登录</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, color: 'var(--text-dim)' }}>{message}</p>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-faint)' }}>
            {autoClose
              ? '将在新标签页打开分享链接，登录完成后自动关闭该标签。'
              : '请在打开的分享页面完成登录后返回重试。'}
          </p>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              const win = window.open('', '_blank');
              onJump();
              if (autoClose && win) {
                // 给新标签加载留时间；仅关我们打开的标签（HANDOFF §7）
                setTimeout(() => {
                  try {
                    win.close();
                  } catch {
                    /* 跨域/被用户接管时忽略 */
                  }
                }, 60000);
                toast('登录完成后本标签会自动关闭', 'info');
              }
            }}
          >
            跳转登录
          </button>
        </div>
      </div>
    </div>
  );
}
