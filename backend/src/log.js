/**
 * 结构化日志（docs/selfhost-node.md §4.5）
 *
 * - 内存环形缓冲（1000 条，实时日志页轮询读取，零 DB 压力）
 * - 调用级落库走 db.js 的 proxy_logs（proxy.js 调用）；一般日志 v1 不落库
 * - debug 级完整响应头进 data/tmp/debug-*.log（权限 600，按天轮转，保留 7 天）
 */
import { appendFileSync, mkdirSync, existsSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TMP_DIR } from './config.js';

const RING_LIMIT = 1000;
const DEBUG_KEEP_DAYS = 7;

/** 环形缓冲（新→旧） */
let ring = [];

/** 级别排序权重 */
const LEVELS = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4 };

/**
 * 写日志：入环形缓冲 + debug 级落文件。
 * @param level fatal|error|warn|info|debug
 * @param msg   消息（可含 \n）
 * @param meta  { pan?, operation?, queuedMs?, durationMs?, accountId? }
 */
export function log(level, msg, meta = {}) {
  const entry = { ts: Date.now(), level, msg: String(msg), ...meta };
  ring = [entry, ...ring].slice(0, RING_LIMIT);
  if (LEVELS[level] <= LEVELS.warn) {
    console[level === 'fatal' || level === 'error' ? 'error' : 'warn'](
      `[${new Date(entry.ts).toISOString().slice(11, 19)}][${level}] ${entry.msg.split('\n')[0]}`,
    );
  }
  if (level === 'debug') {
    writeDebugFile(entry);
  }
  return entry;
}

/** 读最近 N 条（可按级别/网盘/关键字过滤） */
export function listLogs({ limit = 200, level, pan, q } = {}) {
  let out = ring;
  if (level && LEVELS[level] !== undefined) out = out.filter((e) => LEVELS[e.level] <= LEVELS[level]);
  if (pan) out = out.filter((e) => e.pan === pan);
  if (q) {
    const kw = q.toLowerCase();
    out = out.filter((e) => e.msg.toLowerCase().includes(kw));
  }
  return out.slice(0, limit);
}

/** 队列状态快照（实时日志页 debug 级展示） */
let queueState = { queued: 0, running: 0, longestMs: 0 };
export function setQueueState(s) {
  queueState = { ...queueState, ...s };
}
export function getQueueState() {
  return queueState;
}

/* ---------------- debug 完整头文件（魔鬼测试核心，data/tmp/） ---------------- */

function debugFilePath() {
  const d = new Date().toISOString().slice(0, 10);
  return join(TMP_DIR, `debug-${d}.log`);
}

function writeDebugFile(entry) {
  try {
    if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
    const line = JSON.stringify(entry);
    appendFileSync(debugFilePath(), line + '\n', { mode: 0o600 });
    rotateDebugFiles();
  } catch {
    /* 磁盘满等异常静默 */
  }
}

/** 按天轮转 + 清理超过保留天数的 debug 文件 */
function rotateDebugFiles() {
  try {
    const cutoff = Date.now() - DEBUG_KEEP_DAYS * 86400_000;
    for (const name of readdirSync(TMP_DIR)) {
      if (!name.startsWith('debug-')) continue;
      const p = join(TMP_DIR, name);
      if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
    }
  } catch {
    /* ignore */
  }
}

/** 清空环形缓冲（调试用） */
export function clearRing() {
  ring = [];
}
