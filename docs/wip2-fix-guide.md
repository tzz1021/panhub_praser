# wip2 修正指南 v1（2026-08-31，与 Tzz 对齐后定稿）

> 对照：docs/backend-wrangler-plan.md v1.2.2（定稿，本指南的唯一依据，不新增任何架构）
> 触发：2026-08-31 wip2 事故 —— 夸克 prase 失败（wrangler 日志 400），cookie 有效（油猴/linkswift 通过）
> 本指南不修 scanner.ts 的功能，只修架构与提示（scanner.ts 是前端问题，与 400 无关）

---

## 0. 架构定稿（先确定这个，其余全部围绕它）

```
SPA(CDN) ──X-Proxy-Token──▶ functions/api/proxy.js  ←── 前端唯一转发实现（§1.3 硬约束 1）
   │                          （本地 = wrangler :8787 / 云端 = CF Pages）
   │                             │ 需要 cookie（prase）时
   │                             ▼
   │                    POST {BACKEND_URL}/api/proxy/cookie-pick {pan, operation}
   │                    （X-Proxy-Token 鉴权；成功 → 注入 cookie + 回传 x-panhub-account）
   │                             │
   │                             ▼
   │                    上游网盘 API（白名单/限频/转发校验只属于 proxy.js）
   │
   └── backend = 账号池保险箱 + 看板（不直接面对 SPA）
          ├─ cookie-pick 取号端点（本地/云端 functions 共用，§4）
          ├─ 账号池 CRUD + set-cookie 合并 + 刷新定时器（§1.3 硬约束 3：账号策略只属于 backend）
          └─ 数据看板（本地 SQLite 单库 / 云端 D1）
```

**铁律（不得违反）**：
1. SPA 只直连 **functions/api/proxy.js**（本地 wrangler / 云端 CF），**不直连 hop**
2. hop（backend `/api/proxy`）**不是 SPA 入口**，现状也不支持 SPA 直连所需能力（能力缺口见 §5）——只作 backend 内部/测试通道
3. 校验策略（token/白名单/限频）只属于 proxy.js；账号策略（选号/轮转/刷新/合并）只属于 backend

---

## 1. 400 根因链（wip2 事故）

```
SPA(proxy 模式, scanner.ts v1.2.2 微调) → 不带 localStorage cookie（loginCookie=''）
  → functions 本地 .dev.vars 无 BACKEND_URL → cookie-pick 分支不触发（env 缺失直接跳过）
  → 上游 quark download（大文件 210MB）无登录 cookie → HTTP 400 + code 23018
  → functions 原样透传 400 → wrangler 日志 "POST /api/proxy 400 Bad Request"
```

- **直接原因**：本地 wrangler 的 `.dev.vars` 缺 `BACKEND_URL` → functions 无法从 backend 取号
- **放大原因**：SPA proxy 模式不再带 localStorage cookie（v1.2.2 微调），cookie 只能靠 backend 账号池注入
- **排除**：cookie 本身有效（油猴/linkswift 通过）；hop 链路 08-30 实测通（debug-2026-08-30.log m-prase 200）

### 修复（必做 0，先于一切）
`backend/launcher.sh` ensure_dev_vars 增加：

```
BACKEND_URL=http://127.0.0.1:${cfg.proxy.port}   # 本地取号端点；云端部署时由部署者改为公网地址
```

（保留 PROXY_TOKEN + TRACE_D1=0；`--binding` 已废弃，只走 .dev.vars）

---

## 2. 必做 2 撤销与替代（SPA 不直连 hop）

**撤销**：此前建议"SPA proxyUrl 指向 backend(hop)" —— 违反 §1.3 硬约束 1，作废。

**替代**：SPA proxyUrl 指向 **functions**：
- 本地：`http://127.0.0.1:8787`（或 `http://<wrangler.bind>:<wrangler.port>`，B 端部署 PANHUB_BIND 内网 IP 时用）
- 云端：`https://<project>.pages.dev`（同域免跨域）

SPA 侧 proxyUrl 为空时回退直连（现状行为不变）。

---

## 3. 断点 1 & 断点 2 & 必做 1：scanner.ts 提示（与 400 无关，纯前端）

