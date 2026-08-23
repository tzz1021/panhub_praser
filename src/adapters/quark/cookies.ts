/**
 * 夸克登录态 cookie 存取与解析（docs/STRUCTURE.md：src/adapters/quark/cookies.ts）
 *
 * 真实 cookie 结论（v1.1.9.1 修正，交叉验证 alist/boxplayer/nfd/linkswift）：
 * - 关键 key：`__pus`（登录主凭证，必须有）、`__uid`（用户 id）、`__puus`（3h 会话）
 * - `__puus` 有效期约 3 小时，**服务端会在 API 响应 Set-Cookie 里自动刷新**（alist 实测：
 *   请求缺失 __puus 时才下发新的）→ 适配器捕获响应头自动合并，用户不用管
 * - 社区最佳实践：**整串 cookie 原样发送**（key 集合十几个，找最小集合不划算）
 * - 旧版 sdid/up/wk 是拍脑袋的假 key，已废弃
 *
 * 存储：localStorage 'pan-web:quark-cookie:v1'，完整 cookie 字符串。
 * 发送：download API 请求头 `Cookie: <整串>` 原样透传。
 * 导入解析：支持 Netscape / JSON（editthiscookie 数组）/ Header string 三种格式。
 */
const STORAGE_KEY = 'pan-we…e:v1';

/** 夸克关键 cookie 键（弹窗展示/校验用；整串模式下自动检测） */
export const QUARK_COOKIE_KEYS = ['__pus', '__uid', '__puus'] as const;

export type QuarkCookies = Partial<Record<(typeof QUARK_COOKIE_KEYS)[number], string>>;

/** 读取当前持有的夸克登录 cookie 整串；无/损坏返回 '' */
export function getQuarkCookieString(): string {
  if (typeof window === 'undefined') return '';
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return typeof v === 'string' ? v.trim() : '';
  } catch {
    return '';
  }
}

/** 写入夸克登录 cookie 整串（空串 = 清除）；已去空白/规范化 */
export function setQuarkCookieString(cookieString: string): void {
  if (typeof window === 'undefined') return;
  try {
    const clean = (cookieString ?? '').trim().replace(/^cookie\s*:\s*/i, '');
    if (clean) window.localStorage.setItem(STORAGE_KEY, clean);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 配额/隐私模式异常静默
  }
}

/** 从整串里取某个 key 的值（无则 undefined） */
export function cookieValueOf(cookieString: string, key: string): string | undefined {
  const stripped = (cookieString ?? '').replace(/^cookie\s*:\s*/i, '');
  for (const pair of stripped.split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    if (pair.slice(0, eq).trim() === key) return pair.slice(eq + 1).trim();
  }
  return undefined;
}

/** 当前整串里已有的关键 key（弹窗展示“已检测到 __pus/__uid/__puus”） */
export function quarkCookieKeysPresent(cookieString: string): string[] {
  return QUARK_COOKIE_KEYS.filter((k) => Boolean(cookieValueOf(cookieString, k)));
}

/** 是否具备登录态（__pus 是主凭证，必须存在；__uid/__puus 至少其一） */
export function hasQuarkAuth(cookieString: string): boolean {
  return Boolean(cookieValueOf(cookieString, '__pus'));
}

