/**
 * 严格终端穿透（v0.1.0-next，Tzz 审稿细节②）
 *
 * 定位：兼容无 GUI 服务器的 WebUI 终端；wrangler 交互面板仍是主终端，
 * 这里只做**严格过滤**的 CLI 穿透（xterm.js 前端 → /api/web/terminal/ws）。
 *
 * 安全模型：
 * - 会话鉴权：Host + Origin + WebUI 令牌（query 参数；ws 无法带自定义头）
 * - 命令过滤（白名单式，只增不减）：高危指令整行拒绝 + 写审计日志；
 *   hosts（域名注入映射）操作允许新增、不允许删除（API 层也不提供删除端点）
 * - 所有命令全量写审计日志；风险声明由前端展示
 * - 不做"单纯采集浏览器指纹"类功能
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { getConfig } from './config.js';
import { audit, listHosts, addHost } from './db.js';
import { log } from './log.js';
import { REPO_ROOT } from './wrangler.js';
import { hostAllowed, originAllowed, verifyWebuiToken } from './auth.js';

/* ---------------- 命令过滤（白名单式，只增不减） ---------------- */

/** 整行拒绝的高危指令（首词匹配；禁用 stop/restart/kill/rm 等） */
const BLOCKED_FIRST_WORDS = new Set([
  // 进程/服务生命周期
  'stop', 'restart', 'kill', 'pkill', 'killall', 'service', 'systemctl', 'init', 'telinit', 'reboot',
  'shutdown', 'halt', 'poweroff', 'exit', 'logout',
  // 文件/磁盘高危
  'rm', 'rmdir', 'mv', 'mkfs', 'mkfs.ext4', 'fdisk', 'parted', 'dd', 'truncate', 'shred', 'wipefs',
  // 权限/账户
  'sudo', 'su', 'passwd', 'useradd', 'userdel', 'usermod', 'groupadd', 'groupdel', 'chown', 'chmod', 'chattr',
  // 网络/防火墙/系统配置
  'iptables', 'nft', 'ufw', 'firewall-cmd', 'mount', 'umount', 'swapoff', 'route', 'ip', 'brctl',
  'crontab', 'at', 'visudo', 'insmod', 'rmmod', 'modprobe',
  // 容器/虚拟化
  'docker', 'podman', 'kubectl', 'virsh',
  // 危险下载执行
  'curl', 'wget',
]);

