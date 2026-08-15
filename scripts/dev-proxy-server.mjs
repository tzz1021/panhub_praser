/**
 * 本地验证：把 functions/api/proxy.js（CF Pages Functions 同一份代码）挂成本地 HTTP 服务，
 * 模拟 Pages 运行时。node 层直接验证 proxy 能否真实打通 UC API（不经过浏览器/UI）。
 *
 * 用法：node scripts/dev-proxy-server.mjs [port]
 *   PROXY_TOKEN=*** 可选，与线上一致（fail-closed）
 */
import { createServer } from 'node:http';
import { onRequestPost, onRequestOptions } from '../functions/api/proxy.js';

const PORT = Number(process.argv[2] ?? 8787);

const server = createServer(async (req, res) => {
  // 把 node req/res 转成 CF 风格 Request/Response
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers[k] = v;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const cfReq = new Request(url.toString(), {
    method: req.method,
    headers,
    body: body.length ? body : undefined,
  });
  const context = { request: cfReq, env: { PROXY_TOKEN: process.env.PROXY_TOKEN ?? '' } };

  let cfRes;
  if (req.method === 'OPTIONS') {
    cfRes = onRequestOptions();
  } else {
    cfRes = await onRequestPost(context);
  }

  res.writeHead(cfRes.status, Object.fromEntries(cfRes.headers.entries()));
  res.end(Buffer.from(await cfRes.arrayBuffer()));
});

server.listen(PORT, () => {
  console.log(`proxy dev server on :${PORT} (PROXY_TOKEN ${process.env.PROXY_TOKEN ? 'set' : 'NOT SET → 全部 503'})`);
  console.log('转发到 UC API，测试:');
  console.log(`  curl -X POST localhost:${PORT}/api/proxy -H 'Content-Type: application/json' -d '{"url":"https://pc-api.uc.cn/1/clouddrive/share/sharepage/token?pr=UCBrowser&fr=pc","method":"POST","headers":{"Content-Type":"application/json"},"body":"{\\"pwd_id\\":\\"test\\",\\"passcode\\":\\"\\"}"}'`);
});
