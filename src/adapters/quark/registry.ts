/**
 * 夸克适配器注册（docs/STRUCTURE.md：src/adapters/quark/registry.ts，v1.1.9）
 *
 * 组装 quark/ 子目录各能力模块（scanner/selector/jumper/cookies）成完整 PanAdapter，
 * 顶部 src/adapters/registry.ts 从这里 import 注册。
 */
import type { PanAdapter } from '../types';
import { QUARK_LIMITS, QUARK_HIDDEN_VOLUMN_TEXT } from './types';
import { quarkScanner, buildHiddenVolumnUrl } from './scanner';
import { detect, parseShareId } from './selector';
import { buildJumpUrl, parseJumpUrl } from './jumper';
import { QUARK_COOKIE_KEYS } from './cookies';

/** 夸克适配器实例（注册进 registry 后即启用，UI 侧按接口驱动） */
export const quarkAdapter: PanAdapter = {
  id: 'quark',
  name: '夸克网盘',
  limits: QUARK_LIMITS,
  // 下载层 __pugs：与 UC 同一机制（响应 Set-Cookie，代理 x-pugs 回传）
  cookie: {
    key: '__pugs',
    displayName: '__pugs',
    standardLength: 208, // 与 UC 同款长度，弹窗核对用（v1.1.5）
    missingHint: '50MB以上文件需要填入登录态cookie，__pugs是真实浏览器校验，不包含登录态，当前代理未传入该信息。',
  },
  // 登录态 cookie 输入规格（v1.1.9.1：整串粘贴/导入为主；真实 key 是 __pus/__uid/__puus）
  cookieInput: {
    wholeString: true,
    keys: QUARK_COOKIE_KEYS.map((k) => ({ key: k, label: k })),
    notice:
      '以上被标记的选项属于登录态的 cookie，如果你正在使用公用代理（比如 cloudflare）请自行承担账号安全问题',
    missingHint:
      '如果你在使用自建代理却没有显示，请检查和账号状态和自建代理面板登录状态否正常，其他问题参阅文档',
  },
  detect,
  parseShareId,
  // v1.1.9：0B 文件夹跳转（与 UC 同机制）
  buildJumpUrl,
  parseJumpUrl,
  // v1.1.7 同款：隐秘参数开发者话术（静态资源）
  hiddenVolumn: { title: '该功能仅限开发者食用！！', body: QUARK_HIDDEN_VOLUMN_TEXT },
  // v1.1.7 同款：隐秘参数查询 URL（与 detail 同参，浏览器直连不走代理）
  buildHiddenVolumnUrl,
  ...quarkScanner,
};
