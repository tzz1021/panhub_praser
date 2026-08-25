#!/usr/bin/env node
/**
 * backend 入口（docs/selfhost-node.md §4.6）
 *
 * 用法：
 *   node src/index.js            # debug 模式：前台运行，Ctrl+C 停止
 *   node src/index.js --port N   # 覆盖 proxy 端口（webui = N+1；不写回 config）
 * 首启：随机生成 proxy/webui 端口 + 令牌，打印横幅（一次性，之后看 config.json）
 */
import { loadConfig, getConfig } from './config.js';
import { startServers } from './server.js';
import { log } from './log.js';

function banner({ isFirstRun }) {
  const cfg = getConfig();
  console.log('');
  console.log('══════════════════════════════════════════════════');
  console.log('  panhub-backend v0.1.0 — 自托管转发代理 + 管理面板');
  console.log('══════════════════════════════════════════════════');
  console.log(`  WebUI  管理面板 : http://${cfg.webui.host}:${cfg.webui.port}`);
  if (isFirstRun) {
    console.log(`  ⚠️  首次启动 WebUI 令牌（仅此一次，之后看 data/period/config.json）:`);
    console.log(`      ${cfg.webui.token}`);
  }
  console.log(`  Proxy  转发地址 : http://${cfg.proxy.host}:${cfg.proxy.port}（SPA 设置里填写）`);
  if (isFirstRun) {
    console.log(`  ⚠️  Proxy 令牌（X-Proxy-Token）:`);
    console.log(`      ${cfg.proxy.token}`);
  }
  console.log(`  配置   : data/period/config.json（密钥文件 secret.key 权限 600，备份必须一起）`);
  console.log(`  退出   : Ctrl+C（debug 模式）`);
  console.log('══════════════════════════════════════════════════');
  console.log('');
}

async function main() {
  const { config, isFirstRun } = loadConfig();
  // CLI 覆盖（不写回 config，方便调试）
  const portArg = process.argv.findIndex((a) => a === '--port');
  if (portArg >= 0 && process.argv[portArg + 1]) {
    config.proxy.port = Number(process.argv[portArg + 1]);
    config.webui.port = config.proxy.port + 1;
  }
  const hostArg = process.argv.findIndex((a) => a === '--host');
  if (hostArg >= 0 && process.argv[hostArg + 1]) {
    config.proxy.host = process.argv[hostArg + 1];
    config.webui.host = config.proxy.host;
  }
  banner({ isFirstRun });
  await startServers();
  log('info', `服务已启动（webui 令牌 ${config.webui.token ? '已配置' : '缺失！'}）`);

  process.on('SIGINT', () => {
    console.log('\n[backend] 收到 Ctrl+C，退出');
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
