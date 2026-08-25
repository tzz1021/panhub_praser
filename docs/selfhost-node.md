# selfhost-node —— 自托管转发代理（backend/）设计稿 v1.2.1

> 里程碑：1.2.0（backend 真实落地）。本文档 = 设计稿 + 使用指南初版。
> 背景：CF Pages Function 代理（functions/api/proxy.js）白嫖 + websocket 日志看不到
> 完整响应头，魔鬼测试 cookie 参数不便；proxy.js 中转 + 8 网盘白名单会越来越绕。
> 结论：与 nfd 同理念，鼓励用户自托管去中心化服务。语言 Node.js（避 fastapi 内存、
> npm 一包管到底、与前端同栈）。**不开新 repo**，放本仓库 backend/ 子目录
> （vite/tsconfig 不 import 即天然隔离，worker 构建忽略）。

## 0. 核心心智模型（v1.2.1 新增）

**这本质上是把 wrangler 移到本地。** 两个平面必须物理分离：

```
┌─ 配电室（webui + 直接改后台 config）────────────────┐
│  管理后台：调控电流方向、分配额度。绝不暴露公网。      │
│  绑定：127.0.0.1 写死（代码层强制，不是口头约定）     │
└─────────────────────────────────────────────────────┘
        │ 管理
┌─ 电线（proxy_address，填入 SPA）───────────────────┐
│  对外通道：可暴露公网，但只有 X-Proxy-Token 能进。   │
│  即使地址+令牌泄露：对方拿不到 set-cookie 请求头     │
│  （wrangler 本来就不放行，本地版同规格）；            │
│  恶意体验用户可记录 IP（cf websocket 同思路）。      │
└─────────────────────────────────────────────────────┘
```

- 两个 listener、两个端口、两个 bind 地址，互不混淆
- 从来没有设计过"绕过 IP 限制"——配电室不暴露，就不存在被打的问题

## 1. 定位

- 与 CF 版 proxy.js **协议完全兼容**的本地/内网转发代理：SPA 设置里把代理地址
  从 pages.dev 换成 `http://127.0.0.1:<随机端口>` 即无缝切换（"换代理 = 换皮肤"）
- 比 CF 版多出的能力（全部为魔鬼测试/家庭组/账号管理服务）：
  - **完整响应头记录**（set-cookie 等，CF 看不到的这里全记录）→ cookie 组合研究
  - cookie 池：多账号、加密存储、自动刷新合并、过期标记
  - 分流开关：网盘 × 操作 × 登录态 三维调控
  - 过期/风控通知（webhook 抽象 + 浏览器系统通知；CDP 仅做自动取 cookie，可选）
  - 排队机制：家庭组并发控制
  - WebUI：数据看板 + 实时日志 + 系统终端（默认关） + 插件管理

## 2. 技术栈（决策）

| 项 | 选型 | 理由 |
|---|---|---|
| 运行时 | Node.js ≥ 20（LTS） | 前端同栈、npm 管到底、内存小 |
| HTTP | node:http 原生（零框架） | 转发代理不需要框架；减少依赖面 |
| 存储 | node:sqlite（≥22.5 内置）优先，better-sqlite3 fallback | 闲置手机（Termux/bionic）native 编译痛点；内置零依赖，契合"一包管到底" |
| 加密 | node:crypto AES-256-GCM | 严格加密 cookie 数据库；密钥文件权限 600 |
| 前端 | Preact + Tailwind v4 + daisyUI 5 | 轻量，构建产物小；与 SPA 风格一致 |
| CDP | puppeteer-core（可选依赖，插件化默认关） | 仅"自动取 cookie"一个场景；仍需用户手动点授权 |
| 通知 | 抽象 webhook（ntfy/Server酱/pushplus/自定义）+ 浏览器系统通知 | 出站推送为主；入站 ws 只做只读推送 |

## 3. 目录结构（初版）

