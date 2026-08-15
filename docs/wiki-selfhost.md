# 自建服务端代理（Self-hosted Proxy）—— 数据全自持

> 嫌 Cloudflare 方案"经过别人家"？那就在你自己家里跑一个代理。
> 一台常开的机器（旧笔记本、树莓派、软路由、甚至吃灰手机）即可。
> 协议与 Cloudflare 方案完全一致（`POST /api/proxy`），设置面板里换个地址就行。

## 好处与代价（Trade-offs）

**好处**
- **隐私**：解析请求不出你家网络，日志全在本地，想审计就审计
- **数据自持**：不依赖任何第三方免费额度，网盘拉黑/服务变动不受影响
- **全家共享**：局域网内所有人都能填你的地址（后续版本计划支持家庭共享 HISTORY 甚至共享凭据，本版先不做）
- **可控**：白名单、限频、日志自己说了算，想加什么网盘改一个数组

**代价**
- **要维护**：机器要常开、依赖要升级、宽带要有公网 IP 或内网穿透
- **速度与稳定性**：取决于你家上行带宽与设备，不如 Cloudflare 边缘
- **HTTPS 要自己搞定**（否则 `fetch` 到 `http://` 地址会被浏览器拦，见下文 Caddy）

## 方案一：Node 代理（最推荐，轻量无依赖）

Node 18+ 自带 `fetch`，**零第三方依赖**，一个文件就是整个服务。

### 步骤

```bash
# 1. 建目录，写 server.mjs（源码见下方"最小实现"）
mkdir -p ~/pan-proxy && cd ~/pan-proxy
vim server.mjs

# 2. 设令牌（与 Cloudflare 方案同一环境变量名）
export PROXY_TOKEN=$(openssl rand -hex 16)

# 3. 跑起来（生产建议用 pm2 / systemd 守护）
node server.mjs
# → listening on 0.0.0.0:8787
```

### 最小实现（可直接用，逻辑与 functions/api/proxy.js 同源）

```js
// server.mjs —— 零依赖，实现 POST /api/proxy 协议
import { createServer } from 'node:http';

const ALLOWED_HOST_SUFFIXES = ['uc.cn'];      // 白名单，新网盘往这加
const TOKEN = process.env.PROXY_TOKEN;         // 不设则 fail-closed
const PORT = process.env.PORT ?? 8787;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-proxy-token',
};

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method !== 'POST' || req.url !== '/api/proxy') { res.writeHead(404); return res.end(); }

  // 1) token 校验（fail-closed）
  if (!TOKEN || req.headers['x-proxy-token'] !== TOKEN) {
    res.writeHead(401, { ...CORS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
  }

  // 2) 解析协议体 { url, method, headers, body }
  let payload;
  try { payload = JSON.parse(await readBody(req)); } catch { payload = null; }
  if (!payload?.url) { res.writeHead(400, CORS); return res.end(JSON.stringify({ error: 'BAD_BODY' })); }

  // 3) 域名白名单
  const host = new URL(payload.url).hostname.toLowerCase();
  if (!ALLOWED_HOST_SUFFIXES.some((s) => host === s || host.endsWith('.' + s))) {
    res.writeHead(403, CORS); return res.end(JSON.stringify({ error: 'DOMAIN_NOT_ALLOWED' }));
  }

  // 4) 转发（丢弃 cookie/authorization，只留白名单头）
  const headers = {};
  for (const k of ['content-type', 'accept', 'accept-language']) {
    const v = payload.headers?.[k];
    if (v) headers[k] = v;
  }
  try {
    const upstream = await fetch(payload.url, {
      method: payload.method ?? 'GET',
      headers,
      body: payload.method === 'GET' ? undefined : payload.body ?? null,
      signal: AbortSignal.timeout(20000),
    });
    const body = await upstream.arrayBuffer();
    res.writeHead(upstream.status, {
      ...CORS,
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
    });
    res.end(Buffer.from(body));
  } catch (e) {
    res.writeHead(502, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'UPSTREAM_FAILED', message: String(e) }));
  }
}).listen(PORT, () => console.log(`pan-proxy on :${PORT}, token ${TOKEN ? 'set' : 'MISSING'}`));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}
```

> *"The `node:http` module provides utilities for creating HTTP servers... `createServer()` returns a new instance of `http.Server`."*
> —— [Node.js http docs](https://nodejs.org/api/http.html)

### 暴露到公网 / HTTPS

SPA 的 `fetch` 只能访问 **HTTPS**（或 localhost）地址，所以自建代理必须套 HTTPS：

- **有公网 IP**：`Caddy` 一条配置自动签发证书，最省事：
  ```caddyfile
  proxy.example.com {
      reverse_proxy 127.0.0.1:8787
  }
  ```
  > *"Caddy automatically obtains and renews TLS certificates for your site."*
  > —— [Caddy docs](https://caddyserver.com/docs/quick-starts/reverse-proxy)
- **没有公网 IP**：frp / tailscale / cloudflared tunnel 任选，把本地 8787 映射出去。其中 `tailscale` 最无脑，装上就能拿一个 HTTPS 域名（`https://<machine>.<tailnet>.ts.net`）。

## 方案二：其他语言（可选）

协议就是一个 `POST /api/proxy` 转发，任何语言都行：

- **Python（FastAPI）**：约 30 行，`httpx` 转发。
  > *"FastAPI is a modern, fast web framework for building APIs with Python."*
  > —— [FastAPI docs](https://fastapi.tiangolo.com/)
- **nginx / Caddy 纯反向代理**：不适合，因为要动态改目标域名 + 丢 cookie 头，属于"带逻辑的代理"，用代码更清晰。

## 自检清单（Go-live checklist）

1. `curl -X POST https://<你的域名>/api/proxy -H 'Content-Type: application/json' -H 'X-Proxy-Token: <令牌>' -d '{"url":"https://pc-api.uc.cn/1/clouddrive/share/sharepage/token?pr=UCBrowser&fr=pc","method":"POST","headers":{"Content-Type":"application/json"},"body":"{}"}'`
   - 返回 `{"code":...}` 而不是 `401/403` → 转发通
2. SPA 设置里填地址 + 令牌 → 点「测试」→ 绿灯
3. 家庭共享：把地址丢给家人，填进他们自己的 SPA 设置即可（本版无共享 HISTORY/cookie，别期待）

---

## English Summary

Run your own proxy so all parse traffic stays inside your network.

**Node (recommended, zero deps):**
1. Save the `server.mjs` snippet above (Node 18+), `export PROXY_TOKEN=$(openssl rand -hex 16)`.
2. `node server.mjs` → listens on `:8787`, implements the same `POST /api/proxy` protocol:
   token check (fail-closed) → domain whitelist (`ALLOWED_HOST_SUFFIXES`) → forward with
   `cookie`/`authorization` stripped → pass-through status + body with CORS `*`.
3. HTTPS is mandatory (browser `fetch` refuses plain `http://`): with a public IP, one
   [Caddy](https://caddyserver.com/docs/quick-starts/reverse-proxy) line gives you auto-TLS;
   otherwise use tailscale (free `*.ts.net` HTTPS) or frp/cloudflared tunnel.
4. Fill address + token in SPA *Settings → API Forwarding Proxy*, hit **Test**.

Alternatives: FastAPI (~30 lines) — any language works, it's just an HTTP forwarder.
