/**
 * CORS 拦截弹窗（1.0.1 引入；1.1：引导填代理，按钮改为打开设置）
 *
 * 纯前端从非 drive.uc.cn 域直连 UC API 会被 CORS 白名单拦截（reverse-notes §3.2），
 * 正确解法是配置 API 转发代理（1.1）或书签注入（同源执行）。
 * 本弹窗在偏好"自动跳转"关闭时出现，引导用户打开设置填写代理地址。
 */
import type { JSX } from 'react';

export interface CorsJumpModalProps {
  message: string;
  onClose: () => void;
  /** 打开设置面板（引导填代理地址） */
  onOpenSettings: () => void;
}

export function CorsJumpModal({ message, onClose, onOpenSettings }: CorsJumpModalProps): JSX.Element {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <div className="modal-head">
          <h3 className="modal-title">CORS 拦截</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, color: 'var(--text-dim)' }}>{message}</p>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-faint)' }}>
            这里的代理仅转发请求头不上传任何个人数据，没有预设是为了防止服务被滥用。你可以打开右上角仓库查看自托管文档指南和视频指南，嫌麻烦的也可以拿里面站长预留的哦（感谢 cloudflare 良心额度，少薅一点，或者点个 star~~赎罪~~）
          </p>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={onOpenSettings}>
            打开设置
          </button>
        </div>
      </div>
    </div>
  );
}
