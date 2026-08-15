/**
 * 本地下载器连接配置（连接本地下载器弹窗的存储层，v1 只存配置）
 *
 * 用途：导出任务时带入保存路径/RPC 密钥；v1.1 再实现 RPC 直推（aria2.addUri 等）。
 * 存储：localStorage 'panhub:downloader:v1'，不涉及任何凭据敏感信息。
 */
export type DownloaderType = 'aria2' | 'motrix' | 'gopeed';

export interface DownloaderConfig {
  /** 下载器类型 */
  type: DownloaderType;
  /** RPC 地址 */
  rpc: string;
  /** RPC 密钥（可选） */
  secret: string;
  /** 本地保存路径（可选，不填用下载器默认） */
  savePath: string;
}

/** 各类型默认 RPC 地址与说明（参考 pdpb.cn 弹窗 hint） */
export const DOWNLOADER_PRESETS: Record<
  DownloaderType,
  { label: string; rpc: string; hint: string }
> = {
  aria2: {
    label: 'Aria2',
    rpc: 'http://127.0.0.1:6800/jsonrpc',
    hint: 'Aria2：6800，需开启 RPC（--enable-rpc）',
  },
  motrix: {
    label: 'Motrix',
    rpc: 'http://127.0.0.1:16800/jsonrpc',
    hint: 'Motrix：16800（Motrix 内置 aria2 内核）',
  },
  gopeed: {
    label: 'Gopeed',
    rpc: 'http://127.0.0.1:9999/api/v1/tasks',
    hint: 'Gopeed：127.0.0.1:9999，需在 Gopeed 设置-高级开启 API',
  },
};

const KEY = 'panhub:downloader:v1';

/** 默认配置（aria2，本地默认 RPC） */
export function defaultDownloaderConfig(): DownloaderConfig {
  return { type: 'aria2', rpc: DOWNLOADER_PRESETS.aria2.rpc, secret: '', savePath: '' };
}

/** 读取配置；损坏/缺失回退默认 */
export function loadDownloaderConfig(): DownloaderConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultDownloaderConfig();
    const parsed = JSON.parse(raw) as Partial<DownloaderConfig>;
    const preset = DOWNLOADER_PRESETS[parsed.type ?? 'aria2'];
    return {
      type: parsed.type ?? 'aria2',
      rpc: parsed.rpc || preset.rpc,
      secret: parsed.secret ?? '',
      savePath: parsed.savePath ?? '',
    };
  } catch {
    return defaultDownloaderConfig();
  }
}

/** 保存配置 */
export function saveDownloaderConfig(cfg: DownloaderConfig): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cfg));
  } catch {
    // 配额异常静默（配置丢失不影响主流程）
  }
}
