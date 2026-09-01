# backend × wrangler 关系设计稿 v1.2.2（定稿）

> 状态：**v1.2.2 定稿**，取代 v1.2.1。ws/CDP 全部移除；链路与 trace 收口方案经 2026-08-29 与 Tzz 逐条探讨后冻结。
>
> 一句话：**proxy.js 双人格（本地 = backend hop 的尾端转发引擎 / 云端 = CF 独立入口），trace 双 sink（本地 SQLite 单库 / 云端 D1），backend = 账号池保险箱 + 看板。ws/CDP 移除与 transport 抽象一样是 next 架构的里程碑。**
>
> 相关材料：`docs/transport.md`（代理协议）、`functions/api/proxy.js`（唯一转发实现）、`backend/`（本稿改造对象）、`README.md`（使用）。

---

## 0. 相对 v1.2.1 的变更（2026-08-29 冻结，勿回退）

| 项 | v1.2.1 | v1.2.2 |
|---|---|---|
| ws/CDP | P3 计划：backend 连 wrangler inspector ws 消费 Network 事件 | **全部删除**。9229 是 devtools 协议，非应用可消费；trace 改源头收集（hop / D1），不再需要补洞 |
| 请求链路 | SPA → backend(hop) → wrangler → 上游 | 本地：SPA(CDN) → backend(hop) → wrangler(loopback) → 上游；云端：SPA(CF) → proxy.js(CF) → 可选 BACKEND_URL 取 cookie → 上游 |
| SPA 托管 | wrangler pages dev 托管源码树 | **不本地托管**，SPA 走 CF/GitHub CDN 加载。B 端员工只拿 proxy_address + proxy_token，接触不到管理面板 |
| trace | hop 全量落库（req_body/resp_body 64KB） | **两阶段写入** + resp_body 不再落库（完整 body 只进 `data/tmp/debug-*.log`）+ **file_hits 表**（文件级 fid/md5/name/size） |
| 存储 | SQLite（本地） | 本地 **SQLite 单库**；云端 **D1**（env `TRACE_D1=1` 运行时开关，**不注释源码**） |
| 指挥中心 | `/api/proxy-config` SPA 自动发现（下发 token） | 端点保留但**收紧**：Host 限 127.0.0.1/localhost、**不再返回 token**；SPA 改手动配置 proxy_address+proxy_token |
| 账号池 | 注入/合并（v0.1.0） | + **cookie 刷新定时器**（P2，quark 优先）+ `POST /api/proxy/cookie-pick`（云端取号端点） |
| IP | client_ip 原样落库 | 前端开关**默认关** + consent 头 + **sha256(ip+salt)**；B 端局域网部署时 backend 直接看到员工浏览器 LAN IP（有效信号） |
| launcher | scripts/launcher.sh；`--binding` 传 token；debug 用 tee 管道 | **挪到 backend/launcher.sh**；`.dev.vars` 自动生成（PROXY_TOKEN + TRACE_D1=0）；**debug 到底**（wrangler 真 TTY 零管道）；`PANHUB_NO_SPAWN`=不 spawn 但 attach |
| 新增 | — | scripts/selfhost.sh（codeload tarball 引导拉取）；webui Network 页 wrangler 健康 widget + devtools 彩蛋按钮；看板「<>」展开 + 重复检测 Tab；日志保留期设置 + 手动清理 |
| 隐私 | 无 | §11 隐私声明（记录内容/目的/保留期/IP 哈希化） |
| stoken/分享追溯 | — | **明确不存**（无 stoken、无 share_hash）。滥用检测 = file_hits 频次 + account_id + 可选 IP；scan 不记录、不加 cookie（游客态，无需追溯） |

---

## 1. 架构：双人格

### 1.1 本地/自托管（B 端主力形态）

