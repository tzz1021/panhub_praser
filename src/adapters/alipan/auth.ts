/**
 * 阿里云盘登录态凭据串存取与解析（docs/STRUCTURE.md：src/adapters/alipan/auth.ts）
 *
 * 与夸克不同：alipan 没有「下载层自动捕获 cookie」，也不需要浏览器 cookie —— prase（两跳：
 * 转存 + 取直链）需要的是**登录态 Bearer token** + **转存目标目录**，由用户手动提供。
 *
 * 凭据串格式（与 CookieInputModal 整串模式对齐，v1.2.x alipan 定稿）：
 *   `auth=Bearer xxx;drive_id=xxx;to_parent_file_id=<转存目标目录 file_id>;user-agent=<可选>;x-device-id=<可选>`
 * - auth：必填。alipan.com 已登录网页 F12 → 任意 /adrive/v2 或 /v2 请求的
 *   `Authorization: Bearer <jwt>` 整行（可只贴 token，代码自动补 Bearer 前缀）；有效期≈2h
 *   v1.3 兼容：**只写 `Bearer xxx`（无 auth= 键、无其他字段）也要能当 auth 用**——裸 Authorization
 *   整行是最省事的贴法；解析器在找不到 `auth=` 键时向后兼容提取 Bearer 令牌（见 parseAlipanAuthString）。
 *   其余字段（drive_id/to_parent_file_id/…）仍可键值对出现，可与裸 Bearer 混写
 * - drive_id：必填。自己账号的 drive_id（与 auth 同一份 F12 抓包：/adrive/v2/... 请求
 *   响应体或后续请求 body 里的 drive_id 字段，长数字串）—— copy 转存与 get_download_url 都要
 * - to_parent_file_id：必填。自己在 alipan.com/drive 里目标目录的 file_id
 *   （地址栏 /drive/file/all/<id> 的 <id>）；转存后的文件落这里
 * - user-agent：可选。缺省用 ALIPAN_DEFAULT_UA
 * - x-device-id：可选。缺省不带（与「设备标识符可选，默认只写 UA」定稿一致）
 *
 * 键值顺序固定（auth 在最前），值内部允许出现 `;`（如 UA 的 `(X11; Linux x86_64)`）——
 * 因此解析用「已知键标记定位」而不是朴素 split(';')，保证 UA 原样还原。
 *
 * 存储：localStorage 'pan-web:alipan-auth:v1'，完整凭据串。
 */
const STORAGE_KEY = 'pan-web:alipan-auth:v1';

/** 凭据串关键键（弹窗展示/校验用；整串模式下自动检测；顺序 = 推荐书写顺序） */
export const ALIPAN_AUTH_KEYS = ['auth', 'drive_id', 'to_parent_file_id', 'user-agent', 'x-device-id'] as const;

/** 解析结果（缺省值已按定稿填充；auth/token 未填则 auth 为空串） */
export interface AlipanAuth {
  /** Authorization 头值（含 Bearer 前缀；未填为空串） */
  auth: string;
  /** 账号 drive_id（必填；copy 显式 to_drive_id + get_download_url 用；未填为空串） */
  driveId?: string;
  /** 转存目标目录 file_id（必填；未填为空串） */
  toParentFileId: string;
  /** user-agent（缺省 ALIPAN_DEFAULT_UA） */
  userAgent?: string;
  /** x-device-id（可选；缺省不带） */
  xDeviceId?: string;
}

/** 读取当前保存的 alipan 凭据串；无/损坏返回 '' */
export function getAlipanAuthString(): string {
  if (typeof window === 'undefined') return '';
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return typeof v === 'string' ? v.trim() : '';
  } catch {
    return '';
  }
}

/** 写入 alipan 凭据串（空串 = 清除） */
export function setAlipanAuthString(authString: string): void {
  if (typeof window === 'undefined') return;
  try {
    const clean = (authString ?? '').trim();
    if (clean) window.localStorage.setItem(STORAGE_KEY, clean);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 配额/隐私模式异常静默
  }
}