```
panhub_praser/
├── backend/                     # ★ 1.2.0 自托管代理（与前端隔离，worker 忽略）
│   ├── package.json             #   name: panhub-backend；type: module
│   ├── src/
│   │   ├── index.js             #   入口：debug/server 模式分发 + 首启初始化（随机端口）
│   │   ├── config.js            #   配置加载/默认值/密钥文件管理（600 权限）
│   │   ├── server.js            #   ★ 双 listener：
│   │   │                        #     listener A = proxy（/api/proxy，可绑 0.0.0.0）
│   │   │                        #     listener B = webui（/api/web/* + / 静态 + ws，硬绑 127.0.0.1）
│   │   ├── proxy.js             #   核心转发（协议同 CF 版 + 完整头记录 + 白名单 + set-cookie 合并）
│   │   ├── auth.js              #   webui 令牌/密码（scrypt 哈希）+ 会话 + timingSafeEqual
│   │   ├── db.js                #   SQLite 初始化 + AES-256-GCM 加密存取 + audit 表
│   │   ├── cookies.js           #   cookie 池：多账号/过期标记/合并刷新
│   │   ├── queue.js             #   排队：全局队列 + 每账号并发限额 + TTL + 总超时
│   │   ├── notify.js            #   通知抽象：webhook/ntfy/Server酱/浏览器通知
│   │   ├── cdp.js               #   CDP 插件：绑定浏览器取新 cookie（可选，默认关）
│   │   ├── log.js               #   结构化日志：内存环形缓冲 + SQLite 落库 + debug 完整头文件
│   │   ├── plugins/
│   │   │   ├── index.js         #     插件加载器（backend/plugins/*.js）
│   │   │   ├── split.js         #     内置插件①：分流开关
│   │   │   └── monitor.js       #     内置插件②：过期/风控通知
│   │   └── webui/               #   Preact WebUI（源码 + 构建产物 dist）
│   ├── plugins/                 #   用户自定义插件目录（gitignore 排除）
│   ├── scripts/
│   │   ├── install.sh           #   一键脚本（UNIX/macOS）
│   │   ├── install.bat          #   一键脚本（Windows）
│   │   ├── service.sh           #   systemd/守护模板
│   │   └── backup.sh            #   ★ 备份：data/period 整包 + secret.key（必须一起）
│   ├── docs/                    #   使用文档（一键脚本首启打印的摘要来源）
│   └── data/                    #   运行时数据（SQLite/密钥/日志，gitignore）
│       ├── tmp/                 #   临时（debug 完整头文件、环形缓冲落盘）
│       └── period/              #   长期（SQLite、secret.key、配置）
└── functions/api/proxy.js       # CF 版保留（协议同源，双端同步演进）
```

## 4. 设计约束（硬性）

### 4.1 协议兼容（最重要）
`POST /api/proxy` 契约与 functions/api/proxy.js **完全一致**：
```json
{ "url": "<完整目标URL>", "method": "GET|POST|PUT|DELETE", "headers": {...}, "body": "<JSON字符串|null>" }
```
响应：原样透传状态码 + body + content-type；CORS 头 `Access-Control-Allow-Origin: *`；
回传头 `x-pugs` / `x-quark-pus` / `x-quark-puus`（Expose-Headers 放行）。
校验顺序：X-Proxy-Token（timingSafeEqual）→ URL scheme/域名白名单 → （可选）限频 → 转发。

**端口：不要用 8787/8788 这类常见端口（容易被猜到）。** 首启在 20000–60000 随机生成、
持久化到 config，启动横幅打印；允许自由设置（重启服务生效）。

### 4.2 响应完整性（v1.2.1 修正）
- 转发时**与挂 CF 一个规格**：不保留全部响应头（set-cookie 等不回传给 SPA）
  ——即使代理地址+令牌暴露公网，对方也拿不到 set-cookie 请求头（wrangler 本来就不放行）
- **完整响应头只记录到本地日志**（这是魔鬼测试的核心能力，CF 看不到的这里可查）：
  - DB 存**脱敏版**（凭据值 SHA-256 区分即可，研究的是 cookie 组合方式）
  - 完整请求/响应头进 **debug 级本地文件**（`data/tmp/`，权限 600，自动轮转 + 保留天数）
- **set-cookie 自动合并回账号池**（mergeSetCookies，同 1.1.9.1 前端 __puus 合并逻辑同构）
  ——研究能力顺手变成 cookie 自动续期的生产能力

### 4.3 安全
- cookie 库 AES-256-GCM 加密；密钥文件 `data/period/secret.key` 权限 600，随机生成
- **webui 只允许 127.0.0.1**（代码硬绑，配置需显式改 + 启动 warning）；proxy 默认 127.0.0.1，
  要对外才 0.0.0.0（网络配置页有"对外暴露"开关，开启需二次确认）
- webui 首次启动打印**一次性令牌**；密码 scrypt 哈希入库，可改；
  危险操作（白名单增删/令牌轮换/账号池修改）需**秘钥**二次确认（token = 门禁，秘钥 = 保险柜钥匙）
- 本地 webui 的威胁不是公网，而是**恶意网页打 127.0.0.1**（DNS rebinding）：
  Host 头校验 + Origin 校验 + CSRF token + 随机端口，四件套全做
- 系统终端（xterm.js）**默认关**，独立开关开启；会话用**长期令牌**鉴权（首启 CLI 随机生成）；
  终端命令全部写 audit 日志
- 分流插件"登录态"**默认全关**：公网部署强制游客（防登录 cookie 泄露给公网），
  仅本机/内网部署可显式开启
