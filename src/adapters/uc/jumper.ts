/**
 * UC 跳转文件夹链接（docs/STRUCTURE.md：src/adapters/uc/jumper.ts，v1.1.6）
 *
 * 背景：游客态批量 scanner 容易被风控，风控会"集群"出现（集中到一整个二级目录），
 * 表现为该目录树拉取失败 → 伪装的"空文件夹"（0B，children=undefined）。
 * 解法：把文件夹的 fid 链拼成跳转链接（与分享页地址栏一致），二次获取该目录。
 *
 * 模板：`drive.uc.cn/s/<shareId>#/list/share/<fid>-<file_name>/<fid>-<file_name>/...`
 * 例：https://drive.uc.cn/s/6be56958dc134#/list/share/87e3320b7983491da6b2560a0e84e606-Adobe%E8%BD%AF%E4%BB%B6%E5%90%88%E9%9B%86%E5%A4%A7%E5%85%A8/2f7d688b9a26435e888212bb435f064b-win
 *
 * fid 提取规则：每段取**第一个连字符之前**的部分（防止目录 file_name 里含连字符），
 * 即长 URL 最后一级第一个连字符向左到斜线之间的东西 = 该目录的 pdir_fid。
 */
import { LONG_URL_RE } from './selector';

/** 跳转链接片段（fid + 展示名） */
export interface JumpSegment {
  /** 文件夹唯一标识符（UC = fid） */
  fid: string;
  /** 文件夹名（解码后，用于日志/路径展示） */
  name: string;
}

/** 跳转链接前缀（分享页地址栏格式） */
const JUMP_PREFIX = '#/list/share/';

/** 构建跳转链接：shareId + fid 链 → 分享页可导航的长链接 */
export function buildJumpUrl(shareId: string, segments: JumpSegment[]): string {
  const chain = segments.map((s) => `${s.fid}-${encodeURIComponent(s.name)}`).join('/');
  return `https://drive.uc.cn/s/${shareId}${JUMP_PREFIX}${chain}`;
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
