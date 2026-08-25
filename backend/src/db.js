/**
 * SQLite 存储 + AES-256-GCM 加密（docs/selfhost-node.md §5）
 *
 * - node:sqlite（Node ≥22.5 内置，零 native 依赖；Termux/bionic 友好）
 * - 账号 cookie 密文：`v1:iv:tag:cipher`（AES-256-GCM，密钥来自 data/period/secret.key）
 * - 表：accounts / proxy_logs / settings / audit_log
 */
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { PERIOD_DIR, loadSecretKey } from './config.js';

let db = null;
let secretKey = null;

/** 加密（返回 v1:iv:tag:cipher base64 拼接串） */
export function encrypt(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/** 解密（格式不符/密钥不对 → 返回 null，不抛） */
export function decrypt(payload) {
  try {
    const [v, ivB64, tagB64, dataB64] = String(payload).split(':');
    if (v !== 'v1') return null;
    const decipher = createDecipheriv('aes-256-gcm', secretKey, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** 初始化（幂等） */
export function initDb() {
  if (db) return db;
  secretKey = loadSecretKey();
  db = new DatabaseSync(join(PERIOD_DIR, 'panhub.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY,
      pan TEXT NOT NULL,              -- 'quark' | 'uc' | ...
      label TEXT,                     -- 备注名
      cookie_enc TEXT NOT NULL,       -- AES-256-GCM 密文
      expires_at INTEGER,             -- 已知过期时间（可空）
      status TEXT DEFAULT 'ok',       -- ok | expired | risk
      last_used_at INTEGER,
      created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS proxy_logs (
      id INTEGER PRIMARY KEY,
      ts INTEGER,
      pan TEXT,
      operation TEXT,                 -- scan | prase | other
      method TEXT, url TEXT,
      req_status INTEGER,
      duration_ms INTEGER,
      account_id INTEGER,
      queued_ms INTEGER,
      client_ip TEXT,
      req_headers TEXT,               -- 脱敏 JSON
      resp_headers TEXT,              -- 脱敏 JSON（凭据值 SHA-256）
      body_preview TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY,
      ts INTEGER,
      action TEXT,
      detail TEXT,
      via TEXT
    );
  `);
  return db;
}

export function getDb() {
  if (!db) initDb();
  return db;
}

/** 审计写入（webui/cli/terminal 都走这里） */
export function audit(action, detail = '', via = 'webui') {
  try {
    getDb().prepare('INSERT INTO audit_log (ts, action, detail, via) VALUES (?,?,?,?)').run(Date.now(), action, String(detail).slice(0, 500), via);
  } catch {
    /* 审计失败不阻断 */
  }
}

/* ---------------- settings 键值（敏感字段加密） ---------------- */
export function getSetting(key) {
  const row = getDb().prepare('SELECT v FROM settings WHERE k = ?').get(key);
  return row ? row.v : null;
}
export function setSetting(key, value) {
  getDb().prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, String(value));
}

/** 最近审计记录（新→旧） */
export function listAudit(limit = 100) {
  return getDb().prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
}
