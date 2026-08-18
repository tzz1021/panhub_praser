/**
 * 足迹：直链结果按 fid 复用（docs/STRUCTURE.md：src/core/footprint/prase.ts，v1.1.5.3）
 *
 * 背景：oss 直链此前只在结果页内存态，刷新即丢；proxy 被恶意刷爆后重解析又慢又容易失败。
 * 方案：prase 产物（oss+sig + 同响应 __pugs + 获取时间/终止标记）按 `shareId::fid` 落库，
 * 结果页进入时按 fid 恢复 —— 未过期直链直接可导出，不再请求接口；读不到/过期则正常显示解析按钮。
 *
 * 安全：与足迹其他 store 一样仅本地（IndexedDB）；__pugs 属下载凭据，与直链同响应绑定，
 * 恢复后仍按「每文件注入各自 cookie」逻辑导出（§12）。
 * 清理：保存时顺带清掉该分享下 24h 前的旧条目（直链有效期 3-6h，留 24h 足够）；
 * 刷新资源列表 / 删除链接 / 清空足迹时按分享或全量清除。
 */
import type { LinkEntry } from '../types';
import {
  STORE_PRASE,
  dbClear,
  dbDeleteBatch,
  dbGetAllByIndex,
  dbPut,
  getDb,
} from './db';

/** 直链结果快照（落库形态） */
export interface PraseSnapshot {
  /** 主键 = `${shareId}::${fid}` */
  key: string;
  /** 分享 ID */
  shareId: string;
  /** 网盘文件 ID */
  fid: string;
  ok: boolean;
  /** OSS 签名直链（ok=false 为空串） */
  url: string;
  error?: string;
  /** 获取时间 ms */
  fetchedAt: number;
  /** 与该直链同响应绑定的下载凭据（§12；UC = __pugs） */
  cookie?: { key: string; value: string };
  /** 手动终止标记（cookie 弹窗选「算了吧」） */
  terminatedAt?: number;
}

/** 主键：shareId::fid（fid 跨分享可能重复，必须带分享前缀） */
export function praseKey(shareId: string, fid: string): string {
  return `${shareId}::${fid}`;
}

/** 内存 LinkEntry → 落库快照 */
function toSnapshot(shareId: string, fid: string, entry: LinkEntry): PraseSnapshot {
  return {
    key: praseKey(shareId, fid),
    shareId,
    fid,
    ok: entry.ok,
    url: entry.url,
    error: entry.error,
    fetchedAt: entry.fetchedAt,
    cookie: entry.cookie,
    terminatedAt: entry.terminatedAt,
  };
}

/** 落库快照 → 内存 LinkEntry */
function toEntry(s: PraseSnapshot): LinkEntry {
  return {
    ok: s.ok,
    url: s.url,
    error: s.error,
    fetchedAt: s.fetchedAt,
    cookie: s.cookie,
    terminatedAt: s.terminatedAt,
  };
}

/** 保存一条直链结果（按 shareId::fid 覆盖），并顺带清理该分享 24h 前的旧条目 */
export async function savePraseEntry(shareId: string, fid: string, entry: LinkEntry): Promise<void> {
  const db = await getDb();
  await dbPut(db, STORE_PRASE, toSnapshot(shareId, fid, entry));
  await sweepOld(db, shareId);
}

/** 批量保存（prase 完成后整批落库） */
export async function savePraseEntries(shareId: string, entries: ReadonlyMap<string, LinkEntry>): Promise<void> {
  const db = await getDb();
  for (const [fid, entry] of entries) {
    await dbPut(db, STORE_PRASE, toSnapshot(shareId, fid, entry));
  }
  await sweepOld(db, shareId);
}

/** 清理该分享 24h 前的旧条目（直链最长 6h，留 24h 富余；避免 store 无限增长） */
async function sweepOld(db: IDBDatabase, shareId: string): Promise<void> {
  const cutoff = Date.now() - 24 * 3600_000;
  const all = await dbGetAllByIndex<PraseSnapshot>(db, STORE_PRASE, 'shareId', { direction: 'next' });
  const stale = all.filter((s) => s.shareId === shareId && s.fetchedAt < cutoff).map((s) => s.key);
  if (stale.length > 0) {
    await dbDeleteBatch(db, STORE_PRASE, stale);
  }
}

/**
 * 读取某分享的全部直链结果（fid → LinkEntry）。
 * 读不到 / 已过期由调用方正常走 linkDetailOf 判定 → 白行 + 解析按钮，无需特殊处理。
 */
export async function listPraseByShareId(shareId: string): Promise<Map<string, LinkEntry>> {
  const db = await getDb();
  const all = await dbGetAllByIndex<PraseSnapshot>(db, STORE_PRASE, 'shareId', { direction: 'next' });
  const map = new Map<string, LinkEntry>();
  for (const s of all) {
    if (s.shareId !== shareId) continue;
    map.set(s.fid, toEntry(s));
  }
  return map;
}

/** 删除某分享的全部直链结果（刷新资源列表 / 删除链接时：fid 映射可能已变化） */
export async function clearPraseByShareId(shareId: string): Promise<void> {
  const db = await getDb();
  const all = await dbGetAllByIndex<PraseSnapshot>(db, STORE_PRASE, 'shareId', { direction: 'next' });
  const keys = all.filter((s) => s.shareId === shareId).map((s) => s.key);
  if (keys.length > 0) {
    await dbDeleteBatch(db, STORE_PRASE, keys);
  }
}

/** 清空全部直链结果（清空足迹时） */
export async function clearAllPrase(): Promise<void> {
  const db = await getDb();
  await dbClear(db, STORE_PRASE);
}
