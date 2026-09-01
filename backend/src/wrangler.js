/**
 * wrangler 子进程管理（docs/backend-wrangler-plan.md §4.4 新增，v0.1.0-next）
 *
 * 三种能力：
 * 1. spawn：autoSpawn 且 inspector 未监听时，spawn `wrangler pages dev .`
 *    （仓库根 cwd；--binding PROXY_TOKEN:<token> 与 backend 同一把令牌；
 *    --show-interactive-dev-session=false 后台静默，交互面板由 launcher debug 保留）
 * 2. attach：inspector 已在监听（launcher/用户已启动 wrangler）→ 只做消费，不重复 spawn
 * 3. 普通 ws 健康监听（非 CDP）：backend 作 ws 客户端连 wrangler inspector
 *    （需 Origin=devtools 域名才会被接受），仅保活 + 断连自动重连退避，
 *    失败降级 stdout-only —— 供 WebUI 左栏实时显示 health
 *
 * stdout 行解析：`[wrangler:info] POST /api/proxy 200 OK (97ms)` →
 * ingestWranglerLine（环形缓冲 + proxy_logs via='wrangler'，解析失败整行原文入库）
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from './config.js';
import { log, ingestWranglerLine } from './log.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); // backend/
/** 仓库根（wrangler pages dev 的托管目录 = 源码树） */
export const REPO_ROOT = join(ROOT, '..');
/** devtools 前端 Origin（wrangler inspector 只接受该 Origin 的 ws 连接，实测） */
const DEVTOOLS_ORIGIN = 'https://devtools.devprod.cloudflare.dev';

/** 健康状态（WebUI /api/web/info 展示） */
const health = {
  running: false, // 本进程 spawn 的 wrangler 是否存活
  pid: null,
  port: null,
  inspectorPort: null,
  inspectorWs: 'down', // 'connected' | 'connecting' | 'down'
  stdoutLastAt: null, // 最近一行 stdout 时间（防"监听不到"）
  lastLine: '',
  startedAt: null,
  mode: 'attach', // 'spawn' | 'attach' | 'off'
};

let child = null;
let monitorTimer = null;
let reconnectDelay = 1000;
let ws = null;

export function getWranglerHealth() {
  return { ...health };
}

/* ---------------- inspector 探测（普通 HTTP GET /json） ---------------- */

/** 探测 inspector 是否在监听（区分"wrangler 没跑"与"ws 连不上"） */
function probeInspector(port) {
  return fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) })
    .then((r) => (r.ok ? r.json() : null))
    .then((targets) => ({ ok: Array.isArray(targets), targets }))
    .catch(() => ({ ok: false, targets: null }));
}

/* ---------------- 普通 ws 健康监听（非 CDP，只保活） ---------------- */

function inspectorWsUrl(port) {
  return `ws://127.0.0.1:${port}/ws`;
}

