/**
 * 线上代理 x-pugs 链路验证（2026-08-16 排查用）
 *
 * 背景：本地 Workerd 复现全链路已通（UC 下发 __pugs → Workers 读 set-cookie →
 * x-pugs 回传 → 同响应 pugs 下载 OSS 206）。剩最后一个未知：**线上 CF 边缘 IP
 * 是否被 UC 风控、不下发 __pugs**。本脚本经真实线上代理跑完整链路并检查 x-pugs。
 *
 * 用法：
 *   node scripts/live-proxy-check.mjs <PROXY_TOKEN> [代理地址] [分享ID]
 *   例：node scripts/live-proxy-check.mjs mytoken https://5775fa15.panhub-praser.pages.dev dd2ad2345e124
 *
 * 输出：每一步的状态 + 最终判定（CF 边缘是否回传 x-pugs）。
 * 判定：
 *   - x-pugs=YES 且 OSS 206/200 → CF 通道没问题，问题在 SPA 侧（再查部署/缓存）
 *   - x-pugs=no  且 set-cookie=(none) → UC 没给 CF 边缘下发 __pugs（风控），
 *     结论 = 白嫖 CF 通道到此为止，转自建后端（reserve-note §2/§4）
 *   - x-pugs=no  但 set-cookie 有 __pugs → proxy.js 解析问题（不该发生，代码已本地验证）
 */
const TOKEN = process.argv[2];
const BASE = (process.argv[3] ?? 'https://5775fa15.panhub-praser.pages.dev').replace(/\/+$/, '');
const SHARE_ID = process.argv[4] ?? 'dd2ad2345e124';

if (!TOKEN) {
  console.error('用法: node scripts/live-proxy-check.mjs <PROXY_TOKEN> [代理地址] [分享ID]');
  process.exit(1);
}

/** 经线上代理发请求；返回 {status, headers, body} */
async function viaProxy(url, method, body = null) {
  const r = await fetch(`${BASE}/api/proxy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-proxy-token': TOKEN },
    body: JSON.stringify({ url, method, headers: { 'content-type': 'application/json' }, body }),
  });
  const text = await r.text();
  return { status: r.status, headers: Object.fromEntries(r.headers.entries()), body: text };
}

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

console.log(`▶ 代理: ${BASE} | 分享: ${SHARE_ID}`);
console.log(`▶ 1/4 经代理获取 stoken`);
const tokenRes = await viaProxy(
  `https://pc-api.uc.cn/1/clouddrive/share/sharepage/token?pr=UCBrowser&fr=pc`, 'POST',
  JSON.stringify({ pwd_id: SHARE_ID, passcode: '' }),
);
if (tokenRes.status !== 200) fail(`token 接口 HTTP ${tokenRes.status}: ${tokenRes.body.slice(0, 200)}`);
const stoken = JSON.parse(tokenRes.body)?.data?.stoken;
if (!stoken) fail(`token 接口未返回 stoken: ${tokenRes.body.slice(0, 200)}`);
console.log(`   stoken: ${stoken.slice(0, 16)}…`);

console.log(`▶ 2/4 经代理遍历目录找第一个文件`);
const enc = encodeURIComponent(stoken);
const dirRes = await viaProxy(
  `https://pc-api.uc.cn/1/clouddrive/share/sharepage/detail?pwd_id=${SHARE_ID}&stoken=${enc}&pdir_fid=0&pr=UCBrowser&fr=pc`, 'GET',
);
if (dirRes.status !== 200) fail(`detail 接口 HTTP ${dirRes.status}: ${dirRes.body.slice(0, 200)}`);
let items = JSON.parse(dirRes.body)?.data?.list ?? [];
let file = items.find((x) => x.size > 0);
let dirFid = items.find((x) => x.size === 0)?.fid;
if (!file && dirFid) {
  const subRes = await viaProxy(
    `https://pc-api.uc.cn/1/clouddrive/share/sharepage/detail?pwd_id=${SHARE_ID}&stoken=${enc}&pdir_fid=${dirFid}&pr=UCBrowser&fr=pc`, 'GET',
  );
  items = JSON.parse(subRes.body)?.data?.list ?? [];
  file = items.find((x) => x.size > 0);
}
if (!file) fail('分享里没找到文件（或目录结构超过 2 层）');
console.log(`   文件: ${file.file_name.slice(0, 40)}…`);

console.log(`▶ 3/4 经代理 download → 检查 x-pugs`);
const dlRes = await viaProxy(
  `https://pc-api.uc.cn/1/clouddrive/file/download?entry=ft&fr=pc&pr=UCBrowser`, 'POST',
  JSON.stringify({ fids: [file.fid], fids_token: [file.share_fid_token], pwd_id: SHARE_ID, stoken }),
);
if (dlRes.status !== 200) fail(`download 接口 HTTP ${dlRes.status}: ${dlRes.body.slice(0, 200)}`);
const pugs = dlRes.headers['x-pugs'] ?? null;
const dlUrl = JSON.parse(dlRes.body)?.data?.[0]?.download_url;
console.log(`   HTTP ${dlRes.status} | x-pugs: ${pugs ? `✅ ${pugs.slice(0, 20)}…（${pugs.length} 字符）` : '❌ 无'}`);
if (!dlUrl) fail('download 未返回直链');

if (!pugs) {
  console.log(`\n🔴 判定：CF 边缘没有回传 x-pugs —— UC 未给 CF 边缘 IP 下发 __pugs（风控）。`);
  console.log(`   结论：CF 白嫖通道走不通，转自建后端（reserve-note §4）；或测不同 colo 后重试。`);
  process.exit(2);
}

console.log(`▶ 4/4 同响应 pugs 探测 OSS 直链`);
const probe = await fetch(dlUrl, {
  headers: { Cookie: `__pugs=${pugs}`, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) uc-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36' },
  redirect: 'follow',
});
const reader = probe.body.getReader();
const first = await reader.read();
await reader.cancel();
const head = first.value ? Buffer.from(first.value).toString('utf8').slice(0, 60) : '';
const ok = probe.status === 200 || probe.status === 206;
console.log(`   OSS: HTTP ${probe.status} | ${ok && !head.includes('<Error>') ? '✅ 可下载' : `❌ ${head.slice(0, 90)}`}`);
console.log(`\n🟢 判定：CF 通道全链路通（x-pugs 回传 + 直链可下）。问题在 SPA 侧，重新部署/清缓存后再试。`);
