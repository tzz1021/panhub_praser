/**
 * 默认下载/解析方式（docs/STRUCTURE.md：src/components/settings/DefaultMode.tsx）
 * 对应 HANDOFF 附件 §2：单文件 / 同目录批量 / 跨文件夹三组设置。
 */
import type { JSX } from 'react';
import type { Preferences } from '../../core/types';
import { Switch } from './UacTable';

export interface DefaultModeProps {
  prefs: Preferences;
  onChange: (patch: Partial<Preferences>) => void;
}

/** 二选一段（解析/下载） */
function ModeSegment({
  value,
  onChange,
}: {
  value: 'parse' | 'download';
  onChange: (v: 'parse' | 'download') => void;
}): JSX.Element {
  return (
    <div className="segment">
      <button type="button" className={value === 'parse' ? 'active' : ''} onClick={() => onChange('parse')}>
        解析
      </button>
      <button type="button" className={value === 'download' ? 'active' : ''} onClick={() => onChange('download')}>
        下载
      </button>
    </div>
  );
}

export function DefaultMode({ prefs, onChange }: DefaultModeProps): JSX.Element {
  return (
    <div className="settings-section">
      <div className="settings-section-title">默认下载 / 解析</div>
      <div className="switch-row">
        <div>
          <div className="switch-label">单个文件默认方式</div>
          <div className="switch-sub">解析=展示直链与下载方式；下载=直接按默认方式下载</div>
        </div>
        <ModeSegment value={prefs.singleFileMode} onChange={(v) => onChange({ singleFileMode: v })} />
      </div>
      <div className="switch-row">
        <div>
          <div className="switch-label">同目录批量默认方式</div>
          <div className="switch-sub">下载=逐个按单文件方式处理</div>
        </div>
        <ModeSegment value={prefs.sameDirMode} onChange={(v) => onChange({ sameDirMode: v })} />
      </div>

      <div className="settings-section-title" style={{ marginTop: 10 }}>
        跨文件夹
      </div>
      <div className="switch-row">
        <div className="switch-label">保留原始目录结构（aria2/gopeed/curl）</div>
        <Switch on={prefs.keepStructure} onChange={(v) => onChange({ keepStructure: v })} />
      </div>
      <div className="switch-row">
        <div>
          <div className="switch-label">扫描深度</div>
          <div className="switch-sub">0 = 不限</div>
        </div>
        <input
          className="input"
          type="number"
          min={0}
          max={20}
          style={{ width: 90, padding: '6px 10px' }}
          value={prefs.scanDepth}
          onChange={(e) => onChange({ scanDepth: Math.max(0, Number(e.target.value) || 0) })}
        />
      </div>
      <div className="switch-row">
        <div className="switch-label">显示文件夹大小</div>
        <Switch on={prefs.showDirSize} onChange={(v) => onChange({ showDirSize: v })} />
      </div>
      <div className="switch-row">
        <div className="switch-label">确认解析弹窗（默认开）</div>
        <Switch on={prefs.confirmParse} onChange={(v) => onChange({ confirmParse: v })} />
      </div>
      <div className="switch-row">
        <div className="switch-label">显示每个 file 的下载器 ETA 跟踪</div>
        <Switch on={prefs.trackEta} onChange={(v) => onChange({ trackEta: v })} />
      </div>
      <div className="switch-row">
        <div className="switch-label">显示目录树</div>
        <Switch on={prefs.showTree} onChange={(v) => onChange({ showTree: v })} />
      </div>
      <div className="switch-row">
        <div>
          <div className="switch-label">资源复用窗口（小时）</div>
          <div className="switch-sub">0 = 不复用；窗口内再进同一分享复用缓存目录树，已解析直链（oss+sig）不再重复请求</div>
          <div className="switch-sub">建议按你常用云服务里直链过期时间最短的来设（UC 实测 3-6h），窗口超过直链实际有效期等于白设</div>
        </div>
        <input
          className="input"
          type="number"
          min={0}
          max={24}
          style={{ width: 90, padding: '6px 10px' }}
          value={prefs.reuseWindowHours}
          onChange={(e) => onChange({ reuseWindowHours: Math.max(0, Math.min(24, Number(e.target.value) || 0)) })}
        />
      </div>
    </div>
  );
}
