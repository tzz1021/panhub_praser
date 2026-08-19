/**
 * UC 适配器注册（docs/STRUCTURE.md：src/adapters/uc/registry.ts，v1.1.6）
 *
 * 组装 uc/ 子目录各能力模块（scanner/selector/jumper/cookies）成完整 PanAdapter，
 * 顶部 src/adapters/registry.ts 从这里 import 注册。新增/调整 UC 云端策略只需改
 * 子目录对应文件，本文件一般不动。
 */
import type { PanAdapter } from '../types';
import { UC_LIMITS } from './types';
import { ucScanner } from './scanner';
import { detect, parseShareId } from './selector';
import { buildJumpUrl, parseJumpUrl } from './jumper';

/** UC 适配器实例（注册进 registry 后即启用，UI 侧无需改动） */
export const ucAdapter: PanAdapter = {
  id: 'uc',
  name: 'UC 网盘',
  limits: UC_LIMITS,
  cookie: {
    key: '__pugs',
    displayName: '双下划线pugs',
    standardLength: 208, // reverse-notes-uc.md §11.4 实测长度，弹窗核对用（v1.1.5）
    missingHint: '没有请检查你的杂鱼浏览器是不是开启了cookie存储限制或者无痕模式，开发者请检查插件比如AdGuard可能会拦截标签页开启',
  },
  detect,
  parseShareId,
  // v1.1.6：0B 文件夹跳转（风控集群导致目录树拉取失败时的二次获取）
  buildJumpUrl,
  parseJumpUrl,
  ...ucScanner,
};
