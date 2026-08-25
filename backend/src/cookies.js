/**
 * 账号 cookie 池（docs/selfhost-node.md §4.2/§7）
 *
 * 字段名与 SPA 侧 CookieInputModal 对齐（v1.2 约定，勿改）：
 * - pan：adapter id —— 'quark' | 'uc'（与 src/adapters/registry.ts 的 id 一致）
 * - quark 存**整串** cookie（关键 key：__pus / __uid / __puus，与
 *   src/adapters/quark/cookies.ts 的 QUARK_COOKIE_KEYS 一致）
 * - uc 存 __pugs（游客态下载凭据，208 字符）
 * 读取时按 pan 合并进转发请求的 Cookie 头；服务端 Set-Cookie 刷新自动回写。
 */
import { getDb, encrypt, decrypt, audit } from './db.js';

/** 已知凭据名（日志脱敏用；与 SPA redactSensitive 同思路） */
export const CREDENTIAL_KEYS = ['__pus', '__puus', '__pugs', '__uid', 'sdid', 'up', 'wk'];

/** pan → 关键 key（账号池表单/校验用；与 SPA 对齐） */
export const PAN_KEYS = {
  quark: ['__pus', '__uid', '__puus'],
  uc: ['__pugs'],
};

/** 从整串里取某 key 的值（无则 undefined） */
export function cookieValueOf(cookieString, key) {
  const stripped = String(cookieString ?? '').replace(/^cookie\s*:\s*/i, '');
  for (const pair of stripped.split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    if (pair.slice(0, eq).trim() === key) return pair.slice(eq + 1).trim();
  }
  return undefined;
}

/** 整串里已有关键 key 列表（账号池表单实时检测） */
export function keysPresent(cookieString, pan) {
  return (PAN_KEYS[pan] ?? []).filter((k) => Boolean(cookieValueOf(cookieString, k)));
}

/* ---------------- CRUD ---------------- */

/** 账号列表（cookie 值脱敏：只露末 8 位；expiresAt/status/lastUsedAt 明细） */
export function listAccounts() {
  const rows = getDb().prepare('SELECT * FROM accounts ORDER BY pan, id').all();
  return rows.map((r) => {
    const plain = decrypt(r.cookie_enc) ?? '';
    return {
      id: r.id,
      pan: r.pan,
      label: r.label ?? '',
      status: r.status,
      expiresAt: r.expires_at,
      lastUsedAt: r.last_used_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      cookieTail: plain.slice(-8),
      cookieLength: plain.length,
      keys: keysPresent(plain, r.pan),
      // 整串明文只在"编辑时回填"接口返回（getAccount），列表不回
    };
  });
}

/** 单个账号（含解密后的整串，编辑回填用；仅 webui 本机可调） */
export function getAccount(id) {
  const r = getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!r) return null;
  return { ...r, cookieString: decrypt(r.cookie_enc) ?? '' };
}

/**
 * 新增/更新账号。
 * @param fields { id?, pan, label, cookieString, expiresAt? }
 */
export function upsertAccount(fields, via = 'webui') {
  const pan = String(fields.pan ?? '').trim();
  if (!PAN_KEYS[pan]) throw new Error(`未知网盘 pan：${pan}（支持 ${Object.keys(PAN_KEYS).join('/')}）`);
  const cookieString = String(fields.cookieString ?? '').trim().replace(/^cookie\s*:\s*/i, '');
  if (!cookieString) throw new Error('cookie 为空，未保存');
  const found = keysPresent(cookieString, pan);
  if (found.length === 0) {
    throw new Error(`未识别到 ${pan} 关键 cookie key（${PAN_KEYS[pan].join(' / ')}），请检查粘贴内容`);
  }
  const now = Date.now();
  const label = String(fields.label ?? '').trim().slice(0, 60);
  const expiresAt = Number.isFinite(Number(fields.expiresAt)) && Number(fields.expiresAt) > 0 ? Number(fields.expiresAt) : null;
  const enc = encrypt(cookieString);
  const db = getDb();
  if (fields.id) {
    db.prepare(
      'UPDATE accounts SET pan=?, label=?, cookie_enc=?, expires_at=?, status=?, updated_at=? WHERE id=?',
    ).run(pan, label, enc, expiresAt, 'ok', now, fields.id);
    audit('account.update', `${pan}/${label}`, via);
  } else {
    const info = db
      .prepare('INSERT INTO accounts (pan, label, cookie_enc, expires_at, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(pan, label, enc, expiresAt, 'ok', now, now);
    audit('account.add', `${pan}/${label}`, via);
    return info.lastInsertRowid;
  }
  return fields.id;
}

/** 删除账号 */
export function deleteAccount(id, via = 'webui') {
  const r = getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (r) {
    getDb().prepare('DELETE FROM accounts WHERE id = ?').run(id);
    audit('account.delete', `${r.pan}/${r.label ?? ''}`, via);
  }
}

/**
 * 转发时按目标域名找账号（v1：每 pan 取最近使用/最新的一个；多账号轮换后续版本）
 * @returns { account, cookieString } | null
 */
export function pickAccountForPan(pan) {
  const r = getDb()
    .prepare('SELECT * FROM accounts WHERE pan = ? ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT 1')
    .get(pan);
  if (!r) return null;
  const plain = decrypt(r.cookie_enc) ?? '';
  if (!plain) return null;
  getDb().prepare('UPDATE accounts SET last_used_at = ? WHERE id = ?').run(Date.now(), r.id);
  return { account: r, cookieString: plain };
}

/**
 * 服务端 Set-Cookie 刷新合并（与 SPA 前端 mergeQuarkSetCookies 同构）：
 * 响应里的 __pus/__puus/__pugs 更新到账号池对应账号。
 * @param pan    'quark' | 'uc'
 * @param setCookies  Set-Cookie 头值数组
 */
export function mergeSetCookies(pan, setCookies) {
  if (!Array.isArray(setCookies) || setCookies.length === 0) return;
  const keys = PAN_KEYS[pan] ?? [];
  const patches = new Map();
  for (const sc of setCookies) {
    const eq = sc.indexOf('=');
    if (eq <= 0) continue;
    const name = sc.slice(0, eq).trim();
    const value = sc.slice(eq + 1).split(';')[0].trim();
    if (keys.includes(name) && value) patches.set(name, value);
  }
  if (patches.size === 0) return;
  const db = getDb();
  for (const row of db.prepare('SELECT * FROM accounts WHERE pan = ?').all(pan)) {
    const plain = decrypt(row.cookie_enc) ?? '';
    if (!plain) continue;
    let out = plain;
    for (const [k, v] of patches) {
      const exists = cookieValueOf(out, k) !== undefined;
      const rest = exists
        ? out
            .split(';')
            .filter((p) => p.indexOf('=') > 0 && p.slice(0, p.indexOf('=')).trim() !== k)
            .join('; ')
        : out;
      out = rest ? `${rest}; ${k}=${v}` : `${k}=${v}`;
    }
    if (out !== plain) {
      db.prepare('UPDATE accounts SET cookie_enc = ?, updated_at = ? WHERE id = ?').run(encrypt(out), Date.now(), row.id);
    }
  }
}

/** 统计各 pan 账号数（账号池页展示） */
export function countByPan() {
  return getDb().prepare('SELECT pan, COUNT(*) AS n FROM accounts GROUP BY pan').all();
}
