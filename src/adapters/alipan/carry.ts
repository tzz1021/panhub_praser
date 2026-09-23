/**
 * 阿里云盘滚动更新（carry-over）+ 凭据快捷更新（docs/STRUCTURE.md：src/adapters/alipan/carry.ts，v1.3.1）
 *
 * 为什么要有这一层（Tzz 定稿）：alipan prase = 先转存（restore）再取直链，直链仅 15min 有效，
 * 反复解析会反复转存（占空间、易「空间满了」）；而用户 auth（access_token）≈2h 有效。
 * 因此同账号在 auth 生命周期内重解析时，应复用上次转存得到的 file_id 直接取直链（「续杯」），
 * 跳过转存。转存副本由后台一天清一次，所以「一个浏览器一天一次转存」是可接受的设计。
 *
 * 存储（v1.3.1 定稿：**不再分键值对，丢一起**）：统一记录 `pan-web:alipan-carry:v1`，
 * 形态见 auth.ts 的 `AlipanStoreRecord`：
 *   { lastUserId, lastAuth, drive_id, to_parent_file_id, updateAt, files: { [file_id]: copied_file_id } }
 * - 选本地存储而非后端（Tzz A1）：carry 的作用是**决定要不要发 restore 请求**，只能在本地判定
 * - 选 localStorage 而非 core/footprint(IndexedDB)：core 零网盘依赖、单条内部状态、
 *   与凭据同层便于清理（详见 auth.ts 文件头）
 * - 内存态（选「否」= 仅本次有效）：sessionCarry 只活在本次页面，刷新即失效，不写 localStorage、不进后端统计
 *
 * 流程（Tzz 定稿）：
 *   优先请求后端取号；没有后端/后端没号 → 回退本地输入；无论哪条路，请求完 download 都由 carry 落本地
 *   → 下次 carry 只读「上次账号」：有映射只发 download（跳过 restore）；download 报「存过又删了」
 *     （如 ForbiddenFileInTheRecycleBin）→ 重新执行 restore 并刷新本地记录
 *
 * 账号身份（userId）：**离线**解 auth（Bearer JWT）payload（atob + UTF-8 解码），不请求任何接口。
 * 阿里 web token 的账号声明是 `userId`（真机结论，2026-09-08：payload 只有 userId/customJson/exp/iat），
 * 兼容 user_id/sub/uid；全解不出时降级 `drive:<drive_id>`（凭据必填项、同账号稳定）。
 */
import {
  ALIPAN_CARRY_EXPIRED_CODES,
  ALIPAN_CARRY_STALE_CODES,
  ALIPAN_CREDENTIAL_PROVIDER,
} from './types';
import { getActiveTransport } from '../../core/transport/types';
import {
  buildAlipanAuthString,
  getAlipanAuthString,
  parseAlipanAuthString,
  patchAlipanStore,
  readAlipanStore,
  setAlipanSessionAuth,
  writeAlipanStore,
  type AlipanAuth,
  type AlipanStoreRecord,
} from './auth';

export type { AlipanStoreRecord };

/** files 映射容量上限（防单账号无限增长；超出时丢最早写入的条目） */
export const ALIPAN_CARRY_MAX_FILES = 500;

/** 滚动更新过期判定结果（进解析日志，便于排查；话术不进这里） */
export type AlipanCarryExpireReason =
  | 'no-cache' // 本地无记录 → 滚动更新无从谈起，不提示（规格 3 前提）
  | 'credential-hit' // 后端命中同账号 → 静默续杯
  | 'credential-unavailable' // 直连 / 无代理地址（没有 functions 可问）
  | 'credential-unreachable' // functions/backend 不可达（网络错误 / 非 2xx）
  | 'credential-unimplemented' // 端点未实现（404/501；老部署）
  | 'credential-guest' // 后端在，但没有这个账号（只能游客/占位）
  | 'credential-none' // 后端明确无托管（无号 / 未配置）
  | 'no-account'; // 本次 auth 解不出账号身份，无法比对（保守归入提示）

/** 决策结果：silent = 不打扰用户（静默续杯 / 无记录）；notify = 弹红色 toast 提示换新凭据 */
export interface AlipanCarryExpireOutcome {
  action: 'silent' | 'notify';
  reason: AlipanCarryExpireReason;
}

