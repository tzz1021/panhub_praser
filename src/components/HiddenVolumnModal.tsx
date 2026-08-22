/**
 * 隐秘参数弹窗（docs/STRUCTURE.md：src/components/HiddenVolumnModal.tsx，v1.1.7）
 *
 * 开发者功能：结果页文件行的 <> 按钮触发（设置 → 高级功能 → 显示隐秘参数按钮）。
 * 弹窗展示网盘静态话术（各网盘字段说明），确认后 window.open 新标签直连官方 API
 * （noopener,noreferrer；实测 pc-api.uc.cn 不需要 refer，且导航不受 CORS 限制），
 * 不经过代理。关闭弹窗即可，无需在站内展示响应。
 *
 * 按钮：退出 / 继续。
 */
import type { JSX } from 'react';

export interface HiddenVolumnModalProps {
  /** 弹窗标题（各网盘静态话术，如 UC「该功能仅限开发者食用！！」） */
  title: string;
  /** 话术正文（静态资源，adapter.hiddenVolumn.body） */
  body: string;
  /** 确认继续：window.open 新标签打开官方 API 查询 URL（noopener,noreferrer） */
  onOpen: () => void;
  onClose: () => void;
}

export function HiddenVolumnModal({ title, body, onOpen, onClose }: HiddenVolumnModalProps): JSX.Element {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <div className="modal-head">
          <h3 className="modal-title">{title}</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, color: 'var(--text-dim)' }}>
            即将使用已经缓存的必要信息（依据云服务商确定，响应失败请检查最后获取资源列表的时间）
            在新标签页发起 api 查询，本次发起<strong>不经过代理</strong>，在你的浏览器完成。
            如果误点击请关闭弹窗退出查询，点击继续后立即跳转。
          </p>
          <p style={{ margin: '8px 0 0', fontWeight: 600, color: 'var(--text)' }}>
            个人已知信息如下，或许还有一些期待？如有偏差请提出 issues，更多进展欢迎 PR
          </p>
          <pre
            style={{
              margin: '8px 0 0',
              padding: 10,
              fontSize: 12,
              lineHeight: 1.5,
              background: 'var(--bg-code, rgba(0,0,0,0.06))',
              borderRadius: 6,
              border: '1px solid var(--border)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              maxHeight: '40vh',
              overflow: 'auto',
              userSelect: 'all',
            }}
          >
            {body}
          </pre>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            退出
          </button>
          <button type="button" className="btn btn-primary" onClick={onOpen}>
            继续
          </button>
        </div>
      </div>
    </div>
  );
}
