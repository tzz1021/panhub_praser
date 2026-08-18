/**
 * cloudflare 温馨提示（v1.1.5.2 兜底防刷）
 *
 * 触发：代理地址为 pages.dev 结尾时，手动终止后的单文件重新解析若与上次终止
 * 发生在相同 MM:SS（同一秒内完成终止+重试 = 脚本高频循环特征），强制弹出。
 * 仅一个按钮【知道了（可怜中）】：关闭后不继续本次解析（需再次点击才会真正请求）。
 */
import type { JSX } from 'react';

export interface CloudflareWarnModalProps {
  onClose: () => void;
}

export function CloudflareWarnModal({ onClose }: CloudflareWarnModalProps): JSX.Element {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <div className="modal-head">
          <h3 className="modal-title">cloudflare 温馨提示</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, fontWeight: 700, color: 'var(--text)' }}>
            检测到你的 prase 请求过于频繁，建议重新打开设置里的 cookie 警告弹窗开关，如果 cookie 没有问题请不要中断解析哦
          </p>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            知道了（可怜中）
          </button>
        </div>
      </div>
    </div>
  );
}