```
员工浏览器(SPA@CDN) ──proxy_address + proxy_token──▶ backend 单 listener（proxy.host 绑 0.0.0.0）
      │  /api/proxy hop：token 校验 → 账号注入(pickAccountForPan) → 两阶段 trace → 转发
      ▼ loopback (~1ms)
   wrangler pages dev（127.0.0.1，仅本机回环）执行 functions/api/proxy.js
      │  白名单 / 限频 / 转发（校验策略唯一实现，与 CF 同源）
      ▼
   上游网盘 API
```

- backend 挂 → SPA 回落用户自填 cookie（现状行为，可用性不依赖 backend）。
- wrangler 面板照常一行行 `POST /api/proxy 200 OK`（backend 转进来的流量，Tzz 的熟悉感保留）。
- **管理面板隔离**：`/api/web/*` 的 Host 检查只放行 127.0.0.1/localhost（`backend/src/auth.js hostAllowed` 现成）——即使 listener 绑 0.0.0.0，LAN 直连 `http://<内网IP>:port` 也自动 403；管理员 ssh 隧道 `-L` 查看。**无需双 listener**。
- 员工凭据 = proxy_address + proxy_token，无 webui 令牌，登录不了管理面板。

### 1.2 云端（CF Pages 部署，代理公开给用户）

```
SPA(CF 同域) → POST /api/proxy → proxy.js(CF)
    ├─ env.BACKEND_URL 存在 → POST {BACKEND_URL}/api/proxy/cookie-pick {pan, operation}
    │    （X-Proxy-Token = env.PROXY_TOKEN；800ms 短超时；可用性缓存 5s，避免每请求探测）
    │    成功：注入 cookie + 记账号标签 → 响应回传 x-panhub-account
    │    失败/超时：回落 SPA 自带 cookie（现状行为，前端等待用户 cookie input）
    ├─ env.TRACE_D1 === '1' && env.DB → ctx.waitUntil 两阶段写 D1（proxy_logs + file_hits，schema 与本地同构）
    └─ 上游响应回传（x-pugs / x-quark-* 照旧）
```

- **云端永不落 cookie 明文**：D1 只存 account_id/账号标签；cookie 只在进程内存里转发 → 安全隔离。
- 没有 backend 的纯 CF 公共代理：cookie-pick 分支自然不触发，行为 = 现状。

### 1.3 硬约束（沿用 v1.2.1，不破坏）

1. **proxy.js 唯一转发实现**：云端/本地同一份代码，改完本地 `wrangler pages dev` 一跑 = 云端预演。
2. **校验策略只属于 proxy.js**：token / 白名单 / 限频。backend 不重复实现（只做 hop 的 X-Proxy-Token 校验）。
3. **账号策略只属于 backend**：注入哪个账号、轮转、刷新、set-cookie 合并回写，proxy.js 不感知（云端经 cookie-pick 取号）。

---

## 2. 存储 schema（本地 SQLite 与云端 D1 同构）

### 2.1 proxy_logs（请求级）

列：`id, frontend_id TEXT, ts, pan, account_id, operation, method, url(300), req_status, duration_ms(总耗时), req_ms(上游耗时), client_ip(哈希或空), via('hop'|'cloud'), body_preview(500)`

- 迁移（幂等）：`ALTER TABLE proxy_logs ADD COLUMN frontend_id TEXT DEFAULT ''`（沿用 db.js columnExists 轻量迁移模式）。
- `req_body` / `resp_body` 列保留但**不再写入**（防磁盘膨胀）；`req_headers` / `resp_headers` 列同样不再写入（完整头/体只进 `data/tmp/debug-*.log`）。detail 视图的文件级信息改由 file_hits 提供。

### 2.2 file_hits（文件级，批量解析 N 文件 = N 行）

```sql
CREATE TABLE IF NOT EXISTS file_hits (
  id INTEGER PRIMARY KEY,
  frontend_id TEXT,
  ts INTEGER,
  pan TEXT,
  account_id INTEGER,        -- 命中账号 id（可空）
  client_ip TEXT,            -- 哈希化 IP（可空）
  fid TEXT,
  md5 TEXT,
  file_name TEXT,
  size INTEGER,
  category INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fh_fid ON file_hits(fid);
CREATE INDEX IF NOT EXISTS idx_fh_md5 ON file_hits(md5);
CREATE INDEX IF NOT EXISTS idx_fh_ts  ON file_hits(ts);
```

