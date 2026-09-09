/**
 * 阿里云盘深链文件夹链接（docs/STRUCTURE.md：src/adapters/alipan/jumper.ts，v1.2.x）
 *
 * 与 uc/quark 同机制：把分享内某个文件夹的 fid 拼成深链 URL（= web 端地址栏形态），
 * 目录树拉取失败时用它二次获取该目录（0B 文件夹跳转）。
 *
 * 模板：`www.alipan.com/s/<shareId>/folder/<fid>`
 * 与 quark 的差异：alipan 深链的 folder 段是**纯 fid、不带名字**（web 地址栏即如此），
 * 因此解析出的 segment.name 为空串 —— 跳转重扫时根节点显示名会缺失（已知小瑕疵，
 * 需 get_by_share 补名才算完整，见交付摘要待验证/开放问题）。
 */
import { LONG_URL_RE } from './selector';

/** 跳转链接片段（fid + 展示名；alipan 深链无名字，name 恒为空串） */
export interface JumpSegment {
  /** 文件夹唯一标识符（alipan = 分享内 file_id） */
  fid: string;
  /** 文件夹名（解码后，用于日志/路径展示；alipan 深链不带名字） */
  name: string;
}

/** 深链前缀（web 端地址栏格式） */
const JUMP_PREFIX = '/folder/';

/** 构建深链 URL：shareId + fid 链 → 可导航的分享页长链接（只取链尾 fid，链条中间段 alipan 不需要） */
export function buildJumpUrl(shareId: string, segments: JumpSegment[]): string {
  const last = segments[segments.length - 1];
  if (!last) return `https://www.alipan.com/s/${shareId}`;
  return `https://www.alipan.com/s/${shareId}${JUMP_PREFIX}${encodeURIComponent(last.fid)}`;
}

/** 解析深链 URL → { shareId, segments }；不是深链返回 null */
export function parseJumpUrl(url: string): { shareId: string; segments: JumpSegment[] } | null {
  const m = LONG_URL_RE.exec(url);
  if (!m) return null;
  const shareId = m[1];
  const idx = url.indexOf(JUMP_PREFIX);
  if (idx < 0) return null;
  const fidRaw = url.slice(idx + JUMP_PREFIX.length).split(/[/?#]/, 1)[0];
  const fid = fidRaw ? decodeURIComponent(fidRaw) : '';
  if (!fid) return null;
  // alipan 深链不带文件夹名（与 quark 的 <fid>-<name> 段不同）
  return { shareId, segments: [{ fid, name: '' }] };
}

/** 取深链目标文件夹 fid（最后一级）；非深链返回 null */
export function pdirFidOf(url: string): string | null {
  const parsed = parseJumpUrl(url);
  if (!parsed) return null;
  return parsed.segments[parsed.segments.length - 1].fid;
}
