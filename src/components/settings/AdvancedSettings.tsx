/**
 * 高级功能设置区（docs/STRUCTURE.md：src/components/settings/AdvancedSettings.tsx，v1.1.7）
 *
 * 折叠区（小标题「高级功能」），总开关默认关闭；关闭时内部开关灰色淡化不可用。
 * 项：aria2 导出额外参数 / gopeed 导出额外参数 / 显示隐秘参数按钮（<>）/
 * 二级：显示按钮功能和部分参数的含义 sub 弹窗提示。
 */
import type { JSX } from 'react';
import type { AdvancedPrefs } from '../../core/types';
import { Switch } from './UacTable';

export interface AdvancedSettingsProps {
  advanced: AdvancedPrefs;
  onChange: (patch: Partial<AdvancedPrefs>) => void;
}

export function AdvancedSettings({ advanced, onChange }: AdvancedSettingsProps): JSX.Element {
  const disabled = !advanced.enabled;
  return (
    <div className="settings-section">
      <div className="settings-section-title">高级功能</div>
      <div className="switch-row">
        <div>
          <div className="switch-label">高级功能总开关</div>
          <div className="switch-sub">关闭时下方选项全部不可用（灰色淡化）</div>
        </div>
        <Switch on={advanced.enabled} onChange={(v) => onChange({ enabled: v })} label="高级功能总开关" />
      </div>
      <div className="switch-row" style={{ opacity: disabled ? 0.45 : 1 }}>
        <div style={{ flex: 1 }}>
          <div className="switch-label">aria2 导出额外参数</div>
          <div className="switch-sub">默认留空；原样拼进每条 aria2 命令（--out 之后、URL 之前）</div>
          <input
            className="input"
            style={{ width: '100%', marginTop: 6, padding: '6px 10px', boxSizing: 'border-box' }}
            disabled={disabled}
            placeholder='如 --max-connection-per-server=16 --split=16 --min-split-size=1M'
            value={advanced.aria2Extra}
            onChange={(e) => onChange({ aria2Extra: e.target.value })}
          />
        </div>
      </div>
      <div className="switch-row" style={{ opacity: disabled ? 0.45 : 1 }}>
        <div style={{ flex: 1 }}>
          <div className="switch-label">gopeed 导出额外参数</div>
          <div className="switch-sub">默认留空；JSON 对象合并进每个任务的 store（非 JSON 忽略）</div>
          <input
            className="input"
            style={{ width: '100%', marginTop: 6, padding: '6px 10px', boxSizing: 'border-box' }}
            disabled={disabled}
            placeholder='如 {"connections": 16}'
            value={advanced.gopeedExtra}
            onChange={(e) => onChange({ gopeedExtra: e.target.value })}
          />
        </div>
      </div>
      <div className="switch-row" style={{ opacity: disabled ? 0.45 : 1 }}>
        <div>
          <div className="switch-label">显示隐秘参数按钮</div>
          <div className="switch-sub">结果页文件行出现 &lt;&gt; 按钮，开发者直连官方 API 查看原始参数</div>
        </div>
        <Switch on={advanced.showHiddenVolumn} onChange={(v) => onChange({ showHiddenVolumn: v })} label="显示隐秘参数按钮" />
      </div>
      {/* 二级选项：仅在隐秘参数按钮开启时可用 */}
      <div className="switch-row" style={{ opacity: disabled || !advanced.showHiddenVolumn ? 0.45 : 1 }}>
        <div>
          <div className="switch-label">点击 &lt;&gt; 按钮前弹窗说明字段含义</div>
          <div className="switch-sub">
            开启：点 &lt;&gt; 先弹窗展示各字段含义（网盘静态话术），确认后再新标签直连官方 API；
            关闭：点 &lt;&gt; 直接新标签跳转。
          </div>
        </div>
        <Switch on={advanced.hiddenVolumnHint} onChange={(v) => onChange({ hiddenVolumnHint: v })} label="点击 <> 按钮前弹窗说明字段含义" />
      </div>
    </div>
  );
}
