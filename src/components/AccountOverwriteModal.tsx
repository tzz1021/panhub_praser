/**
 * 账号覆盖确认弹窗（v1.3.1：阿里云盘特设、强制开启 —— 与偏好开关无关）
 *
 * 触发：本次解析使用的账号与**上次暂存区的账号**不一致时（Tzz 定稿）：
 *   可能是后端删掉了上次使用的账号导致本次随机抽号，也可能是两次人工输入切换了账号。
 * 选项：
 *   是 → 覆盖暂存区记录（换号则作废旧账号的转存映射，carry 重新开始）
 *   否 → 本次输入仅本次有效（内存态，刷新即失效，不写 localStorage、不进后端统计）
 *
 * 话术与按钮文案全部来自适配器常量（adapter.carryOver.accountSwitchPrompt），本组件不硬编码文案。
 */
import type { JSX } from 'react';

export interface AccountOverwriteModalProps {
  /** 标题（适配器话术：是否覆盖当前暂存区的 userid） */
  title: string;
  /** 说明行（适配器话术：账号信息复用包含 userid 的临时 auth，对应 drive_id 和 to_parent_file_id） */
  context: string;
  /** 「是」按钮文案 */
  confirmText: string;
  /** 「否」按钮文案 */
  cancelText: string;
  /** 是：覆盖暂存（persist） */
  onConfirm: () => void;
  /** 否：仅本次有效（session） */
  onCancel: () => void;
}

export function AccountOverwriteModal({
  title,
  context,
  confirmText,
  cancelText,
  onConfirm,
  onCancel,
}: AccountOverwriteModalProps): JSX.Element {
  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <div className="modal-head">
          <h3 className="modal-title">{title}</h3>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, fontWeight: 700, color: 'var(--text)' }}>{context}</p>
          <p style={{ margin: '10px 0 0', fontSize: 12.5, color: 'var(--text-dim)' }}>
            选「{cancelText}」本次输入仅本次有效（不覆盖暂存区，刷新页面即失效）。
          </p>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            {cancelText}
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