- 提取白名单：**fid / file_name / md5（必须）**，pdir_fid / size / category / obj_key（可选）。OSS 直链、thumbnail、preview、`_extra` 等一律丢弃。
- 响应体解析失败**不阻断请求**（try/catch，落 warning 日志即可）。

### 2.3 保留期（长期存放 + 定时清理，不是缓冲区）

- settings 键 `log_retention_days`（默认 30）。
- 清理时机：backend 启动时执行一次 + 每小时定时（DELETE 两表 `ts < now - days`）。
- webui 设置页可改天数（**重启后生效**——按 Tzz 定）；另有「手动清理」按钮（POST `/api/web/logs/purge`，body `{days}`，days 省略 = 全清）。

---

## 3. 两阶段写入（本地 hop 与云端 D1 同一语义）

1. **请求开始**：INSERT(proxy_logs: frontend_id, ts, url, operation, method, client_ip, via)
2. **请求结束**：UPDATE(proxy_logs: pan, account_id, req_status, req_ms, duration_ms, body_preview) + 批量 INSERT(file_hits)

- 上游挂/中途失败：行留在 `req_status IS NULL` → webui 看板标**严重警告**。**错误分支处理不做**（两阶段天然留痕）。
- `frontend_id`：SPA 的 ProxyTransport 每次请求生成 `crypto.randomUUID()` 写入协议体 `{ url, method, headers, body, frontend_id }`；后端缺失时兜底生成（`crypto.randomUUID()`），保证日志完整。
- operation 分类沿用 `classifyOperation`（`/sharepage/(token|detail)` → scan；`file/download` → prase；其余 other）——从 `backend/src/proxy.js` 提取为共享逻辑。

---

## 4. 端点契约（新增 / 变更）

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `POST /api/proxy` | X-Proxy-Token | hop（现状 + 两阶段 trace + file_hits） |
| `POST /api/proxy/cookie-pick` | X-Proxy-Token | body `{pan, operation}` → `{cookie, account_id, tag}`；无正式账号 → guest 生成（随机 __pugs，label guest#）。**云端 proxy.js 专用**；本机 hop 复用同一 pickAccountForPan 逻辑 |
| `GET /api/proxy-config` | Host 限 127.0.0.1/localhost | **收紧**：不再返回 token（防 0.0.0.0 下泄露），只回 `{ok, initialized, proxyUrl, version}`；launcher 就绪探测继续用它 |
| `GET /api/web/stats` | webui | 行加 frontend_id + `warning`（req_status IS NULL → true） |
| `GET /api/web/calls/:id/detail` | webui | 返回完整行（脱敏）+ `file_hits` 列表 |
| `GET /api/web/abuse?pan=&by=fid\|md5&days=&min=&limit=` | webui | 重复检测：`SELECT fid/md5, file_name, COUNT(*) c, MAX(ts) FROM file_hits WHERE ts>=? AND pan=? GROUP BY 1 HAVING c>=? ORDER BY c DESC LIMIT ?` |
| `POST /api/web/logs/purge` | webui | body `{days}` 手动清理日志（两表） |
| `GET /api/web/settings` / `POST /api/web/settings` | webui | 加 `log_retention_days` |
| `GET /api/web/info` | webui | 已有 wrangler 健康字段，Network 页直接用 |

---

## 5. launcher（挪到 backend/launcher.sh）

命令表不变：`setup | start | stop | status | restart | debug | logs | build | backup | reset`（含 `--` 前缀兼容）。