/**
 * 定位解析：按已知键的段标记切分（键序固定：auth 最先）。
 * 每段值 = 该键 '=' 之后 到 下一键标记起点；值内部允许出现 ';'（UA 的 `(X11; Linux x86_64)`）
 * 与朴素 split(';') 的区别：后出现的键用 (?:^|;) 前缀定位，不会把 UA 内的 ';' 误当成新段。
 */
export function parseAlipanAuthString(authString: string): AlipanAuth {
  const src = (authString ?? '').trim();
  const out: AlipanAuth = { auth: '', toParentFileId: '' };
  if (!src) return out;

  const KEYS = ['auth', 'drive_id', 'to_parent_file_id', 'user-agent', 'x-device-id'] as const;
  // 收集每个键首次出现的段标记（(?:^|;) 允许裸 auth= 开头，也允许 '; ' 带空格分隔）；
  // 值段 = 该键 '=' 之后 到 下一键的段标记起点（markerStart），中间内容含 ';' 也原样保留
  const spans: Array<{ key: string; markerStart: number; valueStart: number }> = [];
  for (const k of KEYS) {
    const m = new RegExp('(?:^|;)\\s*' + k + '=').exec(src);
    if (!m) continue;
    if (!spans.some((s) => s.key === k)) spans.push({ key: k, markerStart: m.index, valueStart: m.index + m[0].length });
  }
  // 按段起点排序：上一键的值在下一键的 markerStart 处结束（末段到串尾）
  spans.sort((a, b) => a.markerStart - b.markerStart);
  spans.forEach((s, i) => {
    const end = i + 1 < spans.length ? Math.max(s.valueStart, spans[i + 1].markerStart) : src.length;
    const value = src.slice(s.valueStart, end).trim();
    if (!value) return;
    switch (s.key) {
      case 'auth':
        out.auth = value;
        break;
      case 'to_parent_file_id':
        out.toParentFileId = value;
        break;
      case 'user-agent':
        out.userAgent = value;
        break;
      case 'x-device-id':
        out.xDeviceId = value;
        break;
      case 'drive_id':
        out.driveId = value;
        break;
    }
  });

  // v1.3 兼容：没有 `auth=` 键时，把裸 Authorization 整行/纯 token 当 auth 用
  // （规格：只写 `Bearer xxx`、无其他字段也要能解析；drive_id/to_parent_file_id 仍可键值对混写）
  if (!out.auth) {
    const bearer = /Bearer\s+([A-Za-z0-9._~+/=-]+)/i.exec(src);
    // 纯 JWT（三段 base64url，无 Bearer 前缀、无键值对标记）
    const bare = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.exec(src);
    const token = bearer?.[1] ?? bare?.[0];
    if (token) out.auth = token;
  }
  return out;
}

/** 从 key/value 映射拼凭据串（导入解析后的落库形态；与 cookie 整串同分隔风格） */
export function buildAlipanAuthString(map: Record<string, string>): string {
  return Object.entries(map)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/** 当前凭据串里已有的关键键（弹窗展示“已检测到 auth/to_parent_file_id…”） */
export function alipanAuthKeysPresent(authString: string): string[] {
  const esc = (k: string) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keys = ALIPAN_AUTH_KEYS.filter((k) => new RegExp(`(?:^|;)\\s*${esc(k)}=`).test(authString ?? ''));
  // v1.3：裸 `Bearer xxx` / 纯 token 形态没有 `auth=` 键标记，按解析结果补报
  // （否则弹窗会误报「未检测到必要 key」，用户明明填对了 auth）
  if (!keys.includes('auth') && parseAlipanAuthString(authString).auth) return ['auth', ...keys];
  return keys;
}

/** 是否具备转存条件（auth 是硬前提；to_parent_file_id 决定能否落盘，缺了会弹窗提示补） */
export function hasAlipanAuth(authString: string): boolean {
  return parseAlipanAuthString(authString).auth.length > 0;
}
