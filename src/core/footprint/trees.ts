/**
 * 足迹：目录树快照（docs/STRUCTURE.md：src/core/footprint/trees.ts）
 *
 * 用途：目录树 md 导出（tasks/export.ts 用）；同 shareId 覆盖保存（keyPath 保证）。
 * 列表按 savedAt 倒序（快照量小，直接全量读取后内存排序）。
 */
import type { TreeSnapshot } from '../types';
import { STORE_TREES, dbClear, dbDelete, dbGet, dbGetAll, dbPut, getDb } from './db';

/** 保存目录树快照（同 shareId 覆盖旧快照） */
export async function saveTree(snap: TreeSnapshot): Promise<void> {
  const db = await getDb();
  await dbPut(db, STORE_TREES, snap);
}

/** 读取单个快照（不存在返回 undefined） */
export function getTree(shareId: string): Promise<TreeSnapshot | undefined> {
  return getDb().then((db) => dbGet<TreeSnapshot>(db, STORE_TREES, shareId));
}

/** 快照列表（savedAt 倒序；limit 默认 100） */
export async function listTrees(limit = 100): Promise<TreeSnapshot[]> {
  const db = await getDb();
  const all = await dbGetAll<TreeSnapshot>(db, STORE_TREES);
  return all.sort((a, b) => b.savedAt - a.savedAt).slice(0, limit);
}

/** 删除单个快照 */
export async function removeTree(shareId: string): Promise<void> {
  const db = await getDb();
  await dbDelete(db, STORE_TREES, shareId);
}

/** 清空全部快照 */
export async function clearTrees(): Promise<void> {
  const db = await getDb();
  await dbClear(db, STORE_TREES);
}
