# 传输层（Transport）设计 —— 1.1 核心

> 本文档是 1.1 的架构基座，实现顺序：先看懂本文件 → 再写 functions/。

## 问题

adapter 直接 `fetch` 网盘 API，被 CORS 白名单拦死（`pc-api.uc.cn` 只放行 `drive.uc.cn` 源）。
现状兑底是"弹窗/跳转分享页用书签"，但书签要用户装、要部署，体验断裂。

## 方案：传输层抽象

```ts
interface Transport {
  readonly id: 'direct' | 'proxy' | 'plugin';
  request(req: TransportRequest): Promise<TransportResponse>; // 网络/CORS 错误抛 TransportError
  available(): boolean;
}
```

adapter 不再直接 fetch，改走 `getActiveTransport()`（core/transport/types.ts 单例）。
UI/adapter 逻辑零改动，**换 transport 就是换方案**。

### 三种实现

| id | 场景 | 说明 |
|---|---|---|
| direct | 现状 / 书签注入 | 浏览器直连；CORS 拦截时抛 `TransportError('cors')` |
| proxy | CF Pages Function / Worker / 家庭内网 | 服务端转发，天然无 CORS；填地址即用 |
| plugin | v2.0 浏览器扩展 | 扩展请求不受页面 CORS 限制，可读 cookie；**本次不做** |

### 关键设计决策

1. **代理只转发 API JSON，不转发文件流**。直链是 OSS 签名 URL，用户拿到后浏览器直连 OSS CDN 下载（top-level 导航不受 CORS 限制）。代理流量 = token/detail/download 三连的纯 JSON，免费额度（10 万 req/天）个人用绰绰有余。
2. **Cookie 类凭据禁止进 proxy**：proxy 请求头里如果出现 cookie 字段，代理端丢弃（见 §协议防滥用）。UC 零 cookie，本方案不涉及凭据。
3. **防滥用**：代理默认校验 `X-Proxy-Token`（部署时生成，写入 SPA 设置），域名白名单只放行网盘 API 域，简单限频。裸奔公开代理会被薅到被网盘拉黑。
4. **错误结构化**：`TransportError.kind` 区分 cors/network/http，adapter 据此给中文提示，不再猜 message。

## 代理协议

```
POST {proxyUrl}/api/proxy
Content-Type: application/json

{
  "url": "https://pc-api.uc.cn/1/clouddrive/share/sharepage/token?pr=...",
  "method": "POST",
  "headers": { "Content-Type": "application/json" },   // 若含 cookie 字段，代理丢弃
  "body": "{...}"
}
```

响应：原样透传目标状态码 + body；必须带 CORS 头：
```
Access-Control-Allow-Origin: *
```

代理端校验（顺序）：
1. `X-Proxy-Token` header ≠ 部署时配置的 token → 401
2. `url` 域名 ∉ 白名单（uc.cn / 后续接入的网盘域）→ 403
3. 每 IP 限频（如 60 req/min）→ 429

## CF Pages Functions 实现（推荐，一个项目搞定）

Pages 支持 Functions：`functions/api/proxy.js` 即自动成为 `POST /api/proxy` 路由，
静态站 + 代理同域，SPA 侧连 CORS 头都不用配（同源）。

```
pan-web/
├── functions/
│   └── api/
│       └── proxy.js        # POST /api/proxy（本文件是 1.1 待写项）
└── (现有 vite 项目)
```

Pages 免费额度：10 万请求/天，个人够用。比开 10 个 Worker 整洁——所有网盘走同一个 `/api/proxy`，白名单在代理端扩展即可。

## 配置与 UI

- `preferences.transport = { mode: 'direct' | 'proxy', proxyUrl: string }`
- 设置面板"弹窗开关"下方新增"API 转发代理"行：
  - 输入框填地址（最好是，不强求）
  - 「测试」按钮：向 `{proxyUrl}/api/proxy` 发一个最小探测（转发到白名单内任意 URL），返回 200 即通过
  - 「保存」按钮：写 preferences，`setActiveTransport(transportFromPrefs(...))`
- CORS 弹窗按钮从"跳转分享页"改为"打开设置"（引导填代理）

## 1.1 落地顺序

1. ✅ 本层抽象（core/transport/types.ts）
2. ✅ preferences.transport + 设置面板入口
3. ✅ uc.ts 改走 transport（direct 行为不变）
4. ⏳ functions/api/proxy.js（+ token/白名单/限频）
5. ✅ 设置面板代理行 UI + 测试按钮（真实链路：历史最新链接走 token 接口）
6. ⏳ 视频指南（wiki 已完成：docs/wiki.md 入口 + wiki-cloudflare.md + wiki-selfhost.md；B 站视频待录）