- cookie 相关日志一律脱敏（已知凭据名 `__pus`/`__puus`/`__pugs`/`__uid`/`sdid` 的值只存 SHA-256）
- **IP 记录与封禁**：记录直连 remoteAddress（X-Forwarded-For 可伪造，不可信）；
  N 次鉴权失败/超限频/窗口 → 临时封 IP M 分钟（默认关，公网建议开）
- 校验细节：token 比较用 `crypto.timingSafeEqual`；URL scheme 必须 http/https；
  限频在转发之前；白名单增删 = 高危操作，需秘钥确认（直接扩大 SSRF 面）

### 4.4 插件
- 单文件 JS（CJS/ESM 均可），放 `backend/plugins/*.js`，webui 插件管理页开关
- 钩子：`onProxyRequest`（可改请求头/拦截）、`onProxyResponse`（可读完整响应头）、
  `onNotify`（事件）、`onTask`（排队任务事件）、`onLogs`（日志流）
- 内置插件也是普通插件（走同一加载器），可被禁用
- CDP 位置：**插件化，默认关**（自动取 cookie 需要用户先手动点授权，不是魔法）

### 4.5 日志与看板
- 级别：fatal/error/warn/info/debug；内存环形缓冲（如 1000 条）+ SQLite 落库（轮转）
- webui 实时日志：按级别/网盘/关键字 filter（同 debug 终端输出）；
  队列长度/等待时长（proxy_logs.queued_ms）写进 debug 级日志
- 数据看板：柱形图（天 × 网盘 × 操作：scan/prase/其他）+ 调用明细表
  （时间/网盘/操作/状态码/耗时/命中的 cookie 账号/是否排队）
- 单次调用日志 = 该请求的完整请求头 + 响应头 + body 摘要；
  **不直接展示请求头，提醒"秘钥鉴权后查看完整日志"**（数据看板入口需秘钥）

### 4.6 启动模式与一键脚本
- **debug**：前台运行，终端实时日志，关终端即停
- **server**：守护进程；打印必要说明（地址/令牌/如何查看日志/如何停止）后按任意键关窗
- 一键脚本（install.sh / install.bat）：
  1. 从 GitHub 主站 + 镜像站列表**自动测速选最快源**拉取必要文件（node 检测/自带运行时可选）
  2. 检测首次运行 → 打印：如何开启/关闭、如何查看文档、webui 地址与令牌
  3. 复用系统 node（≥20）优先，缺失则提示/拉取便携版
- **backup.sh**：data/period 整包（SQLite + secret.key + config）打包备份；
  文档明示：secret.key 与 DB 必须一起备份，密钥丢失 = cookie 全废

### 4.7 白名单与限频
- 域名白名单默认继承 CF 版（uc.cn / quark.cn），webui 可增删（存库，需秘钥）
- 限频：可选（默认关，防家庭组误伤；公网建议开），按 IP + 按令牌双维度

### 4.8 websocket（v1.2.1 新增）
- 用途 = **长时间通知推送**（电脑部署、手机看有没有异常；内侧组可能给新想法）
- 权限与 CF 一致，可对外公开；但**只读推送**（日志流/通知事件），控制操作永不走 ws
- 鉴权：**首条消息鉴权**（token 不放 URL query——会进访问日志）；鉴权前不推送任何数据

## 5. 数据模型（SQLite 草案）

```sql
-- 账号 cookie 池（加密存储 value）
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  pan TEXT NOT NULL,              -- 'quark' | 'uc' | ...
  label TEXT,                     -- 备注名（如 "家庭-1号"）
  cookie_enc TEXT NOT NULL,       -- AES-256-GCM 密文（含 iv/tag 前缀）
  expires_at INTEGER,             -- 已知过期时间（可空）
  status TEXT DEFAULT 'ok',       -- ok | expired | risk
  last_used_at INTEGER,
  created_at INTEGER, updated_at INTEGER
);

-- 调用日志（完整响应头进 debug 本地文件；DB 只存脱敏版）
CREATE TABLE proxy_logs (
  id INTEGER PRIMARY KEY,
  ts INTEGER,                     -- 时间戳 ms
  pan TEXT,                       -- 命中白名单的网盘（可空）
  operation TEXT,                 -- scan | prase | other（按 URL 特征归类）
  method TEXT, url TEXT,
  req_status INTEGER,             -- 上游状态码
  duration_ms INTEGER,
  account_id INTEGER,             -- 命中的 cookie 账号（可空）
  queued_ms INTEGER,              -- 排队等待时长
  probe_key TEXT,                 -- ★ 单次调用 = 浏览器指纹 + SPA 输入链接 hash；
                                  --   同 key 多次解析允许复写（cookie 组合试探）
  client_ip TEXT,                 -- 直连 remoteAddress（XFF 不可信，不存）
  req_headers TEXT,               -- 脱敏后的请求头 JSON（凭据值 SHA-256）
  resp_headers TEXT,              -- 脱敏响应头 JSON（set-cookie：名 + flag + 值 SHA-256）
  body_preview TEXT               -- 响应 body 前 500 字
);

-- 配置（白名单/限频/令牌等，敏感字段加密）
CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT);

-- 管理操作审计（谁在什么时候改了什么）
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER,
  action TEXT,                    -- 改白名单/令牌轮换/账号池修改/终端命令/插件开关
  detail TEXT,
  via TEXT                        -- webui | cli | terminal
);
```

