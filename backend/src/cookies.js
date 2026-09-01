/**
 * 账号 cookie 池（docs/backend-wrangler-plan.md §4.1 保留 + 扩展）
 *
 * 字段名与 SPA 侧 CookieInputModal 对齐（v1.2 约定，勿改）：
 * - pan：adapter id —— 'quark' | 'uc'（与 src/adapters/registry.ts 的 id 一致）
 * - quark 存**整串** cookie（关键 key：__pus / __uid / __puus）
 * - uc 存 __pugs（游客态下载凭据，208 字符）
 * 读取时按 pan 合并进转发请求的 Cookie 头；服务端 Set-Cookie 刷新自动回写。
 *
 * v0.1.0-next 新增：
 * - kind 列（real | guest）：guest = 游客模拟账号，label 自动打标 guest#随机后缀
 *   （可追溯，排查 412/403 用）；每次使用时随机生成必要值（__pugs）并落库
 * - 注入时向 SPA 回传账号标识（x-panhub-account：quark#3 / guest#abc123），
 *   真实 cookie 整串绝不下发前端
 *
 * v1.2.2 新增（§9 P2）：
 * - runRefreshCycle()：cookie 刷新定时器（quark 优先）——轻量登录态请求捕获 set-cookie
 *   → mergeSetCookies；连续失败 ≥3 标 expired；整体 try/catch 永不崩溃
 */
import { getDb, encrypt, decrypt, audit } from './db.js';
import { log } from './log.js';
import { randomBytes } from 'node:crypto';

/** 已知凭据名（日志脱敏用；与 SPA redactSensitive 同思路） */
export const CREDENTIAL_KEYS = ['__pus', '__puus', '__pugs', '__uid', 'sdid', 'up', 'wk'];

/** pan → 关键 key（账号池表单/校验用；与 SPA 对齐） */
export const PAN_KEYS = {
  quark: ['__pus', '__uid', '__puus'],
  uc: ['__pugs'],
};