**现状问题**：proxy 模式下 CookieInputModal 填的 cookie 只进 localStorage，scanner.ts 根本不读（`loginCookie=''`）→ 用户填了等于没填，且弹窗无任何解释。

**改法（只加提示，不改功能）**：

1. **functions 检测 backend 可用 → 响应回传标记头**（云端分支已有 cookie-pick 成功路径）：
   - cookie-pick 成功时：响应加 `x-panhub-backend: ok`（与 x-panhub-account 同批回传）
   - 本地 .dev.vars 配了 BACKEND_URL 且可取号 → 同样回传；取号失败/超时 → 不回传（前端无提示，保持现状）
2. **SPA ProxyTransport 读到 `x-panhub-backend: ok` → 发 toast**：
   - 「已使用代理托管账号 <label>（cookie 由后端管理，无需手动填写）」——复用现有 x-panhub-account label
   - 弹窗（CookieInputModal）里已有青色横幅「代理托管账号：<label>」，toast 只是提前告知、避免用户白填
3. **CookieInputModal 在 proxy 模式下**：
   - 有 x-panhub-account 时：输入框区域弱化提示「cookie 由代理托管，此处填写仅在直连模式生效」
   - 无托管账号时：保持现状（用户填写 → localStorage，直连模式仍有效）

**验证**：本地起 launcher（配好 BACKEND_URL + 账号池有 quark 账号）→ SPA 解析 → toast 出现 + 弹窗青色横幅显示账号 label。

---

## 4. 必做 3：数据看板 info 级提示（set-cookie 不下发）

**背景（Tzz 确认）**：测试账号 prase 频率太高 → 响应头经常拒绝下发 set-cookie；在 functions 过滤也是对的（按平台区分，不然多盘后 set-cookie 不知道是哪个平台的）。

**改法**：

1. **functions 侧（已做，确认继续）**：set-cookie 只提取白名单值回传（x-quark-pus / x-quark-puus / x-pugs），不原样透传原始 set-cookie —— 多盘时按 pan 加前缀（见 §6 头进出管理）
2. **backend 看板**：hop / trace 记录里 `set_cookies` 与 `x-quark-*` 回传头**均为空**时，该行打 **info 级标记**（比 404/500 的严重警告低）：
   - 文案：「本次 prase 未收到 set-cookie 回传（可能是请求过频被上游限流，或该账号已不需要刷新）」
   - 落库：proxy_logs 加列 `set_cookie_miss INTEGER DEFAULT 0`（1 = 本次未回传）或复用 body_preview 前导标记（轻量，不加列）
   - webui 看板：行内小黄点 /「！」悬浮提示（不标红，不阻断）
3. **后续（P4 待办，本次不做）**：CDP / dev 分支插件兜底更新 cookie（已记入设计稿 §9 P4）

---

## 5. hop 能力缺口清单（现状不支持 SPA 直连，暂不补齐，仅记录）

| # | 缺口 | 影响 |
|---|---|---|
| 1 | hop 转发 wrangler 时丢 `frontend_id`（`{url, method, headers, body}` 无 frontend_id） | SPA 的 frontend_id 到不了 functions → 云端 D1 trace 关联断裂（本地 hop trace 用自身 logRowId，不受影响） |
| 2 | hop 用 `new URL(url).href` 重新序列化 URL | query 编码可能被重排（如 `%2F`/`+`），与 SPA 原 url 不一致 |
| 3 | hop 失败路径（401/400/502）仅 `content-type` 头，无 CORS | 浏览器跨域直连 hop 时读不到错误体（server.js 路由层已补 PROXY_CORS，见代码） |
| 4 | hop 不实现白名单/限频（刻意，§1.3 硬约束 2） | SPA 直连 hop 时无限频保护 —— 不补齐，SPA 不应直连 |

> 结论：hop 保持"backend 内部通道"定位（08-30 smoke 测试/未来 backend 自检用），**不**为 SPA 直连补齐能力。SPA 一律走 functions。

---

## 6. functions 头进出管理（交互中心，Tzz 给的契约）

> 现在只适配夸克；十盘兼具时按 pan 加前缀扩展（如 `x-uc-*` / `x-quark-*` / `x-ali-*`），白名单与提取逻辑同一处维护。

