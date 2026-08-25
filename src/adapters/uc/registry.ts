/**
 * UC 适配器注册（docs/STRUCTURE.md：src/adapters/uc/registry.ts，v1.1.6）
 *
 * 组装 uc/ 子目录各能力模块（scanner/selector/jumper/cookies）成完整 PanAdapter，
 * 顶部 src/adapters/registry.ts 从这里 import 注册。新增/调整 UC 云端策略只需改
 * 子目录对应文件，本文件一般不动。
 */
import type { PanAdapter } from '../types';
import { UC_LIMITS, UC_HIDDEN_VOLUMN_TEXT } from './types';
import { ucScanner, buildHiddenVolumnUrl } from './scanner';
import { detect, parseShareId } from './selector';
import { buildJumpUrl, parseJumpUrl } from './jumper';

/** UC 适配器实例（注册进 registry 后即启用，UI 侧无需改动） */
export const ucAdapter: PanAdapter = {
  id: 'uc',
  name: 'UC 网盘',
  limits: UC_LIMITS,
  cookie: {
    key: '__pugs',
    displayName: '__pugs',
    standardLength: 208, // reverse-notes-uc.md §11.4 实测长度，弹窗核对用（v1.1.5）
    missingHint: '如果使用公共代理那么需要设置里重新点一次保存，自建代理请去后端管理面板查看（1.2.0）UC网盘不需要登录态',
  },
  detect,
  parseShareId,
  // v1.1.6：0B 文件夹跳转（风控集群导致目录树拉取失败时的二次获取）
  buildJumpUrl,
  parseJumpUrl,
  // v1.1.7：隐秘参数开发者话术（静态资源）
  hiddenVolumn: { title: '该功能仅限开发者食用！！', body: UC_HIDDEN_VOLUMN_TEXT },
  // v1.1.7：隐秘参数查询 URL（与 detail 同参，浏览器直连不走代理）
  buildHiddenVolumnUrl,
  ...ucScanner,
};