function closeWs() {
  if (ws) {
    try {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }
}

/** 连接 inspector ws（保持打开；断连/出错 → 退避重连，失败降级 stdout-only） */
function connectInspectorWs() {
  const port = getConfig().wrangler.inspectorPort;
  if (!port) return;
  closeWs();
  health.inspectorWs = 'connecting';
  let opened = false;
  let w;
  try {
    w = new WebSocket(inspectorWsUrl(port), { headers: { Origin: DEVTOOLS_ORIGIN } });
  } catch {
    scheduleReconnect();
    return;
  }
  ws = w;
  w.onopen = () => {
    opened = true;
    health.inspectorWs = 'connected';
    reconnectDelay = 1000;
    log('info', `wrangler：inspector ws 已连接（ws://127.0.0.1:${port}/ws，仅健康监听，非 CDP）`, { via: 'wrangler', console: true });
  };
  w.onclose = () => {
    if (opened) log('warn', 'wrangler：inspector ws 断开，退避重连中', { via: 'wrangler' });
    health.inspectorWs = 'down';
    scheduleReconnect();
  };
  w.onerror = () => {
    /* onclose 会跟进 */
  };
}

/** 退避重连（1s→2s→4s…封顶 30s；探测失败则降级 stdout-only） */
function scheduleReconnect() {
  if (monitorTimer) return;
  const port = getConfig().wrangler.inspectorPort;
  monitorTimer = setTimeout(async () => {
    monitorTimer = null;
    const probe = await probeInspector(port);
    if (!probe.ok) {
      health.inspectorWs = 'down';
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
      scheduleReconnect();
      return;
    }
    connectInspectorWs();
  }, reconnectDelay);
}

/** 启动健康监听（幂等；attach 与 spawn 都走这里） */
export function startInspectorMonitor() {
  if (monitorTimer || ws) return;
  void (async () => {
    const probe = await probeInspector(getConfig().wrangler.inspectorPort);
    if (probe.ok) {
      health.inspectorWs = 'connecting';
      connectInspectorWs();
    } else {
      health.inspectorWs = 'down';
      log('warn', 'wrangler：inspector 未监听（wrangler 未启动或端口不对），降级 stdout-only 模式', { via: 'wrangler' });
    }
  })();
}

/* ---------------- spawn / attach ---------------- */

/** wrangler 可执行文件路径（root node_modules/.bin/wrangler；找不到则尝试全局命令） */
function resolveWranglerBin() {
  const local = join(REPO_ROOT, 'node_modules', '.bin', 'wrangler');
  if (existsSync(local)) return local;
  return 'wrangler'; // PATH 兜底（用户全局安装）
}

/**
 * 确保 wrangler 可用：inspector 已在监听 → attach；否则按配置 autoSpawn。
 *
 * PANHUB_NO_SPAWN=1（测试开关）：**跳过 spawn 但允许 attach** —— 仍先探测 inspector，
 * 若在监听则走 attach 分支（健康监听 + stdout 解析 + startInspectorMonitor 照常）；
 * 仅当探测失败才 mode='off'。测试场景（test/hop-smoke.mjs）没有 wrangler 在跑，
 * 探测失败自然降级 off，行为与旧版（NO_SPAWN=1 直接 off）兼容。
 *
 * @returns { mode: 'spawn'|'attach'|'off' }
 */
export async function ensureWrangler() {
  const cfg = getConfig();
  const probe = await probeInspector(cfg.wrangler.inspectorPort);
  if (probe.ok) {
    health.mode = 'attach';
    health.running = false;
    health.pid = null;
    health.port = cfg.wrangler.port;
    health.inspectorPort = cfg.wrangler.inspectorPort;
    log('info', `wrangler：检测到已运行（attach 模式，inspector ws://127.0.0.1:${cfg.wrangler.inspectorPort}/ws）`, { via: 'wrangler', console: true });
    startInspectorMonitor();
    return health.mode;
  }
  if (process.env.PANHUB_NO_SPAWN === '1') {
    // 跳过 spawn：探测已失败（无 wrangler 在跑）→ 降级 off，不拉起子进程
    health.mode = 'off';
    log('info', 'wrangler：PANHUB_NO_SPAWN=1 且 inspector 未监听 —— 跳过 spawn（测试模式）', { via: 'wrangler' });
    return health.mode;
  }
  if (!cfg.wrangler.autoSpawn) {
    health.mode = 'off';
    log('warn', 'wrangler：未检测到运行中实例且 autoSpawn=关 —— 请用 launcher 或手动启动 wrangler', { via: 'wrangler' });
    return health.mode;
  }
  spawnWrangler();
  return health.mode;
}

/** spawn wrangler pages dev（参数见文件头注释；退出时收尾） */
function spawnWrangler() {
  const cfg = getConfig();
  const bin = resolveWranglerBin();
  const args = [
    'pages', 'dev', '.',
    '--port', String(cfg.wrangler.port),
    '--inspector-port', String(cfg.wrangler.inspectorPort),
    '--ip', '127.0.0.1',
    // v1.2.2：令牌由根 .dev.vars 提供（launcher ensure_dev_vars 保证与 config.json 同一把），不再 --binding
    '--show-interactive-dev-session=false',
    '--log-level', 'info',
  ];
  log('info', `wrangler：spawn ${bin} ${args.join(' ')}（cwd=${REPO_ROOT}）`, { via: 'wrangler' });
  let c;
  try {
    c = spawn(bin, args, { cwd: REPO_ROOT, env: { ...process.env, NO_COLOR: '1' } });
  } catch (err) {
    log('error', `wrangler：spawn 失败（${err.message}）—— 降级 stdout-only，请手动启动 wrangler`, { via: 'wrangler' });
    health.mode = 'off';
    startInspectorMonitor();
    return;
  }
  child = c;
  health.mode = 'spawn';
  health.running = true;
  health.pid = c.pid;
  health.port = cfg.wrangler.port;
  health.inspectorPort = cfg.wrangler.inspectorPort;
  health.startedAt = Date.now();

  c.stdout?.on('data', (buf) => {
    const text = buf.toString('utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      health.stdoutLastAt = Date.now();
      health.lastLine = t.slice(0, 300);
      ingestWranglerLine(t);
    }
  });
  c.stderr?.on('data', (buf) => {
    const text = buf.toString('utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      health.stdoutLastAt = Date.now();
      health.lastLine = t.slice(0, 300);
      if (/error|warn/i.test(t)) log(t.toLowerCase().includes('error') ? 'error' : 'warn', `[wrangler] ${t}`, { via: 'wrangler' });
      else ingestWranglerLine(t);
    }
  });
  c.on('exit', (code, signal) => {
    log('warn', `wrangler：进程退出（code=${code} signal=${signal ?? ''}）—— 如需恢复请用 launcher start/restart`, { via: 'wrangler' });
    health.running = false;
    health.pid = null;
    child = null;
    closeWs();
  });
  c.on('error', (err) => {
    log('error', `wrangler：进程错误（${err.message}）`, { via: 'wrangler' });
  });

  // 启动后开始健康监听（spawn 与 attach 同路径）
  setTimeout(() => startInspectorMonitor(), 800);
}

/** 停止本进程 spawn 的 wrangler（launcher stop 走 PID 文件；这里兜底） */
export function stopWrangler() {
  if (child) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    child = null;
  }
  closeWs();
  if (monitorTimer) {
    clearTimeout(monitorTimer);
    monitorTimer = null;
  }
  health.running = false;
}
