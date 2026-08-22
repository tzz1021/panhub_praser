/**
 * 默认下载/解析设置（docs/STRUCTURE.md：src/components/settings/DefaultMode.tsx）
 * v1.1.7：默认下载/解析方式选项与残余代码已移除（本来就没有功能代码）。
 */
import type { JSX } from 'react';
import type { Preferences } from '../../core/types';
import { Switch } from './UacTable';

export interface DefaultModeProps {
  prefs: Preferences;
  onChange: (patch: Partial<Preferences>) => void;
}

export function DefaultMode({ prefs, onChange }: DefaultModeProps): JSX.Element {
  return (
    <div className="settings-section">
      <div className="settings-section-title">默认下载 / 解析</div>
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
        <div>
          <div className="switch-label">显示属性</div>
          <div className="switch-sub">scanner 受到风控影响无法做到完整遍历，因此只显示该文件夹下面的一级文件格式和一级文件夹个数</div>
        </div>
        <Switch on={prefs.showDirProps} onChange={(v) => onChange({ showDirProps: v })} />
      </div>
      <div className="switch-row">
        <div>
          <div className="switch-label">显示 etag</div>
          <div className="switch-sub">单文件的校验和，云服务供应商提供，是否可及和种类请查 UAC 表格；离线进行，从数据库读取</div>
        </div>
        <Switch on={prefs.showEtag} onChange={(v) => onChange({ showEtag: v })} />
      </div>
      <div className="switch-row">
        <div>
          <div className="switch-label">显示详细的解析时间和有效期</div>
          <div className="switch-sub">文件行显示「上次HH:MM剩xHxM」状态文本（v1.1.7 起为选项，默认关）</div>
        </div>
        <Switch on={prefs.showLinkDetail} onChange={(v) => onChange({ showLinkDetail: v })} />
      </div>
      <div className="switch-row">
        <div style={{ flex: 1 }}>
          <div className="switch-label">默认终端类型</div>
          <div className="switch-sub">不填则使用当前浏览器 UA；影响导出命令的 shell 语法适配（curl/aria2 等），下载 UA 保持网盘客户端 UA 不变</div>
          <select
            className="input"
            style={{ width: 220, marginTop: 6, padding: '6px 10px' }}
            value={prefs.defaultTerminal}
            onChange={(e) => onChange({ defaultTerminal: e.target.value })}
          >
            <option value="">不填（使用当前浏览器 UA）</option>
            <option value="cmd">Microsoft Windows 命令提示符</option>
            <option value="powershell">Microsoft Windows PowerShell</option>
            <option value="linux-terminal">Linux 终端</option>
            <option value="linux-shell">Linux Shell</option>
            <option value="macos-terminal">Apple MacOS 终端</option>
          </select>
        </div>
      </div>
      <div className="switch-row">
        <div>
          <div className="switch-label">RestoreCollapsedStatus</div>
          <div className="switch-sub">复用期间内恢复上次折叠状态（丢弃 / 恢复 / 每次询问，默认每次询问）</div>
          <select
            className="input"
            style={{ width: 140, marginTop: 6, padding: '6px 10px' }}
            value={prefs.restoreCollapsed}
            onChange={(e) => onChange({ restoreCollapsed: e.target.value as 'discard' | 'restore' | 'ask' })}
          >
            <option value="discard">丢弃</option>
            <option value="restore">恢复</option>
            <option value="ask">每次询问</option>
          </select>
        </div>
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