- **debug 到底**：wrangler 前台 **真 TTY 零管道**（不 tee、不重定向 —— tee 会吞 TTY 导致 b/d/e/t/c/x 面板失效）；backend `nohup` → backend.log。有 tmux：左 pane wrangler、右 pane `tail -f backend.log`（不是 tee）。
- **PANHUB_NO_SPAWN 语义**（`backend/src/wrangler.js`）：`=1` 时**跳过 spawn 但允许 attach**（健康监听 / stdout 解析照常）。测试场景 attach 探测失败自然降级 off，行为兼容。
- **.dev.vars 自动生成**：setup/start 时检测仓库根 `.dev.vars`；不存在或其中 PROXY_TOKEN ≠ config.json → 写入：
  ```
  PROXY_TOKEN=<config.json proxy.token 同一把>
  TRACE_D1=0
  ```
  wrangler 启动**不再传 `--binding`**（wrangler pages dev 自动读 cwd 的 .dev.vars）。`.dev.vars` 已在 root .gitignore，不进归档。
- **绑定**：默认 127.0.0.1；B 端显式 `PANHUB_BIND=0.0.0.0 ./backend/launcher.sh start`（webui 的 Host 检查自动挡掉 LAN 直连管理面板，见 §1.1）。
- wrangler 端口避让 + 写回 config.json（沿用 v1.2.1 实现）。

---

## 6. scripts/selfhost.sh（引导脚本；Windows PowerShell 后续同构）

交互流程：

1. **选择题 1**：拉取范围 —— 完整源码（y）/ 管理端 = docs + backend + functions + scripts（默认 否）。管理端不含 SPA（SPA 走 CDN，见 §1.1）；**functions 必须带**（proxy.js 是唯一转发实现，缺了 hop 直接 502）。
2. **目录检测**：按选择检查目标文件夹是否存在。
3. **无 → 拉取**：测速 + 下载 —— **codeload tarball 优先**（`https://codeload.github.com/tzz1021/panhub_praser/tar.gz/refs/heads/<branch>`，免 git 协议免登录），ghproxy 类镜像兜底；sha256 校验（发布时在 README 注明）；tar 解压覆盖。
4. **有 → 选择题 2**：检测到已有源码，拉取最新并逐个覆盖写入（默认 是）y/N/回车。覆盖只动归档内的文件，**不影响仓库中不包含的文件** —— backend/data（gitignore 不在归档）与 .dev.vars（gitignore）天然保留。
5. 完毕打印：`必要资源在 $WORK_DIR 就绪 / 使用文档在 $WORK_DIR/docs / 后端管理脚本在 $WORK_DIR/backend/launcher.sh`。

---

## 7. webui 变更（管理面板）

- **Network 页**：新增「wrangler 健康检查」widget（inspectorPort / inspectorWs / lastLine，数据来自 `/api/web/info`，只读展示，**不做真 ws 客户端**）+ 「打开 wrangler devtools」按钮 → 弹窗文案：
  > 由于 ws 限制，现在即将开启 wrangler 自带的 devtools。如果 wrangler 不在本机运行（比如 ssh 穿透 webui），这里不能转发 devtools，请去系统终端完成穿透。
  → 确认后 `window.open('http://127.0.0.1:<inspectorPort>')`（仅本机部署有意义，非服务器查看显示 off 无需在意）。
- **数据看板（Stats）**：
  - calls 列表行内新增「<>」按钮 → 展开详情（GET `/api/web/calls/:id/detail`）：请求摘要 + file_hits 列表（fid / file_name / md5 / size）+ 状态/耗时。
  - `req_status IS NULL` 的行 → 红标「严重警告」（请求未完成）。
  - 新增「重复检测」Tab：选网盘 pan + 回看天数 + 按 fid/md5 分组，count 超阈值列出（fid、file_name、次数、涉及账号、最近时间）→ 暴力解析检测。
- **设置页**：日志保留天数（`log_retention_days`）+ 「手动清理日志」按钮。

---

## 8. SPA（前端）变更

