/**
 * 足迹：完整解析日志（docs/STRUCTURE.md：src/core/footprint/logs.ts）—— 重点模块
 *
 * 存储：独立 store 'logs'，仅本地；5MB 轮转（默认，可传 maxMB），超限按 time 删最旧。
 * 脱敏：写入前过 redactSensitive —— cookie / ctoken / __pugs / __sdid / b-user-id / stoken
 *       等凭据类字段整体替换为 '~~***~~'（既是占位符，也是 Markdown 删除线语法，
 *       导出 md 时天然呈现"删除线"效果，符合 HANDOFF §3.2 第 4 条"cookie 用删除线标记"）。
 * 导出：文件名 {链接缩写}_{YYYYMMDD-HHmmss}_{状态}.log（s=成功 e=失败 u=未知 m=部分成功），
 *       文件头带元数据（状态/条数/等级/时间范围/脱敏声明），正文逐条 [time] [level] message。
 */
import type { LogEntry } from '../types';
import { STORE_LOGS, dbAdd, dbClear, dbDeleteBatch, dbGetAll, dbGetAllByIndex, getDb } from './db';

/** 默认日志上限 MB（与足迹偏好 FootprintPrefs.logMaxMB 默认一致，见 HANDOFF 附件 §3.4） */
export const DEFAULT_LOG_MAX_MB = 5;

/** 日志导出状态（HANDOFF：s=成功 e=失败 u=未知 m=部分成功） */
export type LogStatus = 's' | 'e' | 'u' | 'm';

/** 状态 → 中文说明 */
const STATUS_LABEL: Record<LogStatus, string> = {
  s: '成功',
  e: '失败',
  u: '未知错误',
  m: '部分成功',
};

/** 敏感键名（cookie 类凭据，命中即整段脱敏，保证日志无明文凭据） */
const SENSITIVE_KEYS = 'cookie|ctoken|__pugs|__sdid|b-user-id|stoken';

/** k=v 形式：cookie=xxx、__pugs=xxx、stoken=xxx（key 允许带引号与后缀字符） */
const SENSITIVE_KV_RE = new RegExp(`["']?(?:${SENSITIVE_KEYS})[^\\s=;,'"]*\\s*=\\s*[^\\s,;]+`, 'gi');

/** JSON 键值形式："cookie":"xxx"、'ctoken':'xxx' */
const SENSITIVE_JSON_RE = new RegExp(`["']?(?:${SENSITIVE_KEYS})["']\\s*:\\s*["'][^"']*["']`, 'gi');

/** HTTP 头形式：Cookie: xxx、Set-Cookie: xxx */
const SENSITIVE_HEADER_RE = new RegExp(`(?:${SENSITIVE_KEYS})\\s*:\\s*[^\\s,;]+`, 'gi');

/** 脱敏占位符（Markdown 删除线语法：~~***~~） */
const REDACTED = '~~***~~';

/**
 * 日志脱敏：将 cookie 类凭据字段替换为 '~~***~~'。
 * 依次处理 k=v / JSON 键值 / HTTP 头 三种形态，保证任何明文凭据不出现在日志里。
 */
export function redactSensitive(text: string): string {
  if (!text) return text;
  let out = text.replace(SENSITIVE_KV_RE, REDACTED);
  out = out.replace(SENSITIVE_JSON_RE, REDACTED);
  out = out.replace(SENSITIVE_HEADER_RE, REDACTED);
  return out;
}

/** 估算单条日志体积（JSON 序列化字节长度，含自增 id，用作轮转依据） */
function estimateEntryBytes(entry: LogEntry): number {
  return JSON.stringify(entry).length;
}

/**
 * 追加一条日志：写入前强制脱敏，写完后按 maxMB 轮转。
 * @param maxMB 日志上限（默认 5MB），与足迹偏好 logMaxMB 联动
 */
export async function appendLog(entry: Omit<LogEntry, 'id'>, maxMB = DEFAULT_LOG_MAX_MB): Promise<void> {
  const safe: Omit<LogEntry, 'id'> = { ...entry, message: redactSensitive(entry.message) };
  const db = await getDb();
  await dbAdd(db, STORE_LOGS, safe);
  await rotateLogs(maxMB);
}