/** 从 key/value 映射拼整串（导入解析后的落库形态） */
export function buildQuarkCookieString(map: Record<string, string>): string {
  return Object.entries(map)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/* ============================== __puus/__pus 捕获合并（alist 同款） ============================== */

/**
 * 把响应 Set-Cookie 里的 __pus/__puus 合并进现有整串（服务端会定期刷新这两个值，
 * 尤其 __puus 3h 会话 —— 每次 download 响应都可能有新的）。
 * 代理模式下传输层把这两个 key 回传为 x-quark-pus / x-quark-puus（见 proxy.js）。
 */
export function mergeQuarkSetCookies(cookieString: string, headers: Record<string, string>): string {
  let out = cookieString;
  const patches: Array<[string, string | undefined]> = [
    ['__pus', headers['x-quark-pus']],
    ['__puus', headers['x-quark-puus']],
  ];
  for (const [key, value] of patches) {
    if (!value) continue;
    // 有则替换，无则追加
    const exists = cookieValueOf(out, key) !== undefined;
    const rest = exists
      ? out
          .split(';')
          .filter((p) => p.indexOf('=') > 0 && p.slice(0, p.indexOf('=')).trim() !== key)
          .join('; ')
      : out;
    out = rest ? `${rest}; ${key}=${value}` : `${key}=${value}`;
  }
  return out;
}

/* ============================== 导入解析 ============================== */

/**
 * 从任意文本解析出 { name: value } 映射（懒人导入，自动识别格式）：
 * 1. JSON：editthiscookie 数组 [{ name, value, ... }] 或 { name: value } 对象
 * 2. Netscape：`# Netscape HTTP Cookie File` 制表符行（取 name/value 列）
 * 3. Header string：`Cookie: __pus=xxx; __uid=yyy` 或裸 `k=v; k2=v2`
 * 只保留 value 非空的键；解析失败抛 Error（弹窗展示原因）。
 */
export function parseCookieText(text: string): Record<string, string> {
  const src = (text ?? '').trim();
  if (!src) throw new Error('内容为空，请粘贴或选择 cookie 文件');
  const out: Record<string, string> = {};

  // 1. JSON（editthiscookie 数组 / 对象）
  if (src.startsWith('[') || src.startsWith('{')) {
    try {
      const parsed = JSON.parse(src) as unknown;
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of arr) {
        if (item && typeof item === 'object') {
          const rec = item as Record<string, unknown>;
          const name = rec.name ?? rec.key ?? rec.cookie;
          const value = rec.value;
          if (typeof name === 'string' && name && typeof value === 'string') {
            out[name] = value;
          }
        }
      }
      if (Object.keys(out).length > 0) return out;
      // JSON 里没认出 name/value 结构 → 继续走下面的行解析
    } catch {
      // 不是合法 JSON，当作普通文本继续
    }
  }

  // 2. Netscape（制表符分隔，≥7 列：domain flag path secure expiry name value）
  if (/^#\s*Netscape/i.test(src) || src.includes('\t')) {
    let hit = 0;
    for (const line of src.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const cols = t.split('\t');
      if (cols.length >= 7 && cols[5] && cols[6]) {
        out[cols[5]] = cols[6];
        hit++;
      }
    }
    if (hit > 0) return out;
  }

  // 3. Header string：`Cookie: k=v; k2=v2` 或裸 `k=v; k2=v2`
  const stripped = src.replace(/^cookie\s*:\s*/i, '');
  for (const pair of stripped.split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k && v) out[k] = v;
  }
  if (Object.keys(out).length > 0) return out;

  throw new Error('未能识别 cookie 内容（支持 Netscape / JSON / Header 字符串）');
}

/* ============================== __pugs 捕获（同 UC 机制） ============================== */

/**
 * 夸克 __pugs 存取（与 UC 同机制，reverse-notes-uc.md §10/§12）：
 * download 响应 Set-Cookie 下发，经代理回传 x-pugs 头，本适配器收口捕获。
 * 独立存储键（不共用 UC 的），仅用于弹窗展示捕获状态；直链绑定用的是
 * scanner 里的响应级 lastResponsePugs，不读这里的全局值。
 */
const PUGS_KEY = 'pan-we…s:v1';

/** 读取当前持有的夸克 __pugs 值；无/损坏返回 null */
export function getQuarkPugs(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(PUGS_KEY);
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** 写入 __pugs 值（适配器捕获后调用；空值忽略，防脏数据） */
export function setQuarkPugs(value: string | null | undefined): void {
  if (!value || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PUGS_KEY, value);
  } catch {
    // 配额/隐私模式异常静默
  }
}

/** 从传输层响应头里捕获 x-pugs（若存在）并落库；返回捕获到的值（无则 null） */
export function capturePugsFromHeaders(headers: Record<string, string>): string | null {
  const v = headers['x-pugs'];
  if (!v) return null;
  setQuarkPugs(v);
  return v;
}
