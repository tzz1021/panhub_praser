/**
 * cookie 读取状态警告弹窗（docs/STRUCTURE.md：src/components/CookieWarnModal.tsx）
 *
 * §10（reverse-notes-uc.md）：UC 下载层需要 __pugs 人机校验 cookie（游客态即可）。
 * 弹窗内容分两部分：
 *   1. 供应商专属（adapter.cookie 提供）：如实显示本次捕获到的 cookie 值（**完整明文**，
 *      方便社区开发者调试/排查），没有则提示排查（cookie 存储限制/无痕/AdGuard 拦截标签页）
 *   2. 通用话术：详情参阅设置顶部 UAC 状况
 * 按钮：【算了吧】= 跳过预热继续解析；【我已阅，继续】= 新标签预热 + 继续解析。
 * 开关：设置 → 弹窗开关 → 读取 Cookie 警告弹窗（默认开，可关）。
 *
 * 明文说明（2026-08-16）：该值只在本机展示/导出命令本地拼接，不会随请求上传；
 * 显示完整值是为了社区开发者不用翻日志就能核对捕获结果（reverse-notes-uc.md §11.4）。
 */
import type { JSX } from 'react';
import type { CookieRequirement } from '../adapters/types';
import { copyText } from '../utils/clipboard';

export interface CookieWarnModalProps {
  /** 网盘名称（如 "UC 网盘"） */
  panName: string;
  /** 下载层 cookie 规格（adapter.cookie） */
  cookie: CookieRequirement;
  /** 本次捕获到的值（可能为空串） */
  capturedValue: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function CookieWarnModal({ panName, cookie, capturedValue, onConfirm, onCancel }: CookieWarnModalProps): JSX.Element {
  const hasValue = capturedValue.length > 0;
  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="modal-head">
          <h3 className="modal-title">cookie 读取状态</h3>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, color: 'var(--text-dim)' }}>
            <strong>{panName}</strong> 需要 cookie 鉴权，下面是本次获取到的必要 cookie 值
            【如实显示{hasValue ? '' : '，没有'}】：
          </p>
          <div
            style={{
              margin: '8px 0',
              padding: '8px 10px',
              borderRadius: 6,
              background: hasValue ? 'rgba(40,167,69,0.08)' : 'rgba(220,53,69,0.08)',
              border: `1px solid ${hasValue ? 'rgba(40,167,69,0.35)' : 'rgba(220,53,69,0.35)'}`,
              fontFamily: 'monospace',
              fontSize: 12,
              wordBreak: 'break-all',
              color: 'var(--text)',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
            }}
          >
            <code style={{ flex: 1, whiteSpace: 'pre-wrap', userSelect: 'all' }}>
              {cookie.displayName}={hasValue ? capturedValue : '（空）'}
            </code>
            {hasValue && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ flexShrink: 0, marginTop: -2 }}
                title="复制完整 cookie 值（社区开发者调试用）"
                onClick={() => void copyText(`${cookie.displayName}=${capturedValue}`)}
              >
                复制
              </button>
            )}
            {/* v1.1.5：当前长度按钮，供用户自行核对（标准长度见下） */}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ flexShrink: 0, marginTop: -2 }}
              disabled
              title="当前捕获到的 cookie 值长度"
            >
              当前长度 {capturedValue.length}
            </button>
          </div>
          {hasValue && (
            <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-faint)' }}>
              该 cookie 叫做 {cookie.key}
              {cookie.standardLength !== undefined && `，标准长度 ${cookie.standardLength}`}，
              请自行核对后继续；你可以在设置中关闭该提示。
            </p>
          )}
          {!hasValue && (
            <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-faint)' }}>{cookie.missingHint}</p>
          )}
          <p style={{ margin: '10px 0 0', fontSize: 12.5, color: 'var(--text-faint)' }}>
            详情请参阅设置顶部 UAC 状况，一般供应商需要获取必要 cookie 才能获取文件流。
          </p>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            算了吧
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            我已阅，继续
          </button>
        </div>
      </div>
    </div>
  );
}
