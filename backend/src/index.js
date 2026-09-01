#!/usr/bin/env node
/**
 * backend 入口（docs/backend-wrangler-plan.md §1.1/§9 重构，v1.2.2）
 *
 * 用法：
 *   node src/index.js            # debug 模式：前台运行，Ctrl+C 停止
 *   node src/index.js --port N   # 覆盖单 listener 端口（不写回 config）
 * 首启：随机生成端口 + 令牌，打印横幅（一次性，之后看 config.json）
 *
 * 启动顺序：加载配置 → ensureWrangler（inspector 已监听则 attach，否则按 autoSpawn spawn）
 * → 启动单 listener（127.0.0.1）→ 日志保留期清理（启动一次 + 每小时）
 * → cookie 刷新定时器（config.refresh.intervalMs，默认 2h）→ 退出时收尾子进程
 */
import { loadConfig, getConfig, BACKEND_VERSION } from './config.js';
import { startServers } from './server.js';
import { ensureWrangler, stopWrangler } from './wrangler.js';
import { log } from './log.js';
import { getSetting, deleteLogsOlderThan } from './db.js';
import { runRefreshCycle } from './cookies.js';

const HOUR_MS = 3600_000;
const REFRESH_INTERVAL_DEFAULT = 2 * HOUR_MS;
const RETENTION_DEFAULT_DAYS = 30;

function banner({ isFirstRun }) {
  const cfg = getConfig();
  console.log('');
  console.log('══════════════════════════════════════════════════');
  console.log(`  panhub-backend v${BACKEND_VERSION} — 指挥中心（配电室 + 仪表室）`);
  console.log('══════════════════════════════════════════════════');
  console.log(`  管理面板 / 指挥中心 : http://${cfg.proxy.host}:${cfg.proxy.port}`);
  console.log(`  增强 hop  /api/proxy : http://${cfg.proxy.host}:${cfg.proxy.port}/api/proxy`);
  console.log(`  wrangler 转发目标    : http://127.0.0.1:${cfg.wrangler.port}（inspector ${cfg.wrangler.inspectorPort}）`);
  if (isFirstRun) {
    console.log(`  ⚠️  首次启动 WebUI 令牌（仅此一次，之后看 data/period/config.json）:`);
    console.log(`      ${cfg.webui.token}`);
    console.log(`  ⚠️  Proxy 令牌（X-Proxy-Token，与 wrangler 同一把）:`);
    console.log(`      ${cfg.proxy.token}`);
  }
  console.log(`  配置   : data/period/config.json（密钥文件 secret.key 权限 600，备份必须一起）`);
  console.log(`  退出   : Ctrl+C（debug 模式）`);
  console.log('══════════════════════════════════════════════════');
  console.log('');
}

async function main() {
  const { config, isFirstRun } = loadConfig();
  const portArg = process.argv.findIndex((a) => a === '--port');
  if (portArg >= 0 && process.argv[portArg + 1]) {
    config.proxy.port = Number(process.argv[portArg + 1]);
  }
  banner({ isFirstRun });
  await ensureWrangler();
  await startServers();
  log('info', `服务已启动（webui 令牌 ${config.webui.token ? '已配置' : '缺失！'}）`);

  // 日志保留期（v1.2.2 §2.3）：启动清理一次 + 每小时定时；
  // 天数读 settings log_retention_days（默认 30），启动时定格 → 改值重启后生效（Tzz 定）
  const retentionDays = Math.max(1, Math.round(Number(getSetting('log_retention_days') ?? RETENTION_DEFAULT_DAYS) || RETENTION_DEFAULT_DAYS));
  const doCleanup = () => {
    try {
      const r = deleteLogsOlderThan(retentionDays);
      log('info', `日志保留期清理：proxy_logs 删 ${r.proxy_logs} 行 / file_hits 删 ${r.file_hits} 行（>${retentionDays} 天）`);
    } catch (err) {
      log('error', `日志保留期清理失败 — ${err.message}`);
    }
  };
  doCleanup();
  setInterval(doCleanup, HOUR_MS).unref();

  // cookie 刷新定时器（v1.2.2 §9 P2）：默认 2h；runRefreshCycle 内部 try/catch 永不崩溃
  const refreshIntervalMs = Math.max(60_000, Number(getConfig().refresh?.intervalMs) || REFRESH_INTERVAL_DEFAULT);
  setInterval(() => {
    runRefreshCycle();
  }, refreshIntervalMs).unref();
  log('info', `cookie 刷新定时器已启动（每 ${Math.round(refreshIntervalMs / 60_000)} 分钟；quark 刷新 URL 待真机验证）`);

  process.on('SIGINT', () => {
    console.log('\n[backend] 收到 Ctrl+C，退出');
    stopWrangler();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stopWrangler();
    process.exit(0);
  });
  process.on('uncaughtException', (err) => {
    log('error', `未捕获异常：${err.message}\n${err.stack?.slice(0, 500) ?? ''}`);
  });
}

main().catch((err) => {
  console.error('[backend] 启动失败：', err);
  process.exit(1);
});
