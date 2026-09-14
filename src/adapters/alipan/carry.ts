/**
 * 阿里云盘滚动更新（carry-over）缓存（docs/STRUCTURE.md：src/adapters/alipan/carry.ts，v1.3）
 *
 * 为什么要有这一层（Tzz 定稿）：alipan prase = 先转存（copy）再取直链，直链仅 15min 有效，
 * 反复解析会反复 copy（占空间、易「空间满了」）；而用户 auth（access_token）≈2h 有效。
 * 因此同账号在 auth 生命周期内重解析时，应复用上次 copy 得到的 file_id 直接取直链（「续杯」），
 * 跳过 copy。
 *
 * 缓存（键与形态由 Tzz 定稿）：`pan-web:alipan-carry:v1`
 *   { userId, driveId, files: { <原分享 file_id>: <转存后 file_id> }, updatedAt }
 *
 * 存储层选型（**不用 core/footprint 的 IndexedDB，改 localStorage 包装**，理由）：
 * 1) 分层：core/ 是「零网盘依赖」层，本缓存是 alipan 专属（原分享 file_id → 本账号转存 file_id），
 *    放进 core/footprint 会污染该约束；db.ts 的新 store 还要 DB_VERSION 2→3 迁移全体用户库。
 * 2) 形态：footprint 是**用户可见的足迹**（历史/日志/快照，多记录 + 索引 + 轮转）；
 *    本缓存是**单条内部状态**（一个账号一份映射，无查询需求），IndexedDB 的索引/事务能力用不上。
 * 3) 一致性：alipan 的登录态凭据（auth.ts）与 __pugs 类凭据（quark/cookies.ts）都在 localStorage，
 *    缓存放同一层 = 同域同风格，用户/开发者排查与清理只在一个地方（「好找」）。
 *    数据量也匹配：单条记录 + files 上限（ALIPAN_CARRY_MAX_FILES）≪ localStorage 配额。
 *
 * 账号身份（userId）：**离线**解 auth（Bearer JWT）的 payload（atob + UTF-8 解码），
 * 不请求任何接口（规格 4 要求离线比对）。
 * TODO(真机)：阿里云盘 web token 的账号声明字段名待真机核对（当前按 user_id → userId → sub → uid
 * 依次取；解不出时降级用 `drive:<drive_id>`，见 alipanAccountKey）。
 */
import {
  ALIPAN_CARRY_EXPIRED_CODES,
  ALIPAN_CARRY_STORAGE_KEY,
  ALIPAN_HOP_PROVIDER,
} from './types';
import { getActiveTransport } from '../../core/transport/types';
import { getAlipanAuthString, parseAlipanAuthString, type AlipanAuth } from './auth';

/** 缓存形态（键 pan-web:alipan-carry:v1 的值） */
export interface AlipanCarryCache {
  /** 账号身份（JWT 的 user_id；解不出时 `drive:<drive_id>` 降级，见文件头） */
  userId: string;
  /** 账号 drive_id（copy 显式 to_drive_id / 取直链用；可缺省） */
  driveId?: string;
  /** 原分享 file_id → 转存后 file_id */
  files: Record<string, string>;
  /** 最近一次写入时间 ms */
  updatedAt: number;
}

/** files 映射容量上限（防单账号无限增长；超出时丢最早写入的条目） */
export const ALIPAN_CARRY_MAX_FILES = 500;

/** 滚动更新过期判定结果（进解析日志，便于排查；话术不进这里） */
export type AlipanCarryExpireReason =
  | 'no-cache' // 本地无缓存 → 滚动更新无从谈起，不提示（规格 3 前提）
  | 'hop-hit' // hop 命中同账号 → 静默续杯
  | 'hop-unavailable' // 未配置 hop（直连 / 无代理地址）
  | 'hop-unreachable' // hop 不可达（网络错误 / 非 2xx）
  | 'hop-unimplemented' // hop 端点未实现（404/501；后端待补）
  | 'hop-empty' // hop 返回空账号集合
  | 'hop-miss' // hop 账号集合不含本次缓存的账号
  | 'no-account'; // 本次 auth 解不出账号身份，无法比对（保守归入提示）

/** 决策结果：silent = 不打扰用户（静默续杯 / 无缓存）；notify = 弹红色 toast 提示换新凭据 */
export interface AlipanCarryExpireOutcome {
  action: 'silent' | 'notify';
  reason: AlipanCarryExpireReason;
}

/* ============================== 账号身份（离线解码） ============================== */

/**
 * 离线解 auth（Bearer JWT）payload 里的账号 id；解不出返回 null。
 * 不校验签名/过期 —— 过期 token 的 payload 仍可读，这正是「凭据过期后仍能辨认账号」的依据。
 * 取字段顺序：user_id → userId → sub → uid（阿里云盘 web token 字段名待真机核对）。
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
    for (const key of ['user_id', 'userId', 'sub', 'uid']) {
      const v = claims[key];
      if (typeof v === 'string' && v) return v;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 账号身份串（缓存比对键）：优先 JWT userId；解不出时降级用 `drive:<drive_id>`
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

/* ============================== 缓存读写 ============================== */

