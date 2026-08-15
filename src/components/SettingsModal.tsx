/**
 * 偏好设置弹窗（HANDOFF 附件：UAC 表 / 默认方式 / 足迹 三块）
 * 修改即存（localStorage，core/preferences.ts）。
 */
import { useState } from 'react';
import type { JSX } from 'react';
import { getPreferences, resetPreferences, setPreferences } from '../core/preferences';
import type { Preferences } from '../core/types';
import { useToast } from './Toast';
import { UacTable } from './settings/UacTable';
import { DefaultMode } from './settings/DefaultMode';
import { FootprintOpts } from './settings/FootprintOpts';

export interface SettingsModalProps {
  onClose: () => void;
}

export function SettingsModal({ onClose }: SettingsModalProps): JSX.Element {
  const [prefs, setPrefs] = useState<Preferences>(() => getPreferences());
  const { toast } = useToast();

  const apply = (patch: Partial<Preferences>): void => {
    setPrefs((prev) => {
      const next = setPreferences(patch);
      return { ...prev, ...next };
    });
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <div className="modal-head">
          <h3 className="modal-title">偏好设置</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <UacTable
            modals={prefs.modals}
            onModalsChange={(patch) => apply({ modals: { ...prefs.modals, ...patch } })}
            transport={prefs.transport}
            onTransportChange={(patch) => apply({ transport: { ...prefs.transport, ...patch } })}
          />
          <DefaultMode prefs={prefs} onChange={apply} />
          <FootprintOpts footprint={prefs.footprint} onChange={(patch) => apply({ footprint: { ...prefs.footprint, ...patch } })} />
        </div>
        <div className="modal-foot">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              resetPreferences();
              setPrefs(getPreferences());
              toast('已恢复默认设置', 'success');
            }}
          >
            恢复默认
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
