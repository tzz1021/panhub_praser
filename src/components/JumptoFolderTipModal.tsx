/**
 * 跳转到文件夹提示弹窗（docs/STRUCTURE.md：src/components/JumptoFolderTipModal.tsx，v1.1.6）
 *
 * 触发：0B 文件夹（风控导致目录树拉取失败）点「转到此文件夹」时，
 * 设置 → 弹窗开关 → 跳转到文件夹是否提示 开启则先弹本窗。
 * 确认后新建一个相关联的链接任务（跳转长链接 → scanner 二次获取该文件夹资源列表）。
 */
import type { JSX } from 'react';

export interface JumptoFolderTipModalProps {
  /** 目标文件夹绝对路径（日志/提示展示） */
  folderPath: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function JumptoFolderTipModal({ folderPath, onConfirm, onCancel }: JumptoFolderTipModalProps): JSX.Element {
  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <div className="modal-head">
          <h3 className="modal-title">跳转到文件夹</h3>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, color: 'var(--text-dim)', wordBreak: 'break-all' }}>
            文件夹标识符来自上一次获取资源目录的缓存，如果无法跳转或者页面卡死请手动重试，
            反复重试失败大概是文件夹被取消分享或者与云服务商断开连接，请尝试刷新资源列表后重试
          </p>
          <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--text-faint)', wordBreak: 'break-all' }}>
            目标：{folderPath}
          </p>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            算了吧
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            继续跳转
          </button>
        </div>
      </div>
    </div>
  );
}