/** 读取滚动更新缓存；无/损坏返回 null */
export function getAlipanCarry(): AlipanCarryCache | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(ALIPAN_CARRY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AlipanCarryCache> | null;
    if (!parsed || typeof parsed.userId !== 'string' || !parsed.userId) return null;
    const files: Record<string, string> = {};
    const src = parsed.files && typeof parsed.files === 'object' ? (parsed.files as Record<string, unknown>) : {};
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === 'string' && v) files[k] = v;
    }
    return {
      userId: parsed.userId,
      driveId: typeof parsed.driveId === 'string' && parsed.driveId ? parsed.driveId : undefined,
      files,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    };
  } catch {
    return null; // 解析失败按「无缓存」处理，不影响主流程
  }
}

/** 写入滚动更新缓存（userId 为空 = 清除） */
export function setAlipanCarry(cache: AlipanCarryCache | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (!cache || !cache.userId) {
      window.localStorage.removeItem(ALIPAN_CARRY_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(ALIPAN_CARRY_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // 配额/隐私模式异常静默
  }
}

/** 清除缓存（换号 / 清空足迹时可用） */
export function clearAlipanCarry(): void {
  setAlipanCarry(null);
}

/**
 * 写回本次 copy 的映射（原分享 file_id → 转存后 file_id）。
 * 账号变化 = 整条重置（旧映射属旧账号，新账号不可用）；容量超限丢最早写入的条目。
 */
export function rememberAlipanCarriedFiles(
  accountKey: string | null,
  driveId: string | undefined,
  mapping: Record<string, string>,
): void {
  const entries = Object.entries(mapping).filter(([, v]) => v);
  if (!accountKey || entries.length === 0) return;
  const prev = getAlipanCarry();
  const files: Record<string, string> = prev && prev.userId === accountKey ? { ...prev.files } : {};
  for (const [srcFid, newFid] of entries) files[srcFid] = newFid;
  const keys = Object.keys(files);
  if (keys.length > ALIPAN_CARRY_MAX_FILES) {
    for (const stale of keys.slice(0, keys.length - ALIPAN_CARRY_MAX_FILES)) delete files[stale];
  }
  setAlipanCarry({ userId: accountKey, driveId, files, updatedAt: Date.now() });
}

/**
 * 缓存命中查询：账号一致且映射存在时给出「转存后 file_id + 该映射所属 drive_id」；
 * 否则 undefined（= 走正常 copy 两跳）。
 */
export function carriedTargetOf(
  accountKey: string | null,
  srcFid: string,
): { fileId: string; driveId?: string } | undefined {
  if (!accountKey) return undefined;
  const cache = getAlipanCarry();
  if (!cache || cache.userId !== accountKey) return undefined;
  const fileId = cache.files[srcFid];
  return fileId ? { fileId, driveId: cache.driveId } : undefined;
}

/** 本次失败码是否属于「auth 过期」（滚动更新触发判据；判定后不重试） */
export function isAlipanExpiredAuthCode(code: number | string | undefined): boolean {
  return code !== undefined && ALIPAN_CARRY_EXPIRED_CODES.includes(String(code));
}

/* ============================== 触发判定与凭据校验 ============================== */

/**
 * 用户填入新凭据后的**离线**校验（规格 4：不请求任何接口）：
 * 'same' = 与缓存同账号（绿字）/ 'other' = 换号（红字）/ null = 无缓存或无法判定（不提示）
 */
export function checkAlipanCarryNewAuth(authString: string): 'same' | 'other' | null {
  const cache = getAlipanCarry();
  if (!cache) return null;
  const account = alipanAccountKey(authString);
  if (!account) return null; // 还没填完整/解不出身份 → 不判定，不打扰
  return account === cache.userId ? 'same' : 'other';
}

/**
 * auth 过期后的决策（规格 3）：本地有缓存 + 已发出的一次请求失败（不重试）时调用。
 * 用**本次 auth 的账号身份**试探 hop（后端未实现 → 安全降级到「提示」）：
 *   命中同账号 → 'silent'（静默续杯：换上新凭据即可复用缓存，无需重新转存）
 *   未配置/不可达/未实现/返回空/不含该账号 → 'notify'（红色 toast，文案取 ALIPAN_CARRY_MESSAGES）
 */
export async function onAlipanExpired(): Promise<AlipanCarryExpireOutcome> {
  const cache = getAlipanCarry();
  if (!cache) return { action: 'silent', reason: 'no-cache' };
  const account = alipanAccountKey(getAlipanAuthString());
  const transport = getActiveTransport();
  const probe = transport.hopAccounts?.bind(transport);
  // 直连（或未实现的传输）没有 hop → 未找到 hop
  if (!probe) return { action: 'notify', reason: 'hop-unavailable' };
  const res = await probe(ALIPAN_HOP_PROVIDER, account ?? undefined);
  if (!res.ok) {
    // 失败原因逐项映射（不用类型断言：传输层词表与 alipan 日志词表解耦）
    const reason: AlipanCarryExpireReason =
      res.reason === 'unavailable'
        ? 'hop-unavailable'
        : res.reason === 'unreachable'
          ? 'hop-unreachable'
          : res.reason === 'empty'
            ? 'hop-empty'
            : 'hop-unimplemented';
    return { action: 'notify', reason };
  }
  if (!account) return { action: 'notify', reason: 'no-account' };
  return res.accounts.includes(account)
    ? { action: 'silent', reason: 'hop-hit' }
    : { action: 'notify', reason: 'hop-miss' };
}