## 6. WebUI（左栏，参考 napcatqq）

| 页面 | 内容 |
|---|---|
| 基础信息 | 服务器 cpu/内存/系统、host 版本、运行时长 |
| 网络配置 | http/ws 服务监听（proxy 端口 + 对外暴露开关 + 令牌轮换按钮）、webui 端口（只读展示） |
| 实时日志 | 同 debug 终端，支持 fatal/info 等 filter + 网盘过滤 + 队列状态（debug 级） |
| 数据看板 | 使用记录柱形图（天×网盘×操作）+ 调用明细 + 单次调用完整头（**秘钥鉴权后查看**） |
| 插件管理 | 内置/自定义插件列表、开关、配置（CDP 插件在这里开启） |
| 系统终端 | xterm.js CLI 管理 host（默认关；长期令牌鉴权；命令全审计） |
| 系统配置 | 白名单（增删需秘钥）/限频/通知渠道/账号池/CDP（remote_debugging 地址） |

## 7. 内置插件（初版）

### ① split.js —— 分流开关
- 矩阵：网盘 × 操作（scan/prase） × 登录态（游客/登录）
- 例：夸克 prase 大文件 → 登录态（走账号池）；scan → 游客；UC → 全游客
- 防爆破：公网部署强制游客；登录态请求记录账号 + 限频
- webui 表格化配置，默认值 = 全游客

### ② monitor.js —— 过期/风控通知
- 来源：① webui 粘贴其他设备 cookie（无 GUI 服务器）；② 服务端 CDP 浏览器登录导出（可选插件）
- 导入后询问是否**绑定浏览器**（CDP remote_debugging）→ 过期自动取新 cookie
  （需要用户先手动点授权；CDP 关闭时仅通知不自动续期）
- 事件：账号过期、23018 频繁触发（疑似风控）、账号下线（account/info 失败）
- 通知渠道：webhook / ntfy / Server酱 / pushplus / 自定义 URL /
  **浏览器系统通知**（webui 页面打开时，Notification API，零 CDP）

## 8. 排队机制（家庭组）

- 全局任务队列 + 每账号并发限额（如 2 并发/账号）
- 同一网盘 burst（批量 prase）自动排队 + 节流（对齐 SPA 侧 15/批 + 1s）
- **排队 TTL + 总超时**：单个请求排队超时/总耗时超限直接失败——防止一个挂死的
  上游请求堵死整条队列（上游超时 20s 封顶，同 CF 版）
- webui 可见队列长度/等待时长（proxy_logs.queued_ms，debug 级日志）

## 9. 板块化开工顺序（v1.2.1 调整：存储提前）

1. **骨架**：package.json + index.js（debug/server 分发）+ config/密钥 + 随机端口
   + **双 listener 骨架**（proxy / webui 分离，webui 硬绑 127.0.0.1）
2. **存储 + 核心转发**：db.js（SQLite + AES-GCM + audit 表）+ server.js/proxy.js
   （协议兼容 + 白名单 + timingSafeEqual + 完整头记录 + **set-cookie 合并**）+ 契约对拍测试
3. **账号池 + 首启令牌**：cookies.js + auth.js（webui 令牌/秘钥/会话）
4. **WebUI**：基础信息/网络配置/实时日志/数据看板（Preact）
5. **插件**：加载器 + split.js + monitor.js（通知 + 浏览器系统通知 + CDP 可选）
6. **排队 + 系统终端（默认关）+ 备份脚本 + 文档完善**

## 10. 开放问题（待定）

- 是否内置"取号"（扫码登录夸克/UC）→ 涉及滑块验证码，初版不做，留插件位
- 二进制分发 vs 源码 + node：初版源码 + 检测 node；后期可考虑 pkg 打包
- ws 客户/服务端协议细节：已定"只读推送 + 首条消息鉴权"，具体帧格式插件期定；
  内侧组若有新想法（如手机端异常告警）再扩展
