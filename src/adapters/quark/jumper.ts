/**
 * 夸克跳转文件夹链接（docs/STRUCTURE.md：src/adapters/quark/jumper.ts，v1.1.9）
 *
 * 与 UC 同机制（v1.1.6）：把文件夹的 fid 链拼成跳转链接（与分享页地址栏一致），
 * 风控集群导致目录树拉取失败时用它二次获取该目录。
 *
 * 模板：`pan.quark.cn/s/<shareId>#/list/share/<fid>-<file_name>/<fid>-<file_name>/...`
 * fid 提取规则：每段取**第一个连字符之前**的部分（防止目录 file_name 里含连字符）。
 */
import { LONG_URL_RE } from './selector';

/** 跳转链接片段（fid + 展示名） */
export interface JumpSegment {
  /** 文件夹唯一标识符（夸克 = fid） */
  fid: string;
  /** 文件夹名（解码后，用于日志/路径展示） */
  name: string;
}

/** 跳转链接前缀（分享页地址栏格式） */
const JUMP_PREFIX = '#/list/share/';

/** 构建跳转链接：shareId + fid 链 → 分享页可导航的长链接 */
export function buildJumpUrl(shareId: string, segments: JumpSegment[]): string {
  const chain = segments.map((s) => `${s.fid}-${encodeURIComponent(s.name)}`).join('/');
  return `https://pan.quark.cn/s/${shareId}${JUMP_PREFIX}${chain}`;
}

/** 解析跳转链接 → { shareId, segments }；不是跳转链接返回 null */
export function parseJumpUrl(url: string): { shareId: string; segments: JumpSegment[] } | null {
  const m = LONG_URL_RE.exec(url);
  if (!m) return null;
  const shareId = m[1];
  const idx = url.indexOf(JUMP_PREFIX);
  if (idx < 0) return null;
  const raw = url.slice(idx + JUMP_PREFIX.length);
  const segments = raw
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      // fid 取第一个连字符之前（目录名可能含连字符）
      const dash = seg.indexOf('-');
      const fid = dash > 0 ? seg.slice(0, dash) : seg;
      const rawName = dash > 0 ? seg.slice(dash + 1) : '';
      let name = rawName;
      try {
        name = decodeURIComponent(rawName);
      } catch {
        /* 非合法编码时保留原文 */
      }
      return { fid, name };
    });
  if (segments.length === 0) return null;
  return { shareId, segments };
}

/** 取跳转链接的目标文件夹 fid（最后一级）；非跳转链接返回 null */
export function pdirFidOf(url: string): string | null {
  const parsed = parseJumpUrl(url);
  if (!parsed) return null;
  return parsed.segments[parsed.segments.length - 1].fid;
}
