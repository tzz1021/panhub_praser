/**
 * 足迹：已填链接（docs/STRUCTURE.md：src/core/footprint/links.ts）
 *
 * 用途：输入框查重 + 历史下拉（LinkInput）；明文存储 + 时间（HANDOFF 附件 §3.1）。
 * 规则：按 url 去重；重复填入只刷新 lastUsedAt 且 useCount+1；列表按最近使用倒序（索引 lastUsedAt）。
 */
import type { LinkRecord } from '../types';
import { STORE_LINKS, dbClear, dbDelete, dbGet, dbGetAllByIndex, dbPut, getDb } from './db';

/**
 * 新增/刷新一条已填链接（按 url 查重）：
 * - 不存在：记录 addedAt/lastUsedAt = 当前时间，useCount = 1
 * - 已存在：保留 addedAt 与 note，刷新 adapterId/shareId/lastUsedAt，useCount + 1
 */
export async function addLink(rec: Omit<LinkRecord, 'addedAt' | 'lastUsedAt' | 'useCount'>): Promise<void> {
  const db = await getDb();
  const existing = await dbGet<LinkRecord>(db, STORE_LINKS, rec.url);
  const now = Date.now();
  const record: LinkRecord = existing
    ? { ...existing, adapterId: rec.adapterId, shareId: rec.shareId, lastUsedAt: now, useCount: existing.useCount + 1 }
    : { ...rec, addedAt: now, lastUsedAt: now, useCount: 1 };
  await dbPut(db, STORE_LINKS, record);
}

/** 修改备注（1.0.1 历史页；记录不存在时忽略） */
export async function updateLinkNote(url: string, note: string): Promise<void> {
  const db = await getDb();
  const existing = await dbGet<LinkRecord>(db, STORE_LINKS, url);
  if (!existing) return;
  await dbPut(db, STORE_LINKS, { ...existing, note });
}

/** 历史链接列表（lastUsedAt 倒序；limit 默认 100，与足迹偏好 linkLimit 默认一致） */
export function listLinks(limit = 100): Promise<LinkRecord[]> {
  return getDb().then((db) =>
    dbGetAllByIndex<LinkRecord>(db, STORE_LINKS, 'lastUsedAt', { direction: 'prev', limit }),
  );
}

/** 删除单条历史链接 */
export async function removeLink(url: string): Promise<void> {
  const db = await getDb();
  await dbDelete(db, STORE_LINKS, url);
}

/** 清空历史链接 */
export async function clearLinks(): Promise<void> {
  const db = await getDb();
  await dbClear(db, STORE_LINKS);
}
