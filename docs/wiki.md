# Wiki · 自托管与代理指南（Self-host & Proxy Guide）

> 给懂点技术、不怕麻烦的重度玩家。本项目的 **API 转发代理**（Transport）有两种免费部署方式，
> 任选其一，填进「设置 → API 转发代理」即可解锁全站解析（不再受 CORS 限制）。
>
> 中文为主，关键命令与官方引用保留英文，每篇末尾附 English summary。

## 方案对比（Compare）

| | 方案 A：Cloudflare Pages（推荐） | 方案 B：自建服务端 |
|---|---|---|
| 成本 | 免费（Free 计划 10 万请求/天） | 一台常开的机器（树莓派/旧手机/家里 NAS） |
| 部署难度 | ★☆☆ 跟着走 10 分钟 | ★★★ 要维护 |
| 隐私 | 请求经过 Cloudflare（仅 API JSON，无 cookie） | 全自持，流量不出家门 |
| 稳定性 | 大厂 SLA | 取决于你的宽带/设备 |
| 适合 | 个人用、追求省事 | 全家共享、数据洁癖 |
| 入口 | [docs/wiki-cloudflare.md](wiki-cloudflare.md) | [docs/wiki-selfhost.md](wiki-selfhost.md) |

两者代理协议完全一致（`POST /api/proxy`），设置面板里填地址 + 令牌即可切换，互不影响。

## 代理协议速览（Protocol）

```
POST {proxyUrl}/api/proxy
X-Proxy-Token: <部署时设置的令牌>        # 可选，代理端校验

{ "url": "https://pc-api.uc.cn/...", "method": "POST",
  "headers": { "Content-Type": "application/json" },   # cookie/authorization 会被代理丢弃
  "body": "{...}" }
```

- 成功：原样透传上游状态码与 body（UC API 返回 `{"code":0,"data":...}`）+ `Access-Control-Allow-Origin: *`
- 若上游响应携带下载凭据 Set-Cookie（UC `__pugs`），代理会提取并回传 `x-pugs` 响应头
  （跨域部署已配 `Access-Control-Expose-Headers: x-pugs`，浏览器可读）—— 该值与直链同响应绑定（docs/reserve-note.md §1）
- 代理自身错误：`401`（令牌无效）/ `403`（域名不在白名单）/ `429`（限频）/ `502`（上游失败）等，body 为 `{"error":"CODE","message":"..."}`
- 只转发 API JSON，**不转发文件流** —— 直链是 OSS 签名 URL，浏览器直接连 CDN 下载

## 视频指南（Video）

- 计划：站长全程录屏演示 + 后期配音 + 剪辑，发布后在此贴 B 站链接。
- 视频只讲方案 A（Cloudflare），方案 B 以本文档为准。

---

**EN quick start**: See [wiki-cloudflare.md](wiki-cloudflare.md) (English summary at the bottom) for the
free Cloudflare path, or [wiki-selfhost.md](wiki-selfhost.md) for running your own proxy.
Both speak the same `POST /api/proxy` protocol — fill the address (and token) in
`Settings → API Forwarding Proxy`, hit *Test*, done.
