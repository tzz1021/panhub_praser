# 白嫖 Cloudflare：10 分钟部署你的解析代理（Free Tier · 10 万请求/天）

> 原理一句话：Cloudflare Pages 免费托管静态站 + **Functions**（服务端函数）免费额度 10 万请求/天。
> 我们把代理函数（`functions/api/proxy.js`）和 SPA 静态站放在**同一个 Pages 项目**里 —— 同域部署，
> 浏览器连 CORS 头都不用配；代理在 Cloudflare 边缘机房转发网盘 API，天然绕过浏览器同源限制。
>
> 流量只走 API JSON（token/detail/download 三连，KB 级），直链下载仍由你的浏览器直连 OSS CDN，
> 免费额度个人用绰绰有余。

## 0. 前提（Prereqs）

- 一个 GitHub 账号（用来导入项目；其他 Git 平台也行，CF 支持 GitHub/GitLab/Bitbucket 直连）
- 一个 Cloudflare 账号（免费）
- 本项目已 fork 到你的 GitHub（不会 fork 的先学 GitHub fork，本文不教）

## 1. 把项目接进 Cloudflare Pages

1. Cloudflare 控制台 → **Workers & Pages → Create → Pages → Connect to Git**
2. 选你的 fork 仓库，开始导入。
3. 构建配置（**关键，别用默认**）：

   | 字段 | 值 |
   |---|---|
   | Framework preset | 不用选（或选 Vite） |
   | Build command | `npm run build` |
   | Build output directory | `dist` |

   项目里 `vite.config.ts` 已设 `base: './'`，产物可以扔在任何静态托管上，无需额外配置。
4. 保存并部署。等一两分钟，拿到 `https://<your-project>.pages.dev`。

> *"Cloudflare Pages is a JAMstack platform designed to let you build and host websites with the speed, reliability and scalability of our global network."*
> —— [Cloudflare Pages docs](https://developers.cloudflare.com/pages/)

## 2. 代理函数是自动出现的（Functions）

`functions/api/proxy.js` 在仓库里，Pages 会自动把它编译成 `POST /api/proxy` 路由 —— **不需要任何额外配置**。
目录结构决定路由：

```
functions/
└── api/
    └── proxy.js    →  POST /api/proxy
```

> *"When you deploy a Pages project, Cloudflare automatically generates a Worker for you — any files in a `/functions` directory at the root of your project are bundled into that Worker."*
> —— [Cloudflare Pages Functions docs](https://developers.cloudflare.com/pages/functions/get-started/)

代理做的事（源码就在 `functions/api/proxy.js`，想改白名单直接改）：

1. 校验 `X-Proxy-Token`（见第 3 步）→ 错则 `401`
2. 目标域名白名单（默认只放行 `uc.cn`）→ 白名单外 `403`
3. 每 IP 限频 60 次/分钟 → 超了 `429`
4. 丢弃请求里的 `cookie` / `authorization`（凭据不落代理）→ 只留 content-type 等白名单头
5. 捕获上游响应的下载凭据 Set-Cookie（UC `__pugs`）→ 回传 `x-pugs` 头供导出命令本地注入
   （与直链同响应绑定，见 docs/reserve-note.md §1；跨域部署已配 `Access-Control-Expose-Headers: x-pugs`）
5. 转发到网盘 API，**原样透传**状态码与 body，补上 `Access-Control-Allow-Origin: *`

## 3. 设置访问令牌（PROXY_TOKEN）

代理默认 fail-closed：**没配令牌直接拒绝服务**（防止裸奔公开代理被薅到网盘拉黑你）。

1. Pages 项目 → **Settings → Environment variables → Production**
2. 添加 `PROXY_TOKEN`，值随便生成一串（例如 `openssl rand -hex 16`，或直接拿密码管理器生成）
3. 重新部署（改了环境变量会触发）

## 4. 填进 SPA 设置，完事

打开你的站点（`https://<your-project>.pages.dev`）→ **设置 → API 转发代理**：

- 解析通道：`proxy`
- 代理地址：`https://<your-project>.pages.dev`
- 代理令牌：第 3 步的 `PROXY_TOKEN`
- 点「测试」—— 按钮会用**历史记录里最新一条分享链接**走真实解析链路，绿灯即部署成功

## 5. 扩展白名单（接入更多网盘时）

编辑 `functions/api/proxy.js` 顶部数组，加后缀即可，然后 commit → 自动重新部署：

```js
const ALLOWED_HOST_SUFFIXES = [
  'uc.cn',
  // 'aliyundrive.com',   ← 新网盘域名追加在这里
];
```

## 常见坑（Gotchas）

- **免费额度**：Pages Free 计划 Functions 10 万请求/天 + 500 次构建/月。解析一次约 2-3 个请求，个人用连零头都不到。
- **改了函数没生效**：确认改动已 push 到 fork 仓库并触发新部署；看 **Deployments** 页签的构建日志。
- **想要自己的域名**：Pages 支持绑定自定义域（Settings → Custom domains），CNAME 一条即可。
- **本地调试**：装 wrangler 后 `npx wrangler pages dev .`，函数在本地跑，改完即测。
- **令牌泄露**：SPA 是纯前端，令牌写在 localStorage 里、任何装了代理的人都能看到 —— 所以令牌只防"公开滥用"，不防"有心人"，别拿它当安全边界。

---

## English Summary

1. **Fork** this repo to GitHub, then in Cloudflare: *Workers & Pages → Create → Pages → Connect to Git*.
2. Build settings: command `npm run build`, output dir `dist` (the project already uses `base: './'`).
3. Deploy → you get `https://<your-project>.pages.dev`. The proxy function is auto-routed:
   `functions/api/proxy.js` → `POST /api/proxy` (no config needed).
4. Add env var `PROXY_TOKEN` (project *Settings → Environment variables*), redeploy.
   The proxy is **fail-closed** — no token, no service.
5. In the SPA: *Settings → API Forwarding Proxy* → mode `proxy`, address `https://<your-project>.pages.dev`,
   token = your `PROXY_TOKEN`, hit **Test** (it re-parses your latest history link through the proxy).
6. Whitelist lives at the top of `functions/api/proxy.js` (`ALLOWED_HOST_SUFFIXES`).

Free tier: 100k requests/day, 500 builds/month — plenty for personal use.