/** 危险模式（正则，命中整行拒绝） */
const BLOCKED_PATTERNS = [
  /:\(\)\s*\{/, // fork bomb
  />\s*\/dev\/(sd|nvme|hd)[a-z]/, // 直接写裸设备
  /--no-preserve-root/, // rm -rf /
  /\|\s*(sh|bash)\s*$/, // curl | sh 类
  /eval\s+.*\$\(/, // eval 命令替换
  /git\s+push\s+.*(-f|--force)/, // 强推
];

/** hosts 内置命令（host 操作允许新增、不允许删除） */
function handleHostsBuiltin(args) {
  const sub = args[0];
  if (!sub || sub === 'list' || sub === 'ls' || sub === 'status') {
    const rows = listHosts();
    if (rows.length === 0) return 'hosts：暂无映射（wrangler 白名单在 functions/api/proxy.js 的 ALLOWED_HOST_SUFFIXES）\n';
    return (
      'hosts：host → 网盘注入映射（只增不减）\n' +
      rows.map((r) => `  ${r.host} → ${r.pan}`).join('\n') +
      '\n'
    );
  }
  if (sub === 'add' || sub === 'set') {
    const host = args[1];
    const pan = args[2] ?? 'quark';
    if (!host) return '用法：hosts add <域名> [quark|uc]\n';
    try {
      const r = addHost(host, pan);
      audit('hosts.add', `${r.host} → ${r.pan}`, 'terminal');
      return r.added ? `hosts：已新增 ${r.host} → ${r.pan}（该域名请求将按 ${r.pan} 注入账号）\n` : `hosts：${r.host} 已存在（幂等）\n`;
    } catch (err) {
      return `hosts：${err.message}\n`;
    }
  }
  if (['del', 'delete', 'remove', 'rm'].includes(sub)) {
    // 不允许删除（只增不减）；整行拒绝 + 审计
    audit('terminal.block', `hosts ${sub} 不允许删除（host 只增不减）`, 'terminal');
    return '⛔ 已拒绝：hosts 操作只允许新增，不允许删除（host 只增不减）\n';
  }
  return '用法：hosts | hosts list | hosts add <域名> [quark|uc]\n';
}

/**
 * 过滤命令：命中高危 → { blocked, text }；否则 { blocked: false, cmd }。
 * 高危整行拒绝 + 写审计日志。
 */
export function filterCommand(cmd) {
  const trimmed = String(cmd ?? '').trim();
  if (!trimmed) return { blocked: true, text: '' };
  const first = trimmed.split(/\s+/)[0]?.toLowerCase();
  if (BLOCKED_FIRST_WORDS.has(first)) {
    audit('terminal.block', `高危指令：${trimmed.slice(0, 300)}`, 'terminal');
    return { blocked: true, text: `⛔ 已拒绝（高危指令 ${first}）：整行未执行。风险声明见终端页；需要管理系统服务请使用 launcher.sh\n` };
  }
  for (const re of BLOCKED_PATTERNS) {
    if (re.test(trimmed)) {
      audit('terminal.block', `危险模式：${trimmed.slice(0, 300)}`, 'terminal');
      return { blocked: true, text: `⛔ 已拒绝（命中危险模式）：整行未执行\n` };
    }
  }
  if (first === 'hosts' || first === 'host') {
    // hosts 内置命令走专用处理器（新增允许、删除拒绝）
    return { blocked: false, builtin: 'hosts', args: trimmed.split(/\s+/).slice(1) };
  }
  return { blocked: false, cmd: trimmed };
}

/** 执行命令（sh -c，cwd = 仓库根；stdout/stderr 流式回传） */
function runCommand(cmd, onData, onExit) {
  const c = spawn('sh', ['-c', cmd], { cwd: REPO_ROOT });
  let out = '';
  const push = (chunk) => {
    out += chunk;
    if (out.length > 4096) {
      onData(out);
      out = '';
    }
  };
  c.stdout.on('data', (b) => push(b.toString('utf8')));
  c.stderr.on('data', (b) => push(b.toString('utf8')));
  c.on('close', (code) => {
    if (out) onData(out);
    onExit(code ?? -1);
  });
  c.on('error', (err) => onExit(`无法执行：${err.message}`));
  return c;
}

/** 处理一行命令：返回 { kind: 'output'|'exit'|'error', text, code? } */
export function execLine(line, sink) {
  const { blocked, text, cmd, builtin, args } = filterCommand(line);
  if (blocked) {
    if (text) sink({ kind: 'output', text });
    return;
  }
  audit('terminal.exec', String(line).slice(0, 300), 'terminal');
  if (builtin === 'hosts') {
    sink({ kind: 'output', text: handleHostsBuiltin(args) });
    return;
  }
  log('info', `terminal：执行 ${String(cmd).slice(0, 120)}`, { via: 'terminal' });
  runCommand(
    cmd,
    (textChunk) => sink({ kind: 'output', text: textChunk }),
    (code) => sink({ kind: 'exit', text: `\n[退出码 ${code}]\n`, code }),
  );
}

/* ---------------- ws 会话 ---------------- */

/**
 * 校验 ws 升级请求（Host + Origin + 令牌；CSRF 对 ws 不适用，Origin 校验即防线）
 * @returns { ok: boolean }
 */
export function authorizeTerminalWs(req) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/api/web/terminal/ws') return false;
  if (!hostAllowed(req.headers.host)) return false;
  if (!originAllowed(req.headers.origin, req.headers.host)) return false;
  const token = url.searchParams.get('token') ?? '';
  if (!verifyWebuiToken(token)) return false;
  return true;
}

/** 会话 id（审计关联） */
export function newTerminalSessionId() {
  return randomBytes(4).toString('hex');
}

/** 处理一条客户端消息（协议 { type: 'exec', cmd } | { type: 'ping' }） */
export function handleTerminalMessage(msg, sink) {
  let parsed;
  try {
    parsed = JSON.parse(msg);
  } catch {
    sink({ kind: 'output', text: '协议错误：消息必须是 JSON\n' });
    return;
  }
  if (parsed.type === 'ping') {
    sink({ kind: 'pong' });
    return;
  }
  if (parsed.type === 'exec') {
    execLine(String(parsed.cmd ?? ''), sink);
    return;
  }
  sink({ kind: 'output', text: `未知消息类型：${parsed.type}\n` });
}

/** 终端是否已开启（系统配置 → 高级） */
export function terminalEnabled() {
  return Boolean(getConfig().advanced.terminalEnabled);
}
