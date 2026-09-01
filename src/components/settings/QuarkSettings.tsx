/**
 * 夸克网盘专属设置（docs/STRUCTURE.md：src/components/settings/QuarkSettings.tsx，v1.1.9.final）
 *
 * qk-guestTurn：模拟游客访问夸克 <50MB 文件。
 * - 开：小文件走游客态（随机/捕获 __pugs 发起请求，不注入登录态整串），快但依赖 pugs 捕获链路；
 *   关闭（默认）：所有文件一律按登录态处理（直接弹 CookieInputModal，最稳妥）。
 * - 副标题「配置本地管理面板后不生效」：backend 账号池上线后游客流转由后端接管，本开关失效。
 */
import type { JSX } from 'react';
import type { QuarkPrefs } from '../../core/types';
import { Switch } from './UacTable';

export interface QuarkSettingsProps {
  quark: QuarkPrefs;
  onChange: (patch: Partial<QuarkPrefs>) => void;
}

export function QuarkSettings({ quark, onChange }: QuarkSettingsProps): JSX.Element {
  return (
    <div className="settings-section">
      <div className="settings-section-title">夸克网盘特设</div>
      <div className="switch-row">
        <div>
          <div className="switch-label">游客模拟开关（qk-guestTurn）</div>
          <div className="switch-sub">
            模拟游客访问夸克网盘小于 50MB 的文件。开启：小文件走游客态（随机 __pugs），快但依赖捕获链路；
            关闭（默认）：所有文件一律走登录态填写（最稳妥）。配置本地管理面板后不生效。
          </div>
        </div>
        <Switch on={quark.qkGuestTurn} onChange={(v) => onChange({ qkGuestTurn: v })} label="qk-guestTurn" />
      </div>
    </div>
  );
}
