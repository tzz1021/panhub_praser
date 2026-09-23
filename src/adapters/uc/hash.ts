/**
 * UC 网盘 md5 归一化（docs/STRUCTURE.md：src/adapters/uc/hash.ts）
 *
 * 背景（真实抓包）：UC 的 `share/sharepage/detail`（列表/detail 路径，字段在 list[]）
 * 与 `file/download`（下载路径）**都**会带 `md5`，但形态不统一：
 *   1. base64 形态（16 字节摘要的 base64，24 字符、带 `==`）：
 *      "75zWrXnoh/KB14803+wkJg==" → hex "ef9cd6ad79e887f281d78f34dfec2426"
 *   2. 直给 hex 形态（32 字符）："83d2a9cbc42d9fd82fdd4fc96f8b3b33" → 原样小写
 *
 * 本模块把两种形态统一成 **32 位小写 hex**，供：
 * - scanner#getDownloadLinks → DownloadResult.hash（与 quark/alipan 同契约）
 * - scanner#toShareFile → ShareFile.md5（「校验和」列离线可见）
 *
 * 纯函数 / 零依赖 / 浏览器与 node 通用：base64 解码自实现（不用 atob，也不用 Buffer —
 * 本文件属于 src/ 浏览器代码，且自实现便于单测在 node 下直接跑）。
 *
 * 「无法判定」时的选择（任务要求写明理由）：
 * - 空串 / 全空白 → `undefined`（没有值 = 无校验和，导出侧跳过注释行，UI 显示占位符）
 * - 非空但不认识（长度不是 24/22/32、base64 解不出 16 字节）→ **原样透传**（trim 后的原值）
 *   理由：上游字段含义可能随云端策略变动，透传保留可观测性（出了问题能看到真值），
 *   且不阻断解析；归一化函数只做「识别 + 转码」，绝不对上游字段做删除。
 * - 任何输入都不抛错（含 null/undefined/非字符串），调用方无需 try/catch。
 */

/** 标准 base64 字母表（+ / 形态） */
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 字符码 → 6bit 值 的查表（-1 = 非法字符） */
const B64_LOOKUP: Int16Array = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i += 1) {
    table[B64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/**
 * 宽松 base64 → 字节数组；失败返回 null。
 * - 容忍 url-safe 字母表的 `-`/`_`（归一成 `+`/`/`）
 * - 容忍缺失的 `=` 补齐（长度 % 4 === 2/3 时自动补；=== 1 视为非法）
 * - 非法字符 → null（不抛错）
 */
function base64ToBytes(raw: string): Uint8Array | null {
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const remainder = normalized.length % 4;
  if (remainder === 1) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i);
    const value = code < 128 ? B64_LOOKUP[code] : -1;
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  // 残余位必须是零填充（严格解码：避免把任意 22/24 字符串误判成摘要）
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(bytes);
}

/** 字节数组 → 小写 hex */
function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

/** 32 位纯 hex 判定（md5 摘要的标准形态） */
const HEX32_RE = /^[0-9a-f]{32}$/i;

/**
 * UC `md5` 字段 → 32 位小写 hex。
 *
 * - base64 形态（解码后恰好 16 字节；官方为 24 字符「xx==」，也接受无 padding 的 22 字符）
 *   → hex 小写
 * - 32 位 hex → 原样小写
 * - 空/未知形态 → 见文件头「无法判定」说明（空 = undefined，未知 = 原样透传）
 *
 * @example
 * normalizeUcMd5('75zWrXnoh/KB14803+wkJg==') // 'ef9cd6ad79e887f281d78f34dfec2426'
 * normalizeUcMd5('83D2A9CBC42D9FD82FDD4FC96F8B3B33') // '83d2a9cbc42d9fd82fdd4fc96f8b3b33'
 * normalizeUcMd5('')  // undefined
 */
export function normalizeUcMd5(raw?: string): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  // 1) 直给 hex：原样（仅大小写归一）
  if (HEX32_RE.test(value)) return value.toLowerCase();
  // 2) base64 形态：24 字符（带 padding）或 22 字符（无 padding）= 16 字节
  if (value.length === 24 || value.length === 22) {
    const bytes = base64ToBytes(value);
    if (bytes && bytes.length === 16) return bytesToHex(bytes);
  }
  // 3) 未知形态：原样透传（保留可观测性，不抛错、不删除上游数据）
  return value;
}

/**
 * 是否为「可用的 md5」（32 位小写 hex）——供调用方按需判断，避免把透传值当摘要用。
 * 归一化结果若是未知形态透传值，这里返回 false。
 */
export function isHexMd5(value?: string): boolean {
  return typeof value === 'string' && HEX32_RE.test(value);
}
