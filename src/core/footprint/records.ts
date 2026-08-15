/**
 * 足迹：解析记录（docs/STRUCTURE.md：src/core/footprint/records.ts）
 *
 * 用途：在目录树呈现解析历史（时间/次数/是否成功，默认斜体，见 HANDOFF 附件 §3.3）。
 * 查询按 shareId 过滤 + parsedAt 倒序（走索引）。
 */
import type { ParseRecord } from '../types';
import { STORE_RECORDS, dbAdd, dbClear, dbDeleteBatch, dbGetAll, dbGetAllByIndex, getDb } from './db';

/** 新增一条解析记录，返回自增主键 id */
export async function addRecord(rec: Omit<ParseRecord, 'id'>): Promise<number> {
  const db = await getDb();
  const key = await dbAdd(db, STORE_RECORDS, rec);
  return Number(key);
}

/** 某分享的全部解析记录（parsedAt 倒序，最新在前） */
export async function listRecords(shareId: string): Promise<ParseRecord[]> {
  const db = await getDb();
  const all = await dbGetAllByIndex<ParseRecord>(db, STORE_RECORDS, 'parsedAt', { direction: 'prev' });
  return all.filter((r) => r.shareId === shareId);
}

/** 全部解析记录（parsedAt 倒序；历史页时间轴数据源，1.0.1） */
export async function listAllRecords(limit = 500): Promise<ParseRecord[]> {
  const db = await getDb();
  const all = await dbGetAllByIndex<ParseRecord>(db, STORE_RECORDS, 'parsedAt', { direction: 'prev', limit });
  return all;
}

/** 删除某分享的全部解析记录（历史页"删除链接"连带清理，1.1） */
export async function removeRecordsByShareId(shareId: string): Promise<void> {
  const db = await getDb();
  const all = await dbGetAll<ParseRecord>(db, STORE_RECORDS);
  const ids = all.filter((r) => r.shareId === shareId).map((r) => r.id as number);
  if (ids.length > 0) {
    await dbDeleteBatch(db, STORE_RECORDS, ids);
  }
}

/** 删除全部解析记录（历史页"删除全部"，1.1） */
export async function clearRecords(): Promise<void> {
  const db = await getDb();
  await dbClear(db, STORE_RECORDS);
}

/** 某分享的解析次数 */
export async function countRecords(shareId: string): Promise<number> {
  const rows = await listRecords(shareId);
  return rows.length;
}
