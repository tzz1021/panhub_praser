/* 真实 Gopeed 端到端验证（无头 gopeed-web 服务端）
 *
 * 默认连本地测试服务（端口 19997 + token panhub-test-token，沙箱 /tmp/gopeed-web 起的）；
 * 也可指向 Tzz 的真实 gopeed：GOPEED_BASE=http://127.0.0.1:9999 GOPEED_TOKEN=xxx tsx tests/gopeed-real.spec.ts
 *
 * 验证点（v1.1.8.1 修复后）：
 * - GET /api/v1/info 连接测试（旧 /api/v1/version 404）
 * - POST /api/v1/tasks/batch REST reqs 格式（旧 {version,tasks} 1002）
 * - X-Api-Token 鉴权（旧 Authorization Bearer 401）
 * - opts.name/opts.path 保存目录语义（keepStructure → base+相对目录）
 * - §12：req.extra.header.Cookie 真实出现在下载请求里（用回显日志源站验证）
 */
import { pushFilesToDownloader, testDownloaderConnection } from '../src/utils/downloader';
import type { DownloaderConfig } from '../src/utils/downloader';
import http from 'node:http';
import { existsSync } from 'node:fs';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra = ''): void => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name} ${extra}`); }
};

const base = process.env.GOPEED_BASE ?? 'http://127.0.0.1:19997';
const token = process.env.GOPEED_TOKEN ?? 'panhub-test-token';
const dlDir = '/tmp/gopeed-test/dl';

const cfg: DownloaderConfig = {
  type: 'gopeed',
  rpc: `${base}/api/v1/tasks`,
  secret: token,
  savePath: dlDir,
};

async function main(): Promise<void> {
  /* 回显日志源站：记录 gopeed 实际发出的 Cookie */
  const seen: Array<{ path: string; cookie: string | null }> = [];
  const src = http.createServer((req, res) => {
    seen.push({ path: req.url ?? '', cookie: req.headers.cookie ?? null });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.end('E'.repeat(200));
  });
  await new Promise<void>((r) => src.listen(18084, r));

  console.log('--- 测试连接（真机） ---');
  const t = await testDownloaderConnection(cfg);
  check('info 返回版本', t.ok && /Gopeed \d+\.\d+\.\d+/.test(t.message), t.message);
  console.log(`    ${t.message}`);

  const files = [
    { path: '/dir1/sub/a.zip', url: `http://127.0.0.1:18084/a.zip`, size: 200, cookie: { key: '__pugs', value: 'real-tok-1' } },
    { path: '/b.zip', url: 'http://127.0.0.1:18081/b.zip', size: 200 },
  ];

  console.log('--- 推送（真机，keepStructure + savePath） ---');
  const r = await pushFilesToDownloader(cfg, files, { keepStructure: true, outDir: dlDir });
  check('push 成功 2/2', r.ok && r.success === 2, JSON.stringify(r));
  await new Promise((res) => setTimeout(res, 2500));

  const tasks = await fetch(`${base}/api/v1/tasks`, { headers: { 'X-Api-Token': token } }).then((x) => x.json());
  const list = tasks.data as Array<{ name: string; status: string; meta: { opts: { path: string } } }>;
  const ta = list.find((x) => x.name === 'a.zip');
  const tb = list.find((x) => x.name === 'b.zip');
  check('a.zip 任务 done', !!ta && ta.status === 'done', JSON.stringify(ta ?? null));
  check('a.zip 保存目录 dir1/sub', ta?.meta.opts.path === `${dlDir}/dir1/sub`, ta?.meta.opts.path ?? '');
  check('b.zip 任务 done 且落 savePath 根', !!tb && tb.status === 'done' && tb.meta.opts.path === dlDir, JSON.stringify(tb ?? null));
  check('文件真实落盘 a.zip', existsSync(`${dlDir}/dir1/sub/a.zip`));
  check('文件真实落盘 b.zip', existsSync(`${dlDir}/b.zip`));

  console.log('--- §12 Cookie 真实到达下载请求（回显源站） ---');
  const got = seen.find((s) => s.path === '/a.zip');
  check('a.zip 请求带 __pugs=real-tok-1', got?.cookie === '__pugs=real-tok-1', JSON.stringify(got ?? null));

  src.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('异常', e); process.exit(1); });
