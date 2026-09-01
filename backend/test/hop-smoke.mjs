/* backend v0.1.0-next 冒烟测试（不依赖 wrangler 的链路部分） */
import { execSync, spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const BACKEND = new URL('../', import.meta.url).pathname;
const DATA = join(BACKEND, 'data');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name} ${extra}`); }
};

// 清空旧数据（隔离测试环境）
rmSync(DATA, { recursive: true, force: true });

// 启动 backend（固定端口 + 关 autoSpawn 避免拉起 wrangler）
const port = 18881;
const child = spawn(process.execPath, ['src/index.js', '--port', String(port)], {
  cwd: BACKEND,
  env: { ...process.env, PANHUB_NO_SPAWN: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (b) => { out += b.toString(); });
child.stderr.on('data', (b) => { out += b.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `http://127.0.0.1:${port}`;

// 等 config 生成
let cfg;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  const p = join(BACKEND, 'data', 'period', 'config.json');
  if (existsSync(p)) { cfg = JSON.parse(readFileSync(p, 'utf8')); break; }
}
check('首启生成 config.json + 令牌', Boolean(cfg?.proxy?.token && cfg?.webui?.token));
const webuiToken = cfg.webui.token;
const proxyToken = cfg.proxy.token;

// 等 listener 就绪
let ready = false;
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`${base}/api/proxy-config`);
    if (r.ok) { ready = true; break; }
  } catch { /* retry */ }
  await sleep(250);
}
check('单 listener 启动（/api/proxy-config 可达）', ready);

// ① proxy-config 判定已初始化（v1.2.2 §4 收紧：Host 白名单 + 不再下发 token）
const pc = await (await fetch(`${base}/api/proxy-config`)).json();
check('proxy-config ok=true 且不再下发 token', pc.ok === true && pc.token === undefined && pc.version === '0.1.0-next' && pc.proxyUrl === base, JSON.stringify(pc));

// ② hop：无令牌 → 401（CORS 头应存在）
let r = await fetch(`${base}/api/proxy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/', method: 'GET' }) });
check('hop 无令牌 → 401 + CORS *', r.status === 401 && r.headers.get('access-control-allow-origin') === '*');

// ③ hop：正确令牌但 wrangler 未跑 → 502（说明转发目标指向 wrangler）
r = await fetch(`${base}/api/proxy`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proxy-token': proxyToken }, body: JSON.stringify({ url: 'https://example.com/', method: 'GET' }) });
const b502 = await r.json();
check('hop 令牌通过但 wrangler 未启动 → 502 且文案提示', r.status === 502 && /wrangler/.test(b502.message ?? ''), b502.message);

// ④ webui 鉴权四件套：无令牌 → 401
r = await fetch(`${base}/api/web/info`);
check('webui 无令牌 → 401', r.status === 401);

// ⑤ 错误 Host → 403（fetch 禁改 Host 头，用原生 http 验证）
const badHostStatus = await new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/api/web/info', method: 'GET', headers: { host: 'evil.example.com', 'x-webui-token': webuiToken } }, (res) => {
    res.resume();
    resolve(res.statusCode);
  });
  req.on('error', () => resolve(0));
  req.end();
});
check('webui 错误 Host → 403', badHostStatus === 403, `status=${badHostStatus}`);

// ⑥ 登录拿 CSRF
const s = await (await fetch(`${base}/api/web/auth/session`, { headers: { 'x-webui-token': webuiToken } })).json();
check('session 返回 CSRF', Boolean(s.csrf));
const csrf = s.csrf;

// ⑦ info 版本 0.1.0-next
const info = await (await fetch(`${base}/api/web/info`, { headers: { 'x-webui-token': webuiToken } })).json();
check('info.version = 0.1.0-next + wrangler health 字段', info.version === '0.1.0-next' && info.wrangler !== undefined, info.version);

// ⑧ 账号池：加 quark 正式账号（需 CSRF）
r = await fetch(`${base}/api/web/accounts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify({ pan: 'quark', label: '测试1号', cookieString: '__pus=a; __uid=b; __puus=c' }),
});
const acc = await r.json();
check('新增 quark 账号', r.ok && acc.ok, JSON.stringify(acc));

// ⑨ guest 账号：空 cookie → 自动生成随机 __pugs + guest# 打标
r = await fetch(`${base}/api/web/accounts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify({ pan: 'uc', kind: 'guest', cookieString: '' }),
});
const gacc = await r.json();
check('新增 guest 账号（空 cookie 自动生成）', r.ok && gacc.ok, JSON.stringify(gacc));
const accList = await (await fetch(`${base}/api/web/accounts`, { headers: { 'x-webui-token': webuiToken } })).json();
const guestRow = accList.accounts.find((a) => a.kind === 'guest');
check('guest 账号 label 打标 guest# 且含 __pugs', Boolean(guestRow && /^guest#/.test(guestRow.label) && guestRow.keys.includes('__pugs')), JSON.stringify(guestRow));

// ⑩ hosts：新增允许
r = await fetch(`${base}/api/web/hosts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify({ host: 'drive.quark.cn', pan: 'quark' }),
});
check('hosts 新增映射', r.ok);
r = await fetch(`${base}/api/web/hosts`, { headers: { 'x-webui-token': webuiToken } });
const hosts = await r.json();
check('hosts list 包含新增', hosts.hosts?.some((h) => h.host === 'drive.quark.cn'));

