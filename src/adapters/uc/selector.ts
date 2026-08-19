/**
 * UC 链接识别（docs/STRUCTURE.md：src/adapters/uc/selector.ts，v1.1.6）
 *
 * 负责辨认长链接 / 短链接（HomePage 输入框"聪明一点"的落点）：
 * - 短链接：`https://drive.uc.cn/s/xxxx` 结尾就是分享 ID，没有跳转后缀
 * - 长链接（跳转链接）：`https://drive.uc.cn/s/xxxx#/list/share/fid-name/...`
 *   末尾带连字符（fid-name 段），可定位到分享内的某个文件夹
 *
 * 与 jumper.ts 的分工：selector 只做"识别/取分享 ID"；jumper 做跳转链接的
 * 构建与解析（含 fid 链提取）。
 */
import { SHARE_URL_RE } from './types';

/** 短链接：s|share/<shareId> 结尾（$ 锚定，排除跳转后缀） */
const SHORT_URL_RE = /^https?:\/\/(?:[a-z0-9-]+\.)*uc\.cn\/(?:s|share)\/[A-Za-z0-9_-]+$/i;

/** 长链接（跳转链接）：.../s/<shareId>#/list/share/<fid-name>/... */
export const LONG_URL_RE =
  /^https?:\/\/(?:[a-z0-9-]+\.)*uc\.cn\/(?:s|share)\/([A-Za-z0-9_-]+)#\/list\/share\//i;

/** 是否为跳转链接（长链接）：末尾带有 fid-name 连字符段 */
export function isLongJumpUrl(url: string): boolean {
  return LONG_URL_RE.test(url);
}

/** 是否为普通短链接 */
export function isShortUrl(url: string): boolean {
  return SHORT_URL_RE.test(url);
}

/** 该链接是否属于 UC（短链接或长链接均可识别） */
export function detect(url: string): boolean {
  return isLongJumpUrl(url) || isShortUrl(url);
}

/** 提取分享 ID（两种链接都取 `s|share/<id>` 段）；无法识别返回 null */
export function parseShareId(url: string): string | null {
  return SHARE_URL_RE.exec(url)?.[1] ?? null;
}
