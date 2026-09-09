/**
 * 阿里云盘适配器注册（docs/STRUCTURE.md：src/adapters/alipan/registry.ts，v1.2.x 初稿）
 *
 * 组装 alipan/ 子目录各能力模块（scanner/selector/jumper/auth）成完整 PanAdapter，
 * 顶部 src/adapters/registry.ts 从这里 import 注册。
 *
 * 与夸克注册的差异（交付要求）：
 * - 无 cookie（下载层自动捕获凭据）字段：直链 = OSS 预签名 + 固定 Referer，不涉 cookie
 * - cookieInput 存在但语义是「登录态凭据串」（auth=Bearer xxx;to_parent_file_id=…）：
 *   wholeString 模式 + load/save 钩子走 alipan/auth.ts 自己的存储键；
 *   browserCookie: false → 弹窗不展示 get cookies.txt 插件/懒人导入行
 * - 无 sizeThreshold：没有「小文件游客可用」分级，登录态是全部文件的硬前提
 */
import type { PanAdapter } from '../types';
import { ALIPAN_LIMITS } from './types';
import { alipanScanner } from './scanner';
import { detect, parseShareId } from './selector';
import { buildJumpUrl, parseJumpUrl } from './jumper';
import { ALIPAN_AUTH_KEYS, getAlipanAuthString, setAlipanAuthString } from './auth';

/** 阿里云盘适配器实例（注册进 registry 后即启用，UI 侧按接口驱动） */
export const alipanAdapter: PanAdapter = {
  id: 'alipan',
  name: '阿里云盘',
  limits: ALIPAN_LIMITS,
  // 登录态凭据串输入规格（v1.2.x alipan：Bearer token + 转存目标目录，非浏览器 cookie）
  cookieInput: {
    wholeString: true,
    // 整串解析/校验用的关键键（k=v; k2=v2 格式，与夸克整串同风格）
    keys: ALIPAN_AUTH_KEYS.map((k) => ({ key: k, label: k })),
    // v1.2.x：整串存取钩子 —— 弹窗不再硬编码夸克存储键（见 types.ts CookieInputRequirement）
    load: getAlipanAuthString,
    save: setAlipanAuthString,
    // 顶部说明行（覆盖默认“需要 cookie 鉴权…”文案）
    intro:
      '需要鉴权：阿里云盘不支持游客解析，分享文件必须先转存到你的网盘才能取直链。请按下方格式填写登录态凭据（保存后自动重试）：',
    // 大输入框 placeholder（整串示例 + 取指说明）
    wholeStringPlaceholder:
      '粘贴完整凭据串，格式：\nauth=Bearer <登录token>;to_parent_file_id=<转存目标目录 file_id>;user-agent=<可选>;x-device-id=<可选>\n\ntoken 获取：浏览器登录 alipan.com/drive → F12 → Network → 任意请求的 Authorization 头（Bearer 开头的整段）。\nto_parent_file_id：你自己网盘目标文件夹的 file_id（打开该文件夹后地址栏 /drive/file/all/<id> 的 <id>）。',
    // 凭据不是浏览器 cookie → 隐藏 get cookies.txt 插件推荐与懒人导入行
    browserCookie: false,
    notice:
      '凭据串含你的阿里云盘登录态（Bearer token 可把分享文件转存进你的网盘），若在公用代理上使用请自担账号安全风险（凭据只存本浏览器 localStorage）',
    missingHint:
      '解析失败常见原因：auth 过期（回 alipan.com 重新复制）或 to_parent_file_id 不是你自己网盘的目录 file_id。仍失败请查看解析日志',
  },
  detect,
  parseShareId,
  // 深链文件夹跳转（/s/<shareId>/folder/<fid>，web 地址栏形态）
  buildJumpUrl,
  parseJumpUrl,
  ...alipanScanner,
};