- transport 协议体加 `frontend_id`（ProxyTransport 每次请求 `crypto.randomUUID()`）。
- preferences 加「IP 采集（哈希化后上传）」开关，**默认关**；开时请求带 `x-panhub-trace: ip-hash` 头。副标文案：「已加密后上传到 proxy，这是企业内辅助判断滥用行为的，日用不需要开」。
- 响应带 `x-panhub-account` 时，CookieInputModal / 结果页显示「代理托管账号：\<label>」（如 平静的花椰菜 / 家庭组3号 / guest#2，**不暴露明文 cookie**）。
- 删除 command-center 自动发现相关设想（未实现过，无遗留）。SPA 用现有 proxyUrl + token 设置项手动配置。

---

## 9. 分阶段（本轮全部落地）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0** | launcher 挪 backend/ + debug 到底 + NO_SPAWN 语义 + .dev.vars 自动生成；scripts/selfhost.sh；README 路径更新 | `./backend/launcher.sh debug` 面板出现且无管道；setup 后 .dev.vars 生成；selfhost.sh 干跑通过 |
| **P1** | backend trace v2：两阶段写入 + file_hits + 保留期清理 + proxy-config 收紧 + cookie-pick 端点 + stats/detail/abuse/purge 端点；webui 看板改版 + Network widget + 设置页 | hop-smoke 26/26 绿；webui build 通过；看板能看到 file_hits 与严重警告 |
| **P2** | cookie 刷新定时器（quark 优先：轻量登录态接口触发 set-cookie → mergeSetCookies；默认 2h；连续失败 3 次标 expired） | 定时器启动无异常；quark 刷新 URL 待真机验证（标记 TODO） |
| **P3** | functions/api/proxy.js 云端分支：BACKEND_URL cookie-pick + TRACE_D1 D1 双 sink + x-panhub-account 回传 | 本地无 BACKEND_URL 时行为完全不变（回归） |
| **P4**（后续） | 云端 set-cookie 回抛 backend；launcher.bat；过期 webhook 通知 | — |

---

## 10. 风险与取舍

| 风险 / 取舍 | 说明与对策 |
|---|---|
| 单 listener 绑 0.0.0.0（B 端） | `/api/web/*` Host 检查只放行 127.0.0.1/localhost（现成），LAN 直连 403；`/api/proxy-config` 同样收紧且去 token；`/api/proxy` + `/api/proxy/cookie-pick` 靠 X-Proxy-Token（员工本来就持有） |
| 双 hop 性能 | 本地 loopback 多一跳 ~1ms；换取 wrangler 面板可见 + 校验策略单一实现（沿用） |
| D1 免费额度 | 写入 100k 行/天、5GB 存储；日志量可控（修剪 + 保留期）；云端非主力（注入 cookie 属高危操作，公共代理使用少） |
| 云端无 backend | cookie-pick 分支不触发，回落 SPA 自带 cookie（现状） |
| `.dev.vars` vs `--binding` | 只保留 .dev.vars（launcher 自动生成，同一把令牌）；不再并存，避免漂移 |
| 上游 set-cookie 云端不回抛 | 本地 hop 的 mergeSetCookies + P2 刷新定时器覆盖主场景；云端回抛留 P4 |
| wrangler 版本行为漂移 | stdout 解析失败原文入库；inspector 只作健康检查，不消费（砍掉 CDP 后无耦合） |
| IP 隐私 | 默认不采集；企业开启后 sha256(ip+salt) 哈希化 + 保留期 + 可手动清理；README 声明 |

---

## 11. 隐私声明（README 引用，用户可见）

- **记录内容**：请求级（时间 / 网盘 / 操作 / 状态 / 耗时）+ 文件级（fid / md5 / 文件名 / 大小）+ 命中账号标签。
- **目的**：滥用检测（同一文件/分享被高频解析、账号异常）、企业账号审计。
- **IP**：默认不采集；企业开启后以 sha256(ip+salt) 哈希化存储，保留期默认 30 天可配，支持手动清理。
- **不存**：cookie 明文（账号池内 AES-256-GCM 密文）、stoken、分享链接。解析出的 OSS 直链不进库。
- 对开源项目更倾向于自托管而非公共服务器（已在 README 说明）；使用最轻量的 node 作为后端语言。
