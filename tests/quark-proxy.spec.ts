/* 夸克 × 本地 wrangler 代理链路验证（proxy: http://127.0.0.1:8788, token e2e-token-12345） */
const PROXY = 'http://127.0.0.1:8788/api/proxy';
const PROXY_TOKEN = 'e2e-token-12345';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra = ''): void => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name} ${extra}`); }
};

async function proxy(url: string, method: string, headers: Record<string, string>, body?: string): Promise<{ status: number; headers: Headers; text: string }> {
  const res = await fetch(PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Proxy-Token': PROXY_TOKEN },
    body: JSON.stringify({ url, method, headers, body: body ?? null }),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

const PWD = 'cdccb82aafe6';
const API = 'https://drive-h.quark.cn/1/clouddrive';

async function main(): Promise<void> {
  // 1. token
  const t = await proxy(`${API}/share/sharepage/token?pr=ucpro&fr=pc&uc_param_str=&ver=2`, 'POST', { 'Content-Type': 'application/json' }, JSON.stringify({ pwd_id: PWD, passcode: '' }));
  check('token 过代理 200', t.status === 200, String(t.status));
  const tok = JSON.parse(t.text);
  check('token 返回 stoken', tok.code === 0 && !!tok.data?.stoken, t.text.slice(0, 120));
  const stoken = encodeURIComponent(tok.data.stoken);

  // 2. detail（根）
  const d = await proxy(`${API}/share/sharepage/detail?pr=ucpro&fr=pc&uc_param_str=&ver=2&pwd_id=${PWD}&stoken=${stoken}&pdir_fid=0&force=0&_page=1&_size=50&_fetch_banner=1&_fetch_share=1&fetch_relate_conversation=0&_fetch_total=1&_sort=file_type:asc,file_name:asc`, 'GET', {});
  check('detail 过代理 200', d.status === 200, String(d.status));
  const dd = JSON.parse(d.text);
  check('detail 列表有值', dd.code === 0 && (dd.data?.list?.length ?? 0) > 0, d.text.slice(0, 100));

  // 2.5 下钻拿文件（fid_token 会过期，必须现场取新鲜的；最多钻 4 层）
  let pdir = dd.data.list[0].fid;
  let fileItem: { fid: string; share_fid_token: string } | undefined;
  for (let i = 0; i < 4 && !fileItem; i++) {
    const d2 = await proxy(`${API}/share/sharepage/detail?pr=ucpro&fr=pc&uc_param_str=&ver=2&pwd_id=${PWD}&stoken=${stoken}&pdir_fid=${pdir}&force=0&_page=1&_size=50&_fetch_banner=0&_fetch_share=0&fetch_relate_conversation=0&_fetch_total=1&_sort=file_type:asc,file_name:asc`, 'GET', {});
    const dd2 = JSON.parse(d2.text);
    const items = dd2.data?.list ?? [];
    fileItem = items.find((it: { dir?: boolean }) => !it.dir);
    const nextDir = items.find((it: { dir?: boolean }) => it.dir);
    if (!fileItem && nextDir) pdir = nextDir.fid;
    else if (!fileItem) break;
  }
  check('下钻拿到文件', !!fileItem, '未找到文件');
  const fileFid = fileItem.fid;
  const fileSft = fileItem.share_fid_token;

  // 3. download（小文件，过代理 → 应回传 x-pugs）
  const dl = await proxy(`${API}/file/download?entry=ft&fr=pc&pr=ucpro`, 'POST', { 'Content-Type': 'application/json' }, JSON.stringify({ fids: [fileFid], fids_token: [fileSft], pwd_id: PWD, stoken: tok.data.stoken }));
  check('download 过代理 200', dl.status === 200, String(dl.status));
  const dld = JSON.parse(dl.text);
  check('download 返回直链', dld.code === 0 && !!dld.data?.[0]?.download_url, dl.text.slice(0, 120));
  const xpugs = dl.headers.get('x-pugs');
  check('x-pugs 头回传（§12 代理捕获通道）', !!xpugs && xpugs.length > 100, String(xpugs?.length));
  const url = dld.data[0].download_url;

  // 4. 直链 + 同响应 pugs（经浏览器侧直接 fetch，模拟导出命令行为）
  const got = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Cookie: `__pugs=${xpugs}` } });
  check(`直链+pugs 下载 ${got.status}`, got.status === 200, String(got.status));

  // 5. 大文件（8.5GB ISO 分享）过代理 guest → 23018（业务码经代理原样透传；fid_token 短效需现场深扫）
  const tBig = await proxy(`${API}/share/sharepage/token?pr=ucpro&fr=pc&uc_param_str=&ver=2`, 'POST', { 'Content-Type': 'application/json' }, JSON.stringify({ pwd_id: '3efb93ba1306', passcode: '' }));
  const tokBig = JSON.parse(tBig.text);
  let bigItem: { fid: string; share_fid_token: string; size?: number } | undefined;
  const q: Array<{ pdir: string; depth: number }> = [{ pdir: '0', depth: 0 }];
  while (q.length > 0 && !bigItem) {
    const { pdir, depth } = q.shift()!;
    if (depth > 6) continue;
    const dq = await proxy(`${API}/share/sharepage/detail?pr=ucpro&fr=pc&uc_param_str=&ver=2&pwd_id=3efb93ba1306&stoken=${encodeURIComponent(tokBig.data.stoken)}&pdir_fid=${pdir}&force=0&_page=1&_size=50&_fetch_banner=${depth === 0 ? 1 : 0}&_fetch_share=${depth === 0 ? 1 : 0}&fetch_relate_conversation=0&_fetch_total=1&_sort=file_type:asc,file_name:asc`, 'GET', {});
    const items = JSON.parse(dq.text).data?.list ?? [];
    for (const it of items) {
      if (it.dir) q.push({ pdir: it.fid, depth: depth + 1 });
      else if ((it.size ?? 0) > 50 * 1048576) bigItem = it;
    }
  }
  check('深扫找到 >50MB 文件', !!bigItem, '未找到');
  if (bigItem) {
    const dlb = await proxy(`${API}/file/download?entry=ft&fr=pc&pr=ucpro`, 'POST', { 'Content-Type': 'application/json' }, JSON.stringify({ fids: [bigItem.fid], fids_token: [bigItem.share_fid_token], pwd_id: '3efb93ba1306', stoken: tokBig.data.stoken }));
    const dlbd = JSON.parse(dlb.text);
    check('大文件过代理 guest → 23018', dlb.status === 400 && dlbd.code === 23018, `${dlb.status} ${dlbd.code}`);
  }

  // 6. cookie 头透传：带登录 cookie 的 download 请求不报错（代理不再丢弃 cookie；结果取决于 cookie 有效性）
  const dlc = await proxy(`${API}/file/download?entry=ft&fr=pc&pr=ucpro`, 'POST', { 'Content-Type': 'application/json', Cookie: 'sdid=dummy; up=dummy; wk=dummy' }, JSON.stringify({ fids: [fileFid], fids_token: [fileSft], pwd_id: PWD, stoken: tok.data.stoken }));
  const dlcd = JSON.parse(dlc.text);
  check('cookie 头透传不破坏请求（仍 200 且 code 0 或业务码）', dlc.status === 200 && dlcd.code === 0, `${dlc.status} ${dlcd.code}`);

  // 7. 鉴权负例：无 X-Proxy-Token → 401；非白名单域 → 403
  const bad = await fetch(PROXY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: `${API}/share/sharepage/token?pr=ucpro&fr=pc&uc_param_str=&ver=2`, method: 'POST', headers: {}, body: null }) });
  check('无 token → 401', bad.status === 401, String(bad.status));
  const evil = await fetch(PROXY, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Proxy-Token': PROXY_TOKEN }, body: JSON.stringify({ url: 'https://evil.example.com/x', method: 'GET', headers: {}, body: null }) });
  check('非白名单域 → 403', evil.status === 403, String(evil.status));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('异常', e); process.exit(1); });
