/**
 * 结构化日志（docs/backend-wrangler-plan.md §4.1 保留，新增 wrangler 行解析入口）
 *
 * - 内存环形缓冲（1000 条，实时日志页轮询读取，零 DB 压力）
 * - debug 级完整 trace 进 data/tmp/debug-*.log（权限 600，按天轮转，保留 7 天）
 * - wrangler stdout 行聚合：正则解析 → 环形缓冲 + proxy_logs（via='wrangler'）；
 *   解析失败整行原文入库，不丢数据
 */
import { appendFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { TMP_DIR } from './config.js';

const RING_LIMIT = 1000;
const DEBUG_KEEP_DAYS = 7;

/** 环形缓冲（新→旧） */
let ring = [];

/** 级别排序权重 */
const LEVELS = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4 };

/**
 * 写日志：入环形缓冲 + 终端输出 + debug 级落文件。
 * @param level fatal|error|warn|info|debug
 * @param msg   消息（可含 \n）
 * @param meta  { pan?, operation?, queuedMs?, durationMs?, accountId?, via?, console? }
 *              console=true 时强制打到终端（info 级默认静默，连接/断开等生命周期事件用它）
 */
export function log(level, msg, meta = {}) {
  const entry = { ts: Date.now(), level, msg: String(msg), ...meta };
  ring = [entry, ...ring].slice(0, RING_LIMIT);
  const showOnTerminal = LEVELS[level] <= LEVELS.warn || meta.console === true;
  if (showOnTerminal) {
    const out = level === 'fatal' || level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    console[out](
      `[${new Date(entry.ts).toISOString().slice(11, 19)}][${level}] ${entry.msg.split('\n')[0]}`,
    );
  }
  if (level === 'debug') {
    writeDebugFile(entry);
  }
  return entry;
}

/** 读最近 N 条（可按级别/网盘/来源/关键字过滤） */
export function listLogs({ limit = 200, level, pan, via, q } = {}) {
  let out = ring;
  if (level && LEVELS[level] !== undefined) out = out.filter((e) => LEVELS[e.level] <= LEVELS[level]);
  if (pan) out = out.filter((e) => e.pan === pan);
  if (via) out = out.filter((e) => e.via === via);
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

/* ---------------- wrangler stdout 行解析（P1：stdout 聚合，via='wrangler'） ---------------- */

/**
 * wrangler pages dev 的请求日志行（实测格式）：
 *   [wrangler:info] POST /api/proxy 200 OK (97ms)
 *   [wrangler:info] GET / 200 OK (97ms)
 *   [wrangler:info] POST /api/proxy 401 Unauthorized (39ms)
 *   [wrangler:error] ...
 * 解析成功 → 结构化落库 + 环形缓冲；失败 → 整行原文落库（不丢数据）。
 */
const WRANGLER_LINE_RE = /^\[wrangler:(info|warn|error|log)\]\s+(?:(\S+)\s+)?(\S+)\s+(\d{3})\s+([^(]+?)\s*\((\d+)ms\)\s*$/;

/** 落库一条 wrangler 行（via='wrangler'；解析失败整行原文） */
export function ingestWranglerLine(line) {
  const text = String(line ?? '').trim();
  if (!text) return;
  const entry = { ts: Date.now(), level: 'info', msg: text, via: 'wrangler' };
  const m = text.match(WRANGLER_LINE_RE);
  if (m) {
    const [, level, method, path, status, note, ms] = m;
    entry.level = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
    entry.method = method ?? '';
    entry.path = path ?? '';
    entry.req_status = Number(status);
    entry.durationMs = Number(ms);
    entry.msg = `[wrangler] ${method ?? ''} ${path} ${status} ${note.trim()} (${ms}ms)`;
  }
  ring = [entry, ...ring].slice(0, RING_LIMIT);
  // 落库（via='wrangler'，与 hop 捕获共用 proxy_logs；解析失败的整行原文也入库）
  try {
    const { getDb } = awaitImportDb();
    getDb()
      .prepare(
        'INSERT INTO proxy_logs (ts, pan, operation, method, url, req_status, duration_ms, account_id, queued_ms, client_ip, req_headers, resp_headers, body_preview, via) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        entry.ts,
        entry.pan ?? null,
        entry.operation ?? null,
        m ? m[2] ?? null : null,
        m ? m[3] ?? null : null,
        entry.req_status ?? null,
        entry.durationMs ?? null,
        null, 0, null, '', '', '',
        'wrangler',
      );
  } catch {
    /* 落库失败不阻断 */
  }
  return entry;
}

/** 延迟引入 db（避免循环依赖：db.js 不依赖 log.js） */
let _dbPromise = null;
function awaitImportDb() {
  if (!_dbPromise) _dbPromise = import('./db.js');
  return _dbPromise;
}

/* ---------------- debug 完整 trace 文件（data/tmp/debug-*.log，600） ---------------- */

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

/**
 * 完整 trace 落 debug 文件（hop 全量 trace 用：请求头/请求体/响应头/响应体 + 命中账号 + 耗时）。
 * 不进环形缓冲（避免 64KB 级 body 撑爆内存），只落 data/tmp/debug-*.log（600，7 天轮转）。
 */
export function writeDebugTrace(obj) {
  try {
    if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
    const line = JSON.stringify({ ts: Date.now(), ...obj });
    appendFileSync(debugFilePath(), line + '\n', { mode: 0o600 });
    rotateDebugFiles();
  } catch {
    /* 磁盘满等异常静默 */
  }
}
