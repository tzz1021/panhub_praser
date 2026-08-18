/**
 * 足迹系统 IndexedDB 层（docs/STRUCTURE.md：src/core/footprint/db.ts）
 *
 * 库名 'pan-web-footprint'（版本 2）；仅存本地，见 HANDOFF §3.2 第 4 条。
 * 五个 store：
 *   - 'links'    keyPath 'url'，索引 lastUsedAt（已填链接查重/历史）
 *   - 'trees'    keyPath 'shareId'（目录树快照，md 导出用；同 shareId 覆盖）
 *   - 'records'  keyPath 'id' autoIncrement，索引 parsedAt（解析记录）
 *   - 'logs'     keyPath 'id' autoIncrement，索引 time（完整日志，5MB 轮转）
 *   - 'prase'    keyPath 'key'（shareId::fid），索引 shareId（直链结果按 fid 复用，v1.1.5.3）
 * 零第三方依赖：全部为手写 Promise 包装的 IDB 工具（get/put/add/delete/getAll/clear + 索引游标/批量删）。
 */

/** 数据库名 */
export const DB_NAME = 'pan-web-footprint';
/** 数据库版本（schema 变更时 +1 并在 onupgradeneeded 里做迁移） */
export const DB_VERSION = 2;

/** store 名常量（各模块/测试复用，避免魔法字符串） */
export const STORE_LINKS = 'links';
export const STORE_TREES = 'trees';
export const STORE_RECORDS = 'records';
export const STORE_LOGS = 'logs';
export const STORE_PRASE = 'prase';

/** 打开（必要时创建/迁移）足迹库 */
export function openFootprintDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_LINKS)) {
        const store = db.createObjectStore(STORE_LINKS, { keyPath: 'url' });
        store.createIndex('lastUsedAt', 'lastUsedAt'); // 历史链接按最近使用倒序
      }
      if (!db.objectStoreNames.contains(STORE_TREES)) {
        db.createObjectStore(STORE_TREES, { keyPath: 'shareId' }); // 同 shareId 覆盖
      }
      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        const store = db.createObjectStore(STORE_RECORDS, { keyPath: 'id', autoIncrement: true });
        store.createIndex('parsedAt', 'parsedAt'); // 解析记录按时间倒序
      }
      if (!db.objectStoreNames.contains(STORE_LOGS)) {
        const store = db.createObjectStore(STORE_LOGS, { keyPath: 'id', autoIncrement: true });
        store.createIndex('time', 'time'); // 日志按时间排序（轮转删最旧）
      }
      // v1.1.5.3：直链结果按 fid 复用（shareId::fid 主键，shareId 索引批量读）
      if (!db.objectStoreNames.contains(STORE_PRASE)) {
        const store = db.createObjectStore(STORE_PRASE, { keyPath: 'key' });
        store.createIndex('shareId', 'shareId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('打开 IndexedDB 失败'));
    req.onblocked = () => reject(new Error('IndexedDB 被其他标签页阻塞，请关闭后重试'));
  });
}

/** 共享连接缓存：模块内复用，避免每次操作重开库；打开失败清空缓存以便重试 */
let dbPromise: Promise<IDBDatabase> | null = null;

/** 取共享连接（首次调用时打开） */
export function getDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openFootprintDb().catch((err: unknown) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

/** IDBRequest → Promise 包装 */
function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 请求失败'));
  });
}

/** 读取单条（找不到返回 undefined） */
export function dbGet<T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> {
  return requestToPromise(db.transaction(store, 'readonly').objectStore(store).get(key));
}

/** 写入/覆盖（put：key 已存在则覆盖） */
export function dbPut(db: IDBDatabase, store: string, value: unknown): Promise<IDBValidKey> {
  return requestToPromise(db.transaction(store, 'readwrite').objectStore(store).put(value));
}

/** 新增（add：key 已存在会抛 ConstraintError；用于自增主键 store） */
export function dbAdd(db: IDBDatabase, store: string, value: unknown): Promise<IDBValidKey> {
  return requestToPromise(db.transaction(store, 'readwrite').objectStore(store).add(value));
}

/** 删除单条 */
export function dbDelete(db: IDBDatabase, store: string, key: IDBValidKey): Promise<void> {
  return requestToPromise(db.transaction(store, 'readwrite').objectStore(store).delete(key)).then(() => undefined);
}

/** 读取全量（无排序；需排序的由调用方处理或走 dbGetAllByIndex） */
export function dbGetAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return requestToPromise(db.transaction(store, 'readonly').objectStore(store).getAll());
}

/** 清空 store */
export function dbClear(db: IDBDatabase, store: string): Promise<void> {
  return requestToPromise(db.transaction(store, 'readwrite').objectStore(store).clear()).then(() => undefined);
}

/** 计数 */
export function dbCount(db: IDBDatabase, store: string): Promise<number> {
  return requestToPromise(db.transaction(store, 'readonly').objectStore(store).count());
}

/** 按索引游标读取（direction 默认正序；limit 截断；返回按索引键排序的记录） */
export function dbGetAllByIndex<T>(
  db: IDBDatabase,
  store: string,
  indexName: string,
  opts: { direction?: IDBCursorDirection; limit?: number } = {},
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).index(indexName).openCursor(null, opts.direction ?? 'next');
    const out: T[] = [];
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor && (opts.limit === undefined || out.length < opts.limit)) {
        out.push(cursor.value as T);
        cursor.continue();
      } else {
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 索引读取失败'));
  });
}

/** 单事务批量删除（日志轮转用，避免逐条开事务） */
export function dbDeleteBatch(db: IDBDatabase, store: string, keys: readonly IDBValidKey[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const key of keys) os.delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 批量删除失败'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'));
  });
}
