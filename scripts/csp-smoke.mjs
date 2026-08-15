/**
 * CSP 冒烟测试 —— 书签注入 drive.uc.cn 可行性验证（HANDOFF §7 第一条）
 *
 * 验证点：
 *  1. 主文档是否带 CSP（响应头）
 *  2. 注入内联 <script> 是否被拦（script-src / unsafe-inline / unsafe-eval）
 *  3. 同源 fetch 到 pc-api.uc.cn 是否被 connect-src 拦（书签解析 API 的生命线）
 *  4. 浮层渲染：内联 style 属性 / CSSOM insertRule 两种方式是否生效
 *
 * 运行：node scripts/csp-smoke.mjs   （依赖 openclaw 内置 playwright-core + 系统 chromium）
 * 退出码：0 = 书签注入路径可行（或仅 style 属性被拦）；1 = 脚本执行/API 连接被 CSP 拦死
 */
import { chromium } from '/home/user/.npm-global/lib/node_modules/openclaw/node_modules/playwright-core/index.mjs';

const SHARE_URL = process.env.CSP_TEST_URL ?? 'https://drive.uc.cn/s/dd2ad2345e124';

const browser = await chromium.launch({
  executablePath: '/usr/local/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const page = await browser.newPage();
const consoleLogs = [];
const pageErrors = [];
const cspHeaders = [];

page.on('console', (msg) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => pageErrors.push(String(err)));
page.on('response', (res) => {
  if (res.url() === SHARE_URL || res.url().startsWith('https://drive.uc.cn')) {
    const csp = res.headers()['content-security-policy'];
    if (csp) cspHeaders.push(`${res.url()} → ${csp}`);
  }
});

console.log(`▶ 打开分享页: ${SHARE_URL}`);
await page.goto(SHARE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(9000); // 等 SPA 首屏 + 接口响应稳定

// ---- 注入探针 ----
const probe = await page.evaluate(async () => {
  const out = { cspMeta: null, inlineScriptBlocked: false, evalBlocked: false, fetchUc: null, overlayStyleAttr: false, overlayCssom: false };

  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  out.cspMeta = meta ? meta.getAttribute('content') : null;

  // 1. 内联 script 注入（书签产物注入方式）
  try {
    const s = document.createElement('script');
    s.textContent = 'window.__cspProbe = "inline-ok";';
    document.head.appendChild(s);
    out.inlineScriptBlocked = window.__cspProbe !== 'inline-ok';
  } catch {
    out.inlineScriptBlocked = true;
  }

  // 2. eval / new Function（部分打包产物可能用到）
  try {
    // eslint-disable-next-line no-new-func
    new Function('window.__cspEvalProbe = 1')();
    out.evalBlocked = window.__cspEvalProbe !== 1;
  } catch {
    out.evalBlocked = true;
  }

  // 3. fetch 到 UC API（书签解析的生命线，受 connect-src 约束）
  try {
    const r = await fetch('https://pc-api.uc.cn/1/clouddrive/share/sharepage/detail?pwd_id=x&stoken=x&pdir_fid=0&pr=UCBrowser&fr=pc', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    out.fetchUc = `HTTP ${r.status}`;
  } catch (e) {
    out.fetchUc = `BLOCKED: ${String(e).slice(0, 200)}`;
  }

  // 4a. 浮层：内联 style 属性
  const overlay = document.createElement('div');
  overlay.id = 'csp-overlay-probe';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(255,0,0,.4);z-index:999999;';
  document.body.appendChild(overlay);
  out.overlayStyleAttr = getComputedStyle(overlay).position === 'fixed';

  // 4b. 浮层：CSSOM insertRule（CSP 严格时 style 属性会被拦，CSSOM 通常不受限）
  try {
    const sheet = new CSSStyleSheet();
    sheet.insertRule('#csp-overlay-probe{border:8px solid #00f;}');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    out.overlayCssom = getComputedStyle(overlay).borderTopWidth === '8px';
  } catch {
    out.overlayCssom = false;
  }

  return out;
});

console.log('\n===== 探针结果 =====');
console.log(JSON.stringify(probe, null, 2));
console.log('\n===== CSP 响应头 =====');
console.log(cspHeaders.length ? cspHeaders.join('\n') : '（主文档无 CSP 响应头）');
console.log('\n===== 控制台消息（CSP 违规会出现在这里） =====');
console.log(consoleLogs.length ? consoleLogs.slice(0, 40).join('\n') : '（无）');
console.log('\n===== 页面 JS 错误 =====');
console.log(pageErrors.length ? pageErrors.join('\n') : '（无）');

await browser.close();

const fatal =
  probe.inlineScriptBlocked === false || // 内联 script 能跑 = 书签注入路径可行
  (probe.fetchUc && !probe.fetchUc.startsWith('BLOCKED')); // API 可达

console.log(`\n===== 结论：${fatal ? '书签注入路径可行 ✅' : 'CSP 阻断注入/API ✋（需换方案，见 HANDOFF §7 备选）'} =====`);
process.exit(fatal ? 0 : 1);
