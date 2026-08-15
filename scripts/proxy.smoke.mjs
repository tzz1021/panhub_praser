/* 临时冒烟测试：模拟 CF Pages Function 环境调用 onRequestPost/onRequestOptions */
const { onRequestPost, onRequestOptions } = await import('../functions/api/proxy.js');

let failures = 0;
function assert(name, cond, extra = '') {
  if (cond) console.log(`✅ ${name}`);
  else { failures++; console.log(`❌ ${name} ${extra}`); }
}

const ENV = { PROXY_TOKEN: 'test-token' };

async function call(payload, { token = 'test-token', ip = '1.2.3.4', method = 'POST' } = {}) {
  const headers = { 'x-proxy-token': token, 'cf-connecting-ip': ip, 'content-type': 'application/json' };
  const req = new Request('https://example.com/api/proxy', {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(payload) : undefined,
  });
  return onRequestPost({ request: req, env: ENV });
}

// 1. 缺 token -> 401
let r = await call({ url: 'https://pc-api.uc.cn/x' }, { token: '' });
assert('缺 token -> 401', r.status === 401, `got ${r.status}`);

// 2. token 错 -> 401
r = await call({ url: 'https://pc-api.uc.cn/x' }, { token: 'wrong' });
assert('token 错 -> 401', r.status === 401, `got ${r.status}`);

// 3. 白名单外域名 -> 403
r = await call({ url: 'https://evil.com/x' });
assert('白名单外 -> 403', r.status === 403, `got ${r.status}`);

// 4. 非法 URL -> 400
r = await call({ url: 'not-a-url' });
assert('非法 URL -> 400', r.status === 400, `got ${r.status}`);

// 5. 内嵌凭据 URL -> 400
r = await call({ url: 'https://user:pass@pc-api.uc.cn/x' });
assert('内嵌凭据 -> 400', r.status === 400, `got ${r.status}`);

// 6. 坏 body -> 400
r = await call(null, {});
assert('坏 body -> 400', r.status === 400, `got ${r.status}`);

// 7. 限频：61 次 -> 最后一次 429
let last = null;
for (let i = 0; i < 61; i++) {
  last = await call({ url: 'https://pc-api.uc.cn/x' }, { ip: '9.9.9.9' });
}
assert('限频 61 次 -> 429', last.status === 429, `got ${last.status}`);
// 换 IP 不受影响
r = await call({ url: 'https://pc-api.uc.cn/x' }, { ip: '8.8.8.8' });
assert('换 IP 放行', r.status !== 429 && r.status !== 401 && r.status !== 403, `got ${r.status}`);

// 8. 正常转发：mock 上游
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  assert('转发目标 URL 正确', String(url) === 'https://pc-api.uc.cn/1/clouddrive/share?pr=UCBrowser', String(url));
  assert('转发 method 正确', init.method === 'POST', init.method);
  assert('转发 body 正确', init.body === '{"a":1}', String(init.body));
  assert('丢弃 cookie', !('cookie' in init.headers), JSON.stringify(init.headers));
  assert('丢弃 authorization', !('authorization' in init.headers), JSON.stringify(init.headers));
  return new Response('{"code":0,"data":{"ok":true}}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
r = await call({
  url: 'https://pc-api.uc.cn/1/clouddrive/share?pr=UCBrowser',
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: 'session=abc', authorization: 'Bearer x', accept: '*/*' },
  body: '{"a":1}',
});
assert('转发成功透传 200', r.status === 200, `got ${r.status}`);
assert('透传 body', (await r.text()) === '{"code":0,"data":{"ok":true}}');
assert('CORS 头', r.headers.get('access-control-allow-origin') === '*');
assert('透传 content-type', (r.headers.get('content-type') || '').includes('application/json'));
globalThis.fetch = realFetch;

// 9. 上游 502/超时：mock 上游抛错
globalThis.fetch = async () => { throw new Error('boom'); };
r = await call({ url: 'https://pc-api.uc.cn/x' }, { ip: '7.7.7.7' });
assert('上游失败 -> 502', r.status === 502, `got ${r.status}`);
globalThis.fetch = realFetch;

// 10. OPTIONS 预检
const pre = onRequestOptions();
assert('OPTIONS -> 204 + CORS', pre.status === 204 && pre.headers.get('access-control-allow-methods')?.includes('POST'));

// 11. env 未配置 -> fail-closed 503
r = await onRequestPost({ request: new Request('https://example.com/api/proxy', { method: 'POST', headers: { 'x-proxy-token': 'x', 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://pc-api.uc.cn/x' }) }), env: {} });
assert('env 缺 PROXY_TOKEN -> 503', r.status === 503, `got ${r.status}`);

console.log(failures === 0 ? '\n全部通过 🎉' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
