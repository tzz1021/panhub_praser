/* 推送功能实测：本地 aria2c（真 RPC，端到端下载）+ Gopeed mock（按 v1.9.3 真实 API 契约）
 *
 * Gopeed 契约（v1.9.3 真机实测，见 memory/2026-08-23）：
 * - 批量：POST /api/v1/tasks/batch，body { reqs: [{ req: {url, extra:{header}}, opts: {name, path} }] }
 * - 鉴权：X-Api-Token 头（不是 Authorization: Bearer，后者 401）
 * - 连接测试：GET /api/v1/info（/api/v1/version 404）
 * - 保存目录：opts.path 绝对路径；空串 → Gopeed 默认下载目录（配置 GET /api/v1/config 的 downloadDir）
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { pushFilesToDownloader, testDownloaderConnection } from '../src/utils/downloader';
import type { DownloaderConfig } from '../src/utils/downloader';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name} ${extra}`); }
}

const files = [
  { path: '/dir1/sub/a.zip', url: 'http://127.0.0.1:18080/a.zip', size: 100, cookie: { key: '__pugs', value: 'tok123' } },
  { path: '/b.zip', url: 'http://127.0.0.1:18080/b.zip', size: 200 },
];

interface BatchItem {
  req: { url: string; extra?: { header?: Record<string, string> } };
  opts: { name: string; path: string };
}
interface BatchPayload { reqs: BatchItem[] }

async function main(): Promise<void> {
  /* ---------- 源文件服务器（记录每个请求的 Cookie 头，验证 §12 按文件注入） ---------- */
  const seenCookies: Array<{ path: string; cookie: string | undefined }> = [];
  const src = http.createServer((req, res) => {
    const name = req.url === '/a.zip' ? 'a.zip' : 'b.zip';
    seenCookies.push({ path: name, cookie: req.headers.cookie });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.end(name === 'a.zip' ? 'a'.repeat(100) : 'b'.repeat(200));
  });
  await new Promise<void>((r) => src.listen(18080, r));

  /* ---------- aria2：真 daemon（6800，带 secret） ---------- */
  rmSync('/tmp/aria2-dl', { recursive: true, force: true });
  mkdirSync('/tmp/aria2-dl', { recursive: true });
  const a2 = spawn('aria2c', ['--enable-rpc', '--rpc-listen-port=6800', '--rpc-secret=testsecret', '--dir=/tmp/aria2-dl', '--console-log-level=warn', '--summary-interval=0'], { stdio: 'ignore', detached: true });
  await new Promise((r) => setTimeout(r, 1200));

  const aria2Cfg: DownloaderConfig = { type: 'aria2', rpc: 'http://127.0.0.1:6800/jsonrpc', secret: 'testsecret', savePath: '/tmp/aria2-dl' };
  const rpc = async (method: string, params: unknown[]): Promise<unknown> =>
    fetch('http://127.0.0.1:6800/jsonrpc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'v', method, params: ['token:testsecret', ...params] }),
    }).then((r) => r.json()).then((d) => d.result);

  console.log('--- aria2 测试连接 ---');
  const t1 = await testDownloaderConnection(aria2Cfg);
  check('getVersion ok', t1.ok, t1.message);
  console.log(`    ${t1.message}`);

  console.log('--- aria2 推送（2 文件，保留结构） ---');
  const r1 = await pushFilesToDownloader(aria2Cfg, files, { keepStructure: true, outDir: '/tmp/aria2-dl' });
  check('push 成功 2/2', r1.ok && r1.success === 2 && r1.failed === 0, JSON.stringify(r1));

  // 等下载完成（100/200 字节，本地瞬时）
  await new Promise((r) => setTimeout(r, 2500));
  const stopped = (await rpc('aria2.tellStopped', [0, 50])) as Array<{ status: string; files: Array<{ path: string }> }>;
  check('aria2 收到 2 个任务并完成', stopped.length === 2 && stopped.every((s) => s.status === 'complete'), `got ${stopped.length}`);
  const pa = stopped.find((s) => s.files[0].path.endsWith('a.zip'));
  check('目录结构保留 dir1/sub/a.zip', pa?.files[0].path === '/tmp/aria2-dl/dir1/sub/a.zip', pa?.files[0].path ?? '');
  const pb = stopped.find((s) => s.files[0].path.endsWith('b.zip'));
  check('根目录文件落到 outDir 根', pb?.files[0].path === '/tmp/aria2-dl/b.zip', pb?.files[0].path ?? '');

  console.log('--- §12 按文件注入 Cookie ---');
  const ca = seenCookies.find((c) => c.path === 'a.zip');
  const cb = seenCookies.find((c) => c.path === 'b.zip');
  check('a.zip 携带 __pugs=tok123', ca?.cookie === '__pugs=tok123', ca?.cookie ?? '(无)');
  check('b.zip 无 Cookie', cb?.cookie === undefined, cb?.cookie ?? '(无)');

  console.log('--- aria2 密钥错误 ---');
  const r2 = await pushFilesToDownloader({ ...aria2Cfg, secret: 'wrong' }, files, { keepStructure: false });
  check('密钥错误 → ok=false', !r2.ok && r2.failed === files.length, JSON.stringify(r2));

  console.log('--- aria2 连接失败（端口未开） ---');
  const deadCfg: DownloaderConfig = { type: 'aria2', rpc: 'http://127.0.0.1:16999/jsonrpc', secret: '', savePath: '' };
  const t2 = await testDownloaderConnection(deadCfg);
  check('连不上 → ok=false 且带提示', !t2.ok && t2.message.includes('无法连接'), t2.message);

  /* ---------- Gopeed mock（v1.9.3 契约：X-Api-Token + /info + /config + /tasks/batch） ---------- */
  let gotAuth = '';
  let gotBatch: BatchPayload | null = null;
  let gotConfigCalls = 0;
  const gs = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v1/info') {
      gotAuth = req.headers['x-api-token'] ?? '';
      res.end(JSON.stringify({ code: 0, msg: '', data: { version: '1.9.3', runtime: 'go1.24.13', os: 'linux', arch: 'arm64' } }));
      return;
    }
    if (req.url === '/api/v1/config') {
      gotConfigCalls += 1;
      res.end(JSON.stringify({ code: 0, msg: '', data: { downloadDir: '/gopeed-default-dl' } }));
      return;
    }
    if (req.url === '/api/v1/tasks/batch' && req.method === 'POST') {
      gotAuth = req.headers['x-api-token'] ?? '';
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        gotBatch = JSON.parse(body) as BatchPayload;
        res.end(JSON.stringify({ code: 0, msg: '', data: ['t1', 't2'] }));
      });
      return;
    }
    if (req.url === '/api/v1/tasks' && req.method === 'POST') {
      // 旧格式端点：真实 v1.9.3 上这个端点收 REST Task 模型，收 {version,tasks} 会 1002
      res.end(JSON.stringify({ code: 1002, msg: 'param invalid: rid or req', data: null }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ code: 404, msg: 'not found', data: null }));
  });
  await new Promise<void>((r) => gs.listen(19999, r));

  const gopeedCfg: DownloaderConfig = { type: 'gopeed', rpc: 'http://127.0.0.1:19999/api/v1/tasks', secret: 'mytoken', savePath: '' };
  console.log('--- Gopeed 测试连接（/api/v1/info） ---');
  const tg = await testDownloaderConnection(gopeedCfg);
  check('info ok 且带版本', tg.ok && tg.message.includes('1.9.3'), tg.message);
  check('X-Api-Token 鉴权头', gotAuth === 'mytoken', gotAuth);

  console.log('--- Gopeed 推送（批量，未填 savePath → 取配置 downloadDir 作 base） ---');
  const rg = await pushFilesToDownloader(gopeedCfg, files, { keepStructure: true });
  check('push 成功 2/2', rg.ok && rg.success === 2 && rg.failed === 0, JSON.stringify(rg));
  check('推送前取过 /api/v1/config', gotConfigCalls === 1, String(gotConfigCalls));
  check('reqs 长度 2', gotBatch?.reqs.length === 2, JSON.stringify(gotBatch));
  const it0 = gotBatch?.reqs[0];
  const it1 = gotBatch?.reqs[1];
  check('req.url 原样透传', it0?.req.url === files[0].url, it0?.req.url ?? '');
  check('cookie → req.extra.header.Cookie（单数 header）', it0?.req.extra?.header?.Cookie === '__pugs=tok123', JSON.stringify(it0?.req.extra));
  check('无 cookie 不带 extra', it1?.req.extra === undefined, JSON.stringify(it1?.req.extra));
  check('keepStructure：name=a.zip path=downloadDir+dir1/sub', it0?.opts.name === 'a.zip' && it0?.opts.path === '/gopeed-default-dl/dir1/sub', JSON.stringify(it0?.opts));
  check('根目录文件 name=b.zip path=downloadDir', it1?.opts.name === 'b.zip' && it1?.opts.path === '/gopeed-default-dl', JSON.stringify(it1?.opts));

  console.log('--- Gopeed 推送（填了 savePath + 不保留结构） ---');
  const rg2 = await pushFilesToDownloader({ ...gopeedCfg, savePath: '/my-dl' }, files, { keepStructure: false, outDir: '/my-dl' });
  check('push 成功', rg2.ok, JSON.stringify(rg2));
  const it2 = gotBatch?.reqs[0];
  check('平铺：path 统一为 savePath', it2?.opts.path === '/my-dl' && it2?.opts.name === 'a.zip', JSON.stringify(it2?.opts));

  console.log('--- Gopeed token 错误（mock 也按契约 401） ---');
  // 另起一个带鉴权强制的 mock：设了 token 但请求无 X-Api-Token → 401（v1.9.3 中间件行为）
  const gs2 = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers['x-api-token'] !== 'right-token') {
      res.statusCode = 401;
      res.end(JSON.stringify({ code: 1001, msg: 'unauthorized', data: null }));
      return;
    }
    res.end(JSON.stringify({ code: 0, msg: '', data: { version: '1.9.3' } }));
  });
  await new Promise<void>((r) => gs2.listen(19998, r));
  const badTokenCfg: DownloaderConfig = { type: 'gopeed', rpc: 'http://127.0.0.1:19998/api/v1/tasks', secret: 'wrong', savePath: '' };
  const t3 = await testDownloaderConnection(badTokenCfg);
  check('token 错 → ok=false 且提示', !t3.ok && t3.message.includes('401'), t3.message);
  const goodTokenCfg: DownloaderConfig = { type: 'gopeed', rpc: 'http://127.0.0.1:19998/api/v1/tasks', secret: 'right-token', savePath: '' };
  const t4 = await testDownloaderConnection(goodTokenCfg);
  check('token 对 → ok', t4.ok, t4.message);

  gs.close(); gs2.close(); src.close(); a2.kill();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('测试异常', e); process.exit(1); });