/** 凭据写入前的离线规划（v1.3.1：合并上次暂存 + 必填项检查 + 账号判定） */
export interface AlipanCredentialPlan {
  /**
   * 账号判定：'new' 首次写入 / 'same' 与上次同账号（静默合并）/ 'changed' 换了账号（需弹窗确认覆盖）
   */
  verdict: 'new' | 'same' | 'changed';
  /** 合并后的凭据串（auth + 上次的 drive_id / to_parent_file_id 补齐） */
  merged: string;
  /** 仍缺失的必填项（auth / drive_id / to_parent_file_id）；非空 = 禁止保存（A2：按钮置灰） */
  missing: string[];
  /** 本次 auth 的账号身份（解不出 null） */
  account: string | null;
}

/** 内存态滚动更新（选「否」= 仅本次有效；页面刷新即失效） */
let sessionCarry: { userId: string; files: Record<string, string>; driveId?: string } | null = null;

/* ============================== 账号身份（离线解码） ============================== */

/**
 * 离线解 auth（Bearer JWT）payload 里的账号 id；解不出返回 null。
 * 不校验签名/过期 —— 过期 token 的 payload 仍可读，这正是「凭据过期后仍能辨认账号」的依据。
 * 取字段顺序：userId（阿里 web token 真机字段名）→ user_id → sub → uid。
 */