// ⑪ 严格终端：未开启时 ws 应 403；开启后过滤高危命令
r = await fetch(`${base}/api/web/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify({ advanced: { terminalEnabled: true } }),
});
check('开启严格终端穿透', r.ok);

// ⑫ 终端过滤单测（直接调模块）
const term = await import(`${BACKEND}src/terminal.js`);
const blocked1 = term.filterCommand('rm -rf /');
check('终端过滤：rm 整行拒绝', blocked1.blocked === true);
const blocked2 = term.filterCommand('systemctl stop nginx');
check('终端过滤：systemctl stop 整行拒绝', blocked2.blocked === true);
const blocked3 = term.filterCommand('curl http://x | sh');
check('终端过滤：curl|sh 拒绝', blocked3.blocked === true);
const ok1 = term.filterCommand('ls -la');
check('终端过滤：ls 放行', ok1.blocked === false && ok1.cmd === 'ls -la');
const hostsDel = term.filterCommand('hosts del drive.quark.cn');
check('终端过滤：hosts del 走 builtin（内部拒绝+审计）', hostsDel.builtin === 'hosts');
const hostsAdd = term.filterCommand('hosts add drive.quark.cn quark');
check('终端过滤：hosts add 走 builtin 处理器', hostsAdd.builtin === 'hosts');

// ⑬ 终端 ws 握手 + 命令执行（真实走一遍）
const wsResult = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/web/terminal/ws?token=${webuiToken}`, { headers: { Origin: `http://127.0.0.1:${port}` } });
  const got = [];
  const timer = setTimeout(() => resolve({ ok: got.some((m) => m.kind === 'exit'), got }), 8000);
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'exec', cmd: 'echo hello-terminal' }));
    ws.send(JSON.stringify({ type: 'exec', cmd: 'rm -rf /' }));
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    got.push(m);
    if (m.kind === 'exit' && got.filter((x) => x.kind === 'exit').length >= 2) {
      clearTimeout(timer);
      ws.close();
      resolve({ ok: true, got });
    }
  };
  ws.onerror = () => { clearTimeout(timer); resolve({ ok: false, got }); };
});
check('终端 ws：echo 执行 + rm 拦截（审计）', wsResult.ok && wsResult.got.some((m) => (m.text ?? '').includes('hello-terminal')) && wsResult.got.some((m) => (m.text ?? '').includes('已拒绝')), JSON.stringify(wsResult.got));

// ⑭ hosts 内置命令真实执行（add）
const hostsBuiltinOut = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/web/terminal/ws?token=${webuiToken}`, { headers: { Origin: `http://127.0.0.1:${port}` } });
  const got = [];
  const timer = setTimeout(() => resolve(got.join('')), 5000);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'exec', cmd: 'hosts add test.example.com quark' }));
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.kind === 'output') { got.push(m.text); }
    if (m.kind === 'exit') { clearTimeout(timer); ws.close(); resolve(got.join('')); }
  };
  ws.onerror = () => { clearTimeout(timer); resolve(got.join('')); };
});
check('终端 hosts add 真实执行', hostsBuiltinOut.includes('已新增'), hostsBuiltinOut);

// ⑮ 审计里有 terminal.block / terminal.exec
const auditList = await (await fetch(`${base}/api/web/audit`, { headers: { 'x-webui-token': webuiToken } })).json();
check('审计含 terminal.exec 与 terminal.block', auditList.entries?.some((a) => a.action === 'terminal.block') && auditList.entries?.some((a) => a.action === 'terminal.exec'));

// ⑯ 令牌轮换（proxy）→ 旧令牌 401
r = await fetch(`${base}/api/web/network/rotate`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-webui-token': webuiToken, 'x-csrf-token': csrf },
  body: JSON.stringify({ which: 'proxy' }),
});
const rot = await r.json();
check('proxy 令牌轮换返回新令牌', r.ok && rot.token && rot.token !== proxyToken);
r = await fetch(`${base}/api/proxy`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-proxy-token': proxyToken }, body: JSON.stringify({ url: 'https://x.cn/', method: 'GET' }) });
check('轮换后旧令牌 → 401（wrangler 需 restart 同步）', r.status === 401);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
child.kill('SIGTERM');
process.exit(fail > 0 ? 1 : 0);
