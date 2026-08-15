/**
 * 默认足迹保留（docs/STRUCTURE.md：src/components/settings/FootprintOpts.tsx）
 * 对应 HANDOFF 附件 §3：仅保留在本地，从未离开设备；支持一键清空。
 */
import type { JSX } from 'react';
import type { FootprintPrefs } from '../../core/types';
import { clearLinks } from '../../core/footprint/links';
import { clearTrees } from '../../core/footprint/trees';
import { clearRecords } from '../../core/footprint/records';
import { clearLogs } from '../../core/footprint/logs';
import { useToast } from '../Toast';
import { Switch } from './UacTable';

export interface FootprintOptsProps {
  footprint: FootprintPrefs;
  onChange: (patch: Partial<FootprintPrefs>) => void;
}

export function FootprintOpts({ footprint, onChange }: FootprintOptsProps): JSX.Element {
  const { toast } = useToast();

  const clearAll = (): void => {
    void clearLinks()
      .then(() => clearTrees())
      .then(() => clearRecords()) // 1.1：补上解析记录（旧版漏清，导致设置里"清除足迹"看似没用）
      .then(() => clearLogs())
      .then(() => toast('足迹已清空', 'success'));
  };

  return (
    <div className="settings-section">
      <div className="settings-section-title">默认足迹保留（仅本地）</div>
      <div className="switch-row">
        <div>
          <div className="switch-label">已填入的链接（查重/历史）</div>
          <div className="switch-sub">明文存储 + 时间，用于查重</div>
        </div>
        <Switch on={footprint.keepLinks} onChange={(v) => onChange({ keepLinks: v })} />
      </div>
      <div className="switch-row">
        <div>
          <div className="switch-label">自动获取的目录树（md 导出）</div>
          <div className="switch-sub">快照按分享 ID 覆盖</div>
        </div>
        <Switch on={footprint.keepTrees} onChange={(v) => onChange({ keepTrees: v })} />
      </div>
      <div className="switch-row">
        <div>
          <div className="switch-label">解析记录在目录树呈现（斜体）</div>
          <div className="switch-sub">记录时间 / 次数 / 是否成功</div>
        </div>
        <Switch on={footprint.recordInTree} onChange={(v) => onChange({ recordInTree: v })} />
      </div>
      <div className="switch-row">
        <div>
          <div className="switch-label">完整解析日志</div>
          <div className="switch-sub">Cookie 自动删除线脱敏</div>
        </div>
        <Switch on={footprint.keepLogs} onChange={(v) => onChange({ keepLogs: v })} />
      </div>
      <div className="switch-row">
        <div className="switch-label">日志等级</div>
        <select
          className="input"
          style={{ width: 110, padding: '6px 10px' }}
          value={footprint.logLevel}
          onChange={(e) => onChange({ logLevel: e.target.value as FootprintPrefs['logLevel'] })}
        >
          <option value="fatal">fatal</option>
          <option value="info">info</option>
          <option value="debug">debug</option>
        </select>
      </div>
      <div className="switch-row">
        <div>
          <div className="switch-label">链接/树快照保留条数</div>
          <div className="switch-sub">默认 100</div>
        </div>
        <input
          className="input"
          type="number"
          min={10}
          max={1000}
          style={{ width: 90, padding: '6px 10px' }}
          value={footprint.linkLimit}
          onChange={(e) => onChange({ linkLimit: Math.max(10, Number(e.target.value) || 100) })}
        />
      </div>
      <div className="switch-row">
        <div>
          <div className="switch-label">日志最大体积（MB）</div>
          <div className="switch-sub">超限轮转删最旧，默认 5</div>
        </div>
        <input
          className="input"
          type="number"
          min={1}
          max={100}
          style={{ width: 90, padding: '6px 10px' }}
          value={footprint.logMaxMB}
          onChange={(e) => onChange({ logMaxMB: Math.max(1, Number(e.target.value) || 5) })}
        />
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 10 }}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={clearAll}>
          清空全部足迹
        </button>
      </div>
    </div>
  );
}