/** guest 账号只认 __pugs（游客态下载凭据，quark 小文件/UC 同机制） */
export const GUEST_KEYS = ['__pugs'];

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
export function keysPresent(cookieString, pan, kind = 'real') {
  const keys = kind === 'guest' ? GUEST_KEYS : PAN_KEYS[pan] ?? [];
  return keys.filter((k) => Boolean(cookieValueOf(cookieString, k)));
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
      kind: r.kind ?? 'real',
      status: r.status,
      expiresAt: r.expires_at,
      lastUsedAt: r.last_used_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      cookieTail: plain.slice(-8),
      cookieLength: plain.length,
      keys: keysPresent(plain, r.pan, r.kind),
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

/** 随机 __pugs 形态值（guest 账号每次使用重新生成；形状对齐真实凭据便于排查） */
export function randomPugs() {
  return randomBytes(156).toString('base64').replace(/[+/=]/g, (c) => (c === '+' ? '-' : c === '/' ? '_' : ''));
}

/** 账号对外标识（x-panhub-account 回传 SPA；真实 cookie 不下发） */
export function accountTag(a) {
  if (!a) return null;
  if (a.kind === 'guest') {
    const m = String(a.label ?? '').match(/^guest#(.+)$/);
    return m ? `guest#${m[1]}` : 'guest';
  }
  return `${a.pan}#${a.id}`;
}

/**
 * 新增/更新账号。
 * @param fields { id?, pan, label, cookieString, expiresAt?, kind? }
 *   kind='guest'：游客模拟账号 —— cookieString 可空（空则生成随机 __pugs）；
 *   label 缺省自动打标 guest#<随机6位>（可追溯）。
 */
export function upsertAccount(fields, via = 'webui') {
  const kind = fields.kind === 'guest' ? 'guest' : 'real';
  const pan = String(fields.pan ?? '').trim();
  if (!PAN_KEYS[pan]) throw new Error(`未知网盘 pan：${pan}（支持 ${Object.keys(PAN_KEYS).join('/')}）`);
  let cookieString = String(fields.cookieString ?? '').trim().replace(/^cookie\s*:\s*/i, '');
  let label = String(fields.label ?? '').trim().slice(0, 60);

  if (kind === 'guest') {
    // 游客模拟：cookieString 可空，空则生成随机 __pugs；label 打标 guest#随机后缀
    if (!cookieString) cookieString = `__pugs=${randomPugs()}`;
    if (!/^guest#/.test(label)) label = `guest#${Math.random().toString(36).slice(2, 8)}`;
  } else if (!cookieString) {
    throw new Error('cookie 为空，未保存');
  }

  const found = keysPresent(cookieString, pan, kind);
  if (found.length === 0) {
    throw new Error(
      `未识别到 ${kind === 'guest' ? '游客凭据' : pan} 关键 cookie key（${(kind === 'guest' ? GUEST_KEYS : PAN_KEYS[pan]).join(' / ')}），请检查粘贴内容`,
    );
  }
  const now = Date.now();
  const expiresAt = Number.isFinite(Number(fields.expiresAt)) && Number(fields.expiresAt) > 0 ? Number(fields.expiresAt) : null;
  const enc = encrypt(cookieString);
  const db = getDb();
  if (fields.id) {
    db.prepare(
      'UPDATE accounts SET pan=?, label=?, cookie_enc=?, expires_at=?, status=?, kind=?, updated_at=? WHERE id=?',
    ).run(pan, label, enc, expiresAt, 'ok', kind, now, fields.id);
    audit('account.update', `${pan}/${label}`, via);
  } else {
    const info = db
      .prepare('INSERT INTO accounts (pan, label, cookie_enc, expires_at, status, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(pan, label, enc, expiresAt, 'ok', kind, now, now);
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
 * 转发时按目标域名找账号（v1 分流矩阵）：
 * - prase/download：优先正式账号（最近使用优先）；无正式账号时回退 guest 账号
 *   （guest 每次使用重新生成随机 __pugs 并落库，label guest#xxx 可追溯）
 * - scan：保持游客，不注入
 * @returns { account, cookieString, tag } | null
 */
export function pickAccountForPan(pan, operation = 'prase') {
  if (operation !== 'prase') return null;
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM accounts WHERE pan = ? AND kind = 'real' ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT 1")
    .all(pan);
  let row = rows[0] ?? null;
  if (!row) {
    const guests = db
      .prepare("SELECT * FROM accounts WHERE pan = ? AND kind = 'guest' ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT 1")
      .all(pan);
    row = guests[0] ?? null;
  }
  if (!row) return null;
  let plain = decrypt(row.cookie_enc) ?? '';
  if (!plain) return null;
  if ((row.kind ?? 'real') === 'guest') {
    // 每次使用随机生成必要值（__pugs），落库打标 guest#随机后缀
    plain = `__pugs=${randomPugs()}`;
    db.prepare('UPDATE accounts SET cookie_enc = ?, last_used_at = ?, updated_at = ? WHERE id = ?').run(
      encrypt(plain),
      Date.now(),
      Date.now(),
      row.id,
    );
  } else {
    db.prepare('UPDATE accounts SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
  }
  return { account: row, cookieString: plain, tag: accountTag(row) };
}

/**
 * 服务端 Set-Cookie 刷新合并（与 SPA 前端 mergeQuarkSetCookies 同构）：
 * 响应里的 __pus/__puus/__pugs 更新到账号池对应**正式**账号。
 * guest 账号跳过（游客占位值每次使用随机生成，不做真实凭据回写）。
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
  for (const row of db.prepare("SELECT * FROM accounts WHERE pan = ? AND kind = 'real'").all(pan)) {
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

/** 统计各 pan 账号数（账号池页展示；区分 kind） */
export function countByPan() {
  return getDb().prepare('SELECT pan, kind, COUNT(*) AS n FROM accounts GROUP BY pan, kind').all();
}

/* ---------------- cookie 刷新定时器（v1.2.2 §9 P2：quark 优先） ---------------- */

const REFRESH_TIMEOUT_MS = 10_000;
const REFRESH_FAIL_LIMIT = 3; // 连续失败 ≥3 次 → 标记 expired

/**
 * 各 pan 的轻量登录态刷新端点（请求后捕获 set-cookie → mergeSetCookies）。
 * TODO(v1.2.2 §9 P2)：quark 刷新 URL 待真机验证 —— 先按设计稿实现，不硬编码断言成功；
 * uc 暂无轻量登录态接口（P4 再补），只有 quark 在表里就只刷 quark。
 * UA 参考 src/adapters/quark/types.ts QUARK_DL_UA（Electron 客户端 UA，夸克风控识别用）。
 */
const REFRESH_ENDPOINTS = {
  quark: {
    // 2026-08-30 真机验证：drive-h.quark.cn/1/clouddrive/account/info 404（旧值），
    // pan.quark.cn/account/info 200（{success, data:{nickname,...}}）——登录态保活用；
    // 无 set-cookie 时仅确认状态不合并（刷新 URL 已不再挂 404，避免误标 expired）
    url: 'https://pan.quark.cn/account/info',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/3.20.0 Chrome/112.0.5615.165 Electron/24.1.3.8 Safari/537.36 Channel/pckk_other_ch',
  },
};

/** 连续失败计数（内存态；重启清零） */
const failCounts = new Map();

/** 失败计数 +1；连续 ≥3 次 → 标 expired（计数清零，下轮重新累积） */
function bumpFail(accountId, pan) {
  const n = (failCounts.get(accountId) ?? 0) + 1;
  failCounts.set(accountId, n);
  if (n >= REFRESH_FAIL_LIMIT) {
    try {
      getDb().prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?').run('expired', Date.now(), accountId);
      audit('account.expired', `${pan}#${accountId} 连续刷新失败 ${REFRESH_FAIL_LIMIT} 次，标记 expired`, 'refresh');
      log('warn', `refresh：${pan}#${accountId} 连续失败 ${REFRESH_FAIL_LIMIT} 次，已标记 expired`);
    } catch {
      /* 落库失败不阻断 */
    }
    failCounts.delete(accountId);
  }
}

/**
 * 跑一轮 cookie 刷新：对每个 pan 的正式账号逐个发轻量登录态请求，
 * 捕获 set-cookie → mergeSetCookies(pan, setCookies)；成功恢复 ok，连续失败 ≥3 标 expired。
 * 整体 try/catch 永不崩溃（定时器调用方直接 await，异常不外抛）。
 */
export async function runRefreshCycle() {
  try {
    const db = getDb();
    for (const [pan, ep] of Object.entries(REFRESH_ENDPOINTS)) {
      const rows = db.prepare("SELECT * FROM accounts WHERE pan = ? AND kind = 'real'").all(pan);
      for (const row of rows) {
        try {
          const plain = decrypt(row.cookie_enc) ?? '';
          if (!plain) {
            bumpFail(row.id, pan);
            continue;
          }
          const res = await fetch(ep.url, {
            method: 'GET',
            headers: { cookie: plain, 'user-agent': ep.ua, accept: 'application/json' },
            signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
          });
          if (!res.ok) {
            log('warn', `refresh：${pan}#${row.id} 登录态检查失败（HTTP ${res.status}）`);
            bumpFail(row.id, pan);
            continue;
          }
          const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
          if (setCookies.length > 0) {
            mergeSetCookies(pan, setCookies);
            log('info', `refresh：${pan}#${row.id} 合并 set-cookie ${setCookies.length} 条`);
          }
          failCounts.delete(row.id);
          if ((row.status ?? 'ok') !== 'ok') {
            db.prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?').run('ok', Date.now(), row.id);
            log('info', `refresh：${pan}#${row.id} 恢复 ok`);
          }
        } catch (err) {
          log('warn', `refresh：${pan}#${row.id} 失败 — ${err?.message ?? err}`);
          bumpFail(row.id, pan);
        }
      }
    }
  } catch (err) {
    log('error', `refresh：周期异常 — ${err?.message ?? err}`);
  }
}