### 接受（来自 SPA 和 backend）
| 头 | 来源 | 用途 | 现状 |
|---|---|---|---|
| `X-Proxy-Token` | SPA / backend | 鉴权（env PROXY_TOKEN，fail-closed 503） | ✅ 已实现 |
| `X-quark-pugs` / `X-quark-puus` | SPA（oss-link 绑定，一类） | 随请求携带的 oss 凭据 | ⚠️ 现状走 `payload.headers.cookie` 整串透传，未拆独立头（等价，不强制拆） |
| `X-quark-pus` / `X-quark-sdid` | SPA（长期登录态 + 杂乱项） | 登录态 | 同上，cookie 整串内 |
| `account_id` | backend（cookie-pick 返回） | 取号后回传前端展示 | ✅ 已实现（内部 accountId 变量，回传见下） |

### 发出
| 头 | 去向 | 用途 | 现状 |
|---|---|---|---|
| `X-Proxy-Token` | hop / backend（cookie-pick 请求） | 声明身份（云端口） | ✅ 已实现（pickAccountFromBackend 带 token） |
| `X-quark-pugs` / `X-quark-puus` | 前端{导出/推送} + backend{更新} | oss-link 绑定，set-cookie 可得更新 | ✅ 已实现（响应回传 + hop mergeSetCookies 合并账号池） |
| `account_id` | 前端 | 展示命中账号 | ⚠️ 现状回传 `x-panhub-account`（label 如 quark#3），非数字 account_id；**契约对齐见 §6.1** |

### 6.1 契约对齐（本次改）
- **回传 account_id 数字**：functions 响应加 `x-panhub-account-id: <number>`（与 x-panhub-account 并存，label 供展示、id 供审计/前端判重）
- 本地 hop 同样回传（hit.account.id）
- SPA ProxyTransport 读取并存 lastProxyAccountId（与 lastProxyAccountLabel 并列）

---

## 7. 验证路径（按顺序）

1. **launcher .dev.vars 加 BACKEND_URL** → restart → 确认 wrangler 能取号（backend.log 出现 cookie-pick 审计 / wrangler 日志 400 消失）
2. **SPA proxyUrl 指 functions**（本地 8787）→ 解析分享 → 直链 200 + toast「代理托管账号」
3. **账号池空 vs 有正式账号** 两种形态各测一遍：
   - 空池：prase 回落 guest（随机 __pugs）→ 大文件 400（预期，看板 info 提示 set-cookie miss）
   - 正式账号：prase 200（预期）
4. **看板**：调用明细有行、set-cookie miss 标记出现、file_hits 落库
5. **step1 复验**（已认可）：CDP 抓到的请求头 cookie 写入 backend 账号池（POST /api/web/accounts）→ smoke prase → 200 + x-panhub-account-id 回传
6. **step2 复验**（已认可）：模拟 SPA 协议体（含 frontend_id）直连 functions → 看 functions 是否取号注入 + 响应回传 account_id + SPA 弹窗 react 出 label/id

---

## 8. 改动文件清单

| 文件 | 改动 |
|---|---|
| `backend/launcher.sh` | ensure_dev_vars 加 `BACKEND_URL=http://127.0.0.1:${proxy.port}` |
| `functions/api/proxy.js` | cookie-pick 成功 → 回传 `x-panhub-backend: ok` + `x-panhub-account-id` |
| `backend/src/proxy.js`（hop） | 响应回传 `x-panhub-account-id`（hit.account.id）；trace 记 set_cookie_miss |
| `backend/src/db.js` | proxy_logs 迁移加列 `set_cookie_miss`（幂等 ALTER，沿用 columnExists 模式） |
| `backend/webui/*` | 看板行内「!」info 提示（set_cookie_miss=1 时） |
| `src/core/transport/types.ts` | 读 `x-panhub-backend` / `x-panhub-account-id`；toast「已使用代理托管账号」 | ✅ 已改（typecheck + build 绿） |
| `src/components/CookieInputModal.tsx` | proxy 模式下弱化输入区提示（仅文案） | ✅ 已改（typecheck + build 绿） |
| `src/pages/ResultPage.tsx` | 解析完成后一次性 toast（backendOkToastShown ref 防刷屏） | ✅ 已改（typecheck + build 绿） |

> scanner.ts **不改功能**（loginCookie='' 是定稿行为）；只动 transport/toast/弹窗提示。