export function decodeAlipanUserId(authToken: string): string | null {
  const raw = (authToken ?? '').trim().replace(/^Bearer\s+/i, '');
  const payload = raw.split('.')[1];
  if (!payload) return null;
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    let json: string;
    try {
      // UTF-8 解码（等效 atob + decodeURIComponent 组合，但不依赖已废弃的 escape）
      json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    } catch {
      json = bin;
    }
    const claims = JSON.parse(json) as Record<string, unknown>;
    for (const key of ['userId', 'user_id', 'sub', 'uid']) {
      const v = claims[key];
      if (typeof v === 'string' && v) return v;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 账号身份串（记录比对键）：优先 JWT userId；解不出时降级 `drive:<drive_id>`
 * （drive_id 是凭据必填项、同账号稳定 —— 保证「换号」判定与续杯在 token 无 user 声明时仍可用）。
 * auth 为空返回 null。
 */
export function alipanAccountKey(auth: string | AlipanAuth): string | null {
  const parsed = typeof auth === 'string' ? parseAlipanAuthString(auth) : auth;
  if (!parsed.auth) return null;
  const userId = decodeAlipanUserId(parsed.auth);
  if (userId) return userId;
  return parsed.driveId ? `drive:${parsed.driveId}` : null;
}

/* ============================== 统一记录读写 ============================== */

/** 读取滚动更新记录（= 统一存储记录）；无/损坏返回 null */
export function getAlipanCarry(): AlipanStoreRecord | null {
  return readAlipanStore();
}

/** 清除记录（凭据 + 映射一并清） */
export function clearAlipanCarry(): void {
  writeAlipanStore(null);
  sessionCarry = null;
  setAlipanSessionAuth(null);
}

/**
 * 写回本次转存的映射（原分享 file_id → 转存后 file_id）。
 * - 内存态（选「否」）且账号一致 → 只更新内存映射（不写库，避免污染上一个账号的记录）
 * - 内存态但账号不同 → 不写（本次输入仅本次有效）
 * - 正常模式 → 账号变化整条重置（旧映射属旧账号）；同账号保留既有映射继续续杯
 */
export function rememberAlipanCarriedFiles(
  accountKey: string | null,
  driveId: string | undefined,
  mapping: Record<string, string>,
): void {
  const entries = Object.entries(mapping).filter(([, v]) => v);
  if (entries.length === 0) return;
  // 内存态分支
  if (sessionCarry) {
    if (accountKey && sessionCarry.userId === accountKey) {
      for (const [src, dst] of entries) sessionCarry.files[src] = dst;
    }
    return;
  }
  if (!accountKey) return;
  const prev = readAlipanStore();
  const files: Record<string, string> = prev && prev.lastUserId === accountKey ? { ...prev.files } : {};
  for (const [srcFid, newFid] of entries) files[srcFid] = newFid;
  const keys = Object.keys(files);
  if (keys.length > ALIPAN_CARRY_MAX_FILES) {
    for (const stale of keys.slice(0, keys.length - ALIPAN_CARRY_MAX_FILES)) delete files[stale];
  }
  // driveId 一并对齐（转存响应回传的 drive_id 可作兜底写入）
  patchAlipanStore(driveId && prev?.driveId !== driveId ? { files, driveId } : { files });
}

/**
 * 缓存命中查询：账号一致且映射存在时给出「转存后 file_id + 该映射所属 drive_id」；
 * 否则 undefined（= 走正常转存两跳）。内存态优先（本次会话内的续杯）。
 */
export function carriedTargetOf(
  accountKey: string | null,
  srcFid: string,
): { fileId: string; driveId?: string } | undefined {
  if (!accountKey) return undefined;
  if (sessionCarry && sessionCarry.userId === accountKey) {
    const fileId = sessionCarry.files[srcFid];
    return fileId ? { fileId, driveId: sessionCarry.driveId } : undefined;
  }
  const rec = readAlipanStore();
  if (!rec || rec.lastUserId !== accountKey) return undefined;
  const fileId = rec.files[srcFid];
  return fileId ? { fileId, driveId: rec.driveId } : undefined;
}

/** 本次失败码是否属于「auth 过期」（滚动更新触发判据；判定后不重试） */
export function isAlipanExpiredAuthCode(code: number | string | undefined): boolean {
  return code !== undefined && ALIPAN_CARRY_EXPIRED_CODES.includes(String(code));
}

/** 失败码是否属于「转存副本已失效」（被删/进回收站）→ 回退重新转存 */
export function isAlipanStaleCopyCode(code: number | string | undefined): boolean {
  return code !== undefined && ALIPAN_CARRY_STALE_CODES.includes(String(code));
}

/* ============================== 凭据快捷更新（A） ============================== */

/** 必填项（A2：缺失则弹窗小字提示 + 保存按钮置灰，且不写入、不发起 prase） */
export const ALIPAN_REQUIRED_AUTH_KEYS = ['auth', 'drive_id', 'to_parent_file_id'] as const;

/**
 * 凭据写入前的**离线**规划（不请求任何接口，也不写库）：
 * 1. 解析用户输入（支持只粘贴 `Bearer xxx`）；
 * 2. **同账号**时用上次暂存的 drive_id / to_parent_file_id 补齐（Tzz：已缓存了怎么不直接用上次的）；
 * 3. 算出仍缺失的必填项；4. 判定账号是否变化（'changed' → UI 弹「是否覆盖当前暂存区的 userid」）。
 */
export function planAlipanCredentialSave(input: string): AlipanCredentialPlan {
  const src = (input ?? '').trim();
  const parsed = parseAlipanAuthString(src);
  const prev = readAlipanStore();
  const account = parsed.auth ? alipanAccountKey(parsed) : null;
  const sameAccount = Boolean(account && prev?.lastUserId && account === prev.lastUserId);
  const prevAuth = sameAccount && prev?.lastAuth ? parseAlipanAuthString(prev.lastAuth) : null;

  const map: Record<string, string> = {};
  if (parsed.auth) map.auth = /^Bearer\s/i.test(parsed.auth) ? parsed.auth : `Bearer ${parsed.auth}`;
  const driveId = parsed.driveId ?? prevAuth?.driveId;
  const toParentFileId = parsed.toParentFileId || prevAuth?.toParentFileId || '';
  if (driveId) map.drive_id = driveId;
  if (toParentFileId) map.to_parent_file_id = toParentFileId;
  if (parsed.userAgent) map['user-agent'] = parsed.userAgent;
  if (parsed.xDeviceId) map['x-device-id'] = parsed.xDeviceId;

  const missing = ALIPAN_REQUIRED_AUTH_KEYS.filter((k) => !map[k]);
  return {
    verdict: !account || !prev?.lastUserId ? 'new' : sameAccount ? 'same' : 'changed',
    merged: buildAlipanAuthString(map),
    missing: [...missing],
    account,
  };
}

/**
 * 应用写入决策（Tzz 定稿：账号变了才需要选择）：
 * - 'persist'（选「是」/ 同账号）：覆盖暂存记录；换号则**整条重置** files（旧映射属旧账号）
 * - 'session'（选「否」）：仅写内存态，本次有效；刷新即失效，不写 localStorage、不进后端统计
 * 必填项不全（plan.missing 非空）直接返回 —— 不写入、不惊动 functions（A2）。
 */
export function applyAlipanCredentialSave(plan: AlipanCredentialPlan, mode: 'persist' | 'session'): void {
  if (plan.missing.length > 0 || !plan.merged) return;
  const parsed = parseAlipanAuthString(plan.merged);
  if (mode === 'session') {
    setAlipanSessionAuth(plan.merged);
    sessionCarry = { userId: plan.account ?? '', files: {}, driveId: parsed.driveId };
    return;
  }
  setAlipanSessionAuth(null);
  sessionCarry = null;
  const prev = readAlipanStore();
  const sameAccount = Boolean(plan.account && prev?.lastUserId === plan.account);
  writeAlipanStore({
    lastUserId: plan.account ?? '',
    lastAuth: plan.merged,
    driveId: parsed.driveId,
    toParentFileId: parsed.toParentFileId || undefined,
    updateAt: Date.now(),
    files: sameAccount ? (prev?.files ?? {}) : {},
  });
}

/**
 * 用户填入新凭据后的**离线**校验（规格 4：不请求任何接口）：
 * 'same' = 与上次账号一致（绿字）/ 'other' = 换号（红字）/ null = 无记录或无法判定（不提示）
 */
export function checkAlipanCarryNewAuth(authString: string): 'same' | 'other' | null {
  const rec = readAlipanStore();
  if (!rec?.lastUserId) return null;
  const account = alipanAccountKey(authString);
  if (!account) return null; // 还没填完整/解不出身份 → 不判定，不打扰
  return account === rec.lastUserId ? 'same' : 'other';
}

/* ========================= ==== 触发判定（凭据探测） ============================ */

/**
 * auth 过期后的决策（规格 3）：本地有记录 + 已发出的一次请求失败（不重试）时调用。
 * v1.3.1·D1 定稿（Tzz：凭据不下发 SPA）：探测**走 functions**（`transport.credentialProbe`
 * → `POST {代理}/api/credential-pick`），SPA 不直连 hop/backend，也拿不到账号集合：
 *   命中同账号（hit）→ 'silent'（静默续杯：换上新凭据即可复用记录，无需重新转存）
 *   guest / none / 未配置 / 不可达 / 未实现 / 解不出身份 → 'notify'（红色 toast，文案取
 *   ALIPAN_CARRY_MESSAGES.expiredToast）。
 */
export async function onAlipanExpired(): Promise<AlipanCarryExpireOutcome> {
  const rec = readAlipanStore();
  if (!rec?.lastUserId) return { action: 'silent', reason: 'no-cache' };
  const account = alipanAccountKey(getAlipanAuthString());
  const transport = getActiveTransport();
  const probe = transport.credentialProbe?.bind(transport);
  // 直连（或未实现的传输）没有探测能力 → 无托管
  if (!probe) return { action: 'notify', reason: 'credential-unavailable' };
  const res = await probe(ALIPAN_CREDENTIAL_PROVIDER, account ?? undefined);
  if (!res.ok) {
    // 失败原因逐项映射（不用类型断言：传输层词表与 alipan 日志词表解耦）
    const reason: AlipanCarryExpireReason =
      res.reason === 'unavailable'
        ? 'credential-unavailable'
        : res.reason === 'unimplemented'
          ? 'credential-unimplemented'
          : 'credential-unreachable';
    return { action: 'notify', reason };
  }
  if (!account) return { action: 'notify', reason: 'no-account' };
  if (res.credential === 'hit') return { action: 'silent', reason: 'credential-hit' };
  return {
    action: 'notify',
    reason: res.credential === 'guest' ? 'credential-guest' : 'credential-none',
  };
}
