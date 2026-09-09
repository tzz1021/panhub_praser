/**
 * 阿里云盘链接识别（docs/STRUCTURE.md：src/adapters/alipan/selector.ts，v1.2.x）
 *
 * 负责辨认 alipan 分享链接（双域：www.alipan.com / 旧域 www.aliyundrive.com）：
 * - 短链接（分享根）：`https://www.alipan.com/s/<share_id>`
 * - 长链接（深链文件夹）：`https://www.alipan.com/s/<share_id>/folder/<folder_file_id>`
 *   （web 端打开分享内某文件夹时的地址栏形态；folder 段是纯 fid，不带名字）
 *
 * 与 jumper.ts 的分工：selector 只做"识别/取分享 ID"；jumper 做深链的构建与解析（fid 链提取）。
 */
import { SHARE_URL_RE } from './types';

/** 短链接：s/<shareId> 结尾（$ 锚定，排除 /folder/ 深链后缀） */
const SHORT_URL_RE =
  /^https?:\/\/(?:[a-z0-9-]+\.)*(?:alipan|aliyundrive)\.com\/s\/[A-Za-z0-9_-]+$/i;

/** 长链接（深链文件夹）：.../s/<shareId>/folder/<fid> */
export const LONG_URL_RE =
  /^https?:\/\/(?:[a-z0-9-]+\.)*(?:alipan|aliyundrive)\.com\/s\/([A-Za-z0-9_-]+)\/folder\//i;

/** 是否为深链文件夹长链接 */
export function isLongJumpUrl(url: string): boolean {
  return LONG_URL_RE.test(url);
}

/** 是否为普通短链接 */
export function isShortUrl(url: string): boolean {
  return SHORT_URL_RE.test(url);
}

/** 该链接是否属于阿里云盘（短链接或深链均可识别） */
export function detect(url: string): boolean {
  return isLongJumpUrl(url) || isShortUrl(url);
}

/** 提取分享 ID（两种链接都取 `s/<id>` 段）；无法识别返回 null */
export function parseShareId(url: string): string | null {
  return SHARE_URL_RE.exec(url)?.[1] ?? null;
}