/**
 * 轮转：逐条估算体积（JSON 长度），总量超过 maxMB 时从最旧（time 最小）开始删，直到达标。
 * 至少保留最新一条（避免刚写入的日志立刻被删光）。返回删除条数。
 */
export async function rotateLogs(maxMB = DEFAULT_LOG_MAX_MB): Promise<number> {
  const maxBytes = maxMB * 1024 * 1024;
  const db = await getDb();
  // time 正序 = 最旧在前
  const all = await dbGetAllByIndex<LogEntry>(db, STORE_LOGS, 'time', { direction: 'next' });
  if (all.length === 0) return 0;
  const items = all.map((e) => ({ id: e.id as number, bytes: estimateEntryBytes(e) }));
  let total = items.reduce((sum, item) => sum + item.bytes, 0);
  if (total <= maxBytes) return 0;
  const toDelete: number[] = [];
  for (const item of items) {
    if (total <= maxBytes || toDelete.length >= all.length - 1) break; // 至少留最新一条
    toDelete.push(item.id);
    total -= item.bytes;
  }
  if (toDelete.length === 0) return 0;
  await dbDeleteBatch(db, STORE_LOGS, toDelete);
  return toDelete.length;
}

/** 最近日志列表（time 倒序，最新在前；limit 默认 100） */
export function listLogs(limit = 100): Promise<LogEntry[]> {
  return getDb().then((db) => dbGetAllByIndex<LogEntry>(db, STORE_LOGS, 'time', { direction: 'prev', limit }));
}

/** 删除某链接的全部日志（历史页"删除链接"连带清理，1.1） */
export async function removeLogsByUrl(url: string): Promise<void> {
  const db = await getDb();
  const all = await dbGetAll<LogEntry>(db, STORE_LOGS);
  const ids = all.filter((l) => l.url === url).map((l) => l.id as number);
  if (ids.length > 0) {
    await dbDeleteBatch(db, STORE_LOGS, ids);
  }
}

/** 清空全部日志 */
export async function clearLogs(): Promise<void> {
  const db = await getDb();
  await dbClear(db, STORE_LOGS);
}

/** 时间戳 → YYYYMMDD-HHmmss（本地时区；日志文件名用） */
function formatStamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 时间戳 → YYYY-MM-DD HH:mm:ss（文件头与逐条日志用） */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 导出 md 格式日志：
 * - 文件名 {abbr}_{YYYYMMDD-HHmmss}_{status}.log（时间戳取日志中最新一条，无日志用当前时间）
 * - 文件头元数据（链接缩写/状态/条数/等级/时间范围/导出时间/脱敏声明）+ 逐条 [time] [level] message
 * - message 已脱敏，~~***~~ 呈现为 Markdown 删除线
 */
export function exportLogsMd(abbr: string, status: LogStatus, logs: LogEntry[]): { fileName: string; content: string } {
  const latestTs = logs.length > 0 ? Math.max(...logs.map((l) => l.time)) : Date.now();
  const firstTs = logs.length > 0 ? Math.min(...logs.map((l) => l.time)) : latestTs;
  const levels = [...new Set(logs.map((l) => l.level))].join('/') || '—';
  const header = [
    '# 云链解析站 解析日志',
    '',
    `- 链接缩写：${abbr}`,
    `- 状态：${STATUS_LABEL[status]}（${status}）`,
    `- 日志条数：${logs.length}`,
    `- 日志等级：${levels}`,
    `- 时间范围：${formatTime(firstTs)} ~ ${formatTime(latestTs)}`,
    `- 导出时间：${formatTime(Date.now())}`,
    `- 脱敏声明：cookie / ctoken / __pugs / __sdid / b-user-id / stoken 等凭据类字段已替换为 ~~***~~（Markdown 删除线），求助时请勿明文粘贴 cookie。`,
    '',
    '---',
    '',
  ].join('\n');
  const body = logs.map((l) => `[${formatTime(l.time)}] [${l.level}] ${l.message}`).join('\n');
  return {
    fileName: `${abbr}_${formatStamp(latestTs)}_${status}.log`,
    content: header + body + (body ? '\n' : ''),
  };
}
