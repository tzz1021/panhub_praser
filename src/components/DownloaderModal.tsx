/**
 * 连接本地下载器弹窗（布局参考 pdpb.cn 图二）
 *
 * v1 只保存配置：下载器类型 / RPC 地址 / RPC 密钥 / 本地保存路径，
 * 导出任务时带入保存路径；RPC 直推任务留 v1.1。
 */
import { useState } from 'react';
import type { JSX } from 'react';
import {
  DOWNLOADER_PRESETS,
  loadDownloaderConfig,
  saveDownloaderConfig,
  testDownloaderConnection,
} from '../utils/downloader';
import type { DownloaderConfig, DownloaderType } from '../utils/downloader';
import { useToast } from './Toast';

export interface DownloaderModalProps {
  onClose: () => void;
}

export function DownloaderModal({ onClose }: DownloaderModalProps): JSX.Element {
  const [cfg, setCfg] = useState<DownloaderConfig>(() => loadDownloaderConfig());
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const { toast } = useToast();

  const pickType = (type: DownloaderType): void => {
    setCfg((prev) => ({ ...prev, type, rpc: DOWNLOADER_PRESETS[type].rpc }));
  };

  const save = (): void => {
    saveDownloaderConfig(cfg);
    toast('下载器配置已保存', 'success');
    onClose();
  };

  // v1.1.8：测试连接（aria2.getVersion / Gopeed /api/v1/info），结果内联展示 + toast
  const testConnection = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    const r = await testDownloaderConnection(cfg);
    setTesting(false);
    setTestResult(r);
    toast(r.message, r.ok ? 'success' : 'error');
  };

  const preset = DOWNLOADER_PRESETS[cfg.type];

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 className="modal-title">连接本地下载器</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="field">
            <span className="field-label">下载器类型</span>
            <div className="segment">
              {(Object.keys(DOWNLOADER_PRESETS) as DownloaderType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={cfg.type === t ? 'active' : ''}
                  onClick={() => pickType(t)}
                >
                  {DOWNLOADER_PRESETS[t].label}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span className="field-label">RPC 地址</span>
            <input
              className="input"
              value={cfg.rpc}
              onChange={(e) => setCfg((p) => ({ ...p, rpc: e.target.value }))}
              spellCheck={false}
            />
          </div>
          <div className="field">
            <span className="field-label">RPC 密钥（可选）</span>
            <input
              className="input"
              placeholder="如果未设置可留空"
              value={cfg.secret}
              onChange={(e) => setCfg((p) => ({ ...p, secret: e.target.value }))}
              spellCheck={false}
            />
          </div>
          <div className="field">
            <span className="field-label">本地下载保存路径</span>
            <input
              className="input"
              placeholder="例如 D:\Downloads\网盘 或 /Users/用户名/Downloads/网盘"
              value={cfg.savePath}
              onChange={(e) => setCfg((p) => ({ ...p, savePath: e.target.value }))}
              spellCheck={false}
            />
            <span className="field-hint">可选，不填则使用下载器默认保存位置</span>
          </div>
          <div className="field-hint" style={{ background: '#f8fafc', borderRadius: 10, padding: '8px 12px' }}>
            {preset.hint}
          </div>
          {testResult && (
            <div
              className="field-hint"
              style={{
                borderRadius: 10,
                padding: '8px 12px',
                background: testResult.ok ? '#ecfdf5' : '#fef2f2',
                color: testResult.ok ? 'var(--green, #059669)' : 'var(--red, #dc2626)',
                whiteSpace: 'pre-wrap',
              }}
            >
              {testResult.message}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => void testConnection()} disabled={testing}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button type="button" className="btn btn-primary" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
