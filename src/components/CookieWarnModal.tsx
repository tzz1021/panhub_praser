/**
 * 读取 cookie 警告弹窗（docs/STRUCTURE.md：src/components/CookieWarnModal.tsx）
 *
 * §10（reverse-notes-uc.md）：UC 下载层需要 __pugs 人机校验 cookie（游客态即可）。
 * 点击"确定"→ HomePage 执行"新标签预热"（window.open 分享页 → 页面 JS 自动触发
 * API → __pugs 写入浏览器 jar → 稍候自动关闭标签），同时解析照常进行。
 * 弹窗开关：设置 → 弹窗开关 → 读取 Cookie 警告弹窗（默认开，可关）。
 */
import type { JSX } from 'react';

export interface CookieWarnModalProps {
  /** 网盘名称（如 "UC 网盘"） */
  panName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function CookieWarnModal({ panName, onConfirm, onCancel }: CookieWarnModalProps): JSX.Element {
  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <div className="modal-head">
          <h3 className="modal-title">读取 Cookie 提示</h3>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, color: 'var(--text-dim)' }}>
            你选择的云存储供应商 <strong>{panName}</strong> 需要 cookie 鉴权，接下来将在本机浏览器获取。
            点击确定后会开启新的标签页自动提取 cookie，当前无需登录也不会自动跳转（请稍等片刻），
            关闭本站后先前打开的标签页会自动关闭。
          </p>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-faint)' }}>
            仅在本机提取（人机校验令牌，游客态即可），不会上传。可随时在设置中关闭本提示。
          </p>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            跳过
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            知道了，开始提取
          </button>
        </div>
      </div>
    </div>
  );
}
