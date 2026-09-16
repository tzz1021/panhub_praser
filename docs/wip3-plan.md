# wip3 定稿草案（v0.1 · 2026-09-15）— 待 Tzz 审后开工

> 来源：Tzz 2026-09-15 草案（内测组反馈）+ 上次草案（`docs/STRUCTURE.md`「插件体系（草案）」「后端待办（草案）」）
> 与既有定稿（`docs/backend-wrangler-plan.md` v1.2.2）的关系：本文件只补/改，不推翻；冲突处在 §6 列明。
> 状态：**未实现**。审查通过后按 §7 分批开工；每批实现完回填 `docs/changelog.md`。

## 0. 结论速览

1. 这批改动跨 **SPA / functions / backend** 三层且互不相关 → 建议拆 **4 批**落地（§7），
   每批独立可验收；其中 P2↔P3 必须同步部署（端点改名），故**必须做双端点兼容窗口**。
2. 我提了 **30 余条实现级建议**（标 🟢）与 **12 项待拍板**（标 ❓，汇在 §8）。
3. 上次草案的 4 条后端待办（随机选号 / 写 auth 解码展示 userId / 长期定位数据 / alipan 滚动更新）
   在本轮草案里各自找到了落点 → §6 给出合并后的归属。

## 1. 现状核实（代码级，评估依据）

| 事 | 现状 | 证据 |
|---|---|---|
| 操作词表 | 只有 `scan` / `prase` / `other` 三类，散落云侧与 backend 两处最小复制 | `functions/api/proxy.js:154-162`、`backend/src/proxy.js#classifyOperation` |
| functions 目录 | **只有一个文件** `functions/api/proxy.js`（转发引擎 + 取号 + trace 全在里面，~600 行） | `find functions` |
| hop 端点 | `/api/proxy`（增强 hop）、`/api/proxy/cookie-pick`（云端取号）、`/api/proxy-config` | `backend/src/server.js:613-621` |
| 取号 gate | 云端仅 `operation==='prase'` 且 `pan !== 'alipan'` 时取号 | `functions/api/proxy.js:445,454` |
| 账号读取 | `listAccounts()` 返回 `cookieTail`（尾 8 字符）/`cookieLength`/`keys`；面板表格直接显示 | `backend/src/cookies.js:56-76`、`backend/webui/src/pages/Settings.jsx:200-215` |
| 账号明文读 | `getAccount()` 返回整串；HTTP 层 `GET /api/web/accounts/:id` 现返回 `cookieString: undefined`（`cookie_enc` 存在时）→ 编辑表单实际回填空 | `backend/src/cookies.js:79-83`、`server.js:419-423` |
| 写路径 | 面板写入 = 二次输入 WebUI 令牌；CDP/转发写入均走 `upsertAccount()` + 审计 | `Settings.jsx:42`、`server.js:409-418` |
| wrangler inspector | 9229 已明确「仅普通 ws 健康监听，非 CDP」 | `backend/src/wrangler.js:9-11,98` |
| 插件管理页 | 前端页面存在并请求 `/api/web/plugins`，**后端没有该端点** → 页面停在「加载中…」 | `backend/webui/src/pages/Plugins.jsx:7-16`；`grep plugins backend/src` 无命中 |
| 滚动更新（上轮已实现） | SPA 侧缓存 + `Transport.hopAccounts` 探 `GET {代理}/api/hop/accounts` | `src/adapters/alipan/carry.ts`、`src/core/transport/types.ts#HOP_ACCOUNTS_PATH` |

## 2. 前端：凭据快捷更新（A）

### 2.1 定稿行为（按 Tzz 草案）
1. **同账号复用**：粘贴新凭据时，只含 `auth` 不冲掉上次的 `drive_id` / `to_parent_file_id`；
2. **账号变了才弹窗**（标题「是否覆盖当前暂存区的 userid」，正文「账号信息复用包含 userid 的临时 auth，
   对应 drive_id 和 to_parent_file_id」），阿里云盘**特设强制开启**，注册在结果页；
3. **选「否」= 本次输入仅本次有效**；**账号不同且三项不齐 → 前端拦截，不惊动 functions**；
4. `drive_id` 绑定 userId（已有离线校验）；`to_parent_file_id` 的转存副本需要定期清理。

### 2.2 我的建议
- 🟢 **根治点是"合并写入"而不是弹窗**：`setAlipanAuthString()` 目前整串覆盖（`adapters/alipan/auth.ts`），
  改为「解析新输入 → 与暂存串按字段合并（同账号时才补 drive_id/to_parent_file_id）」。
  上轮已做的 `Bearer xxx` 裸形态解析正好让"只粘贴 auth"成为合法输入 → 一行合并逻辑即可消除 80% 的困扰。
- 🟢 **"仅本次有效"必须有内存态通道**：当前凭据唯一来源是 localStorage 读取
  （`getAlipanAuthString()`）。建议 `auth.ts` 增加 `setAlipanSessionAuth(str)`（内存 override，
  优先级 session > localStorage，prase 结束/退出页面即失效），否则"仅本次有效"落不了地。
- 🟢 **"上次使用的账号"需要独立存储**：建议新增 `pan-web:alipan-last-account:v1 { userId, driveId, toParentFileId, updatedAt }`，
  写入时机 = 凭据保存成功 / prase 成功各一次。**不要复用 carry 缓存**：carry 只在"发生 copy 后"才有值，
  且它是转存映射（换号整条重置），语义不同会互相污染。且 last-account 也应是弹窗判定的唯一依据。
- 🟢 **触发时机放"保存凭据"这一刻**（而不是 prase 之后）：用户刚粘贴、上下文清晰，且天然满足
  "不惊动 functions"（拦截在发请求之前）。建议流程：
  `CookieInputModal 保存` → 解析新串 → ① 同账号：静默合并暂存（绿字提示沿用上轮）
  → ② 账号不同：弹「是否覆盖」→ 是 = 覆盖暂存 + 作废旧账号 carry 映射；否 = 仅内存态本次有效。
- 🟢 **"三者写全"的判据要写成一句话规则**：账号不同且（新串缺 drive_id 或 to_parent_file_id 或暂存里也没有）
  → 保存时红字提示缺失字段，**不写入、不发起 prase**。别用 toast 一闪而过，建议留在弹窗里（可操作）。
- 🟢 **副本清理分两档**（转存副本 `xxx(2)` 累积是产品级痛点，但 `file/delete` 是敏感接口）：
  - P1（本期）：carry/足迹记录"上次转存时间 + 条数"，结果页给一行提示 + 文档教用户在 alipan 客户端清空暂存目录；
  - P2（另开）：按 carry 记录的原/新 file_id **精确删**转存副本（只删我们写入过的 id，绝不按目录扫删），
    需 `Authorization + drive_id`，且要二次确认 + 审计。
- 🟢 **话术外置延续上轮**：弹窗 title/context/按钮文案进 `adapters/alipan/types.ts` 常量区（如
  `ALIPAN_ACCOUNT_SWITCH_MESSAGES`），适配器能力对象带 `accountSwitchPrompt`，UI 只渲染。
  组件建议新文件 `AccountOverwriteModal.tsx`（不要让 CookieInputModal 再长一层）。

### 2.3 待拍板
❓ A1「上次使用的账号」= 我建议的新存储（而非复用 carry）；如坚持复用 carry，需接受"没转过存就没有上次账号"。
❓ A2 选「否」后，本次用的 `to_parent_file_id` 若属于旧账号会 403 —— 是否在"否"分支强制要求填 `to_parent_file_id`？
❓ A3 副本清理：本期只做提示（P1），还是连 `file/delete` 一起做？

## 3. 中层：操作四类规范（B）

### 3.1 定稿（按 Tzz 草案）
`scan`（免登录：分享临时凭据 + 分享目录 list）· `download`（取直链 / OSS 相关上游请求）·
`restore`（转存，取代 `copy`）· `credential-pick`（取号，取代 `cookie-pick`，含"后端是否存在"标识；CF 侧不引入长期凭据）。

### 3.2 我的建议
- 🟢 **必须补一张"判据表"**（否则三处实现又会漂移）。建议（以 URL 特征为准，附现有代码锚点）：

  | 类别 | 判据（URL 特征） | 现有锚点 |
  |---|---|---|
  | `scan` | `sharepage/token`、`sharepage/detail`、`/v2/share_link/get_share_token`、`/adrive/v2/file/get_by_share`、`/adrive/v2/file/list_by_share` | `proxy.js:157-158` |
  | `download` | `file/download`、`/v2/file/get_download_url`（取直链，伴随 OSS 行为） | `proxy.js:159-160` |
  | `restore` | `/adrive/v4/batch`（`url:/file/copy`）等转存批量接口 | 现有 `prase` 段拆出 |
  | `credential-pick` | 取号/换号/账号探测类**自有端点**（非上游域名请求） | `server.js:135`、上轮 `hop/accounts` |

  🟢 过渡期保留历史值：trace/D1 里已有 `prase` 数据，建议**值域加宽**而非改写历史
  （`scan|download|restore|credential-pick|prase(legacy)|other`），并在两处 `classifyOperation` 的
  单测/冒烟里断言同一张表（这次漂移就是因为"最小复制"没有断言兜着）。
- 🟢 **函数目录按四类拆**（Tzz 说的"最该分开的反而没有"）：`functions/api/proxy.js` 作为共享核心下沉到
  `functions/api/_shared/proxy-core.js`（CF Pages Functions 中 `_` 前缀不生成路由），
  上层 `functions/api/scan.js` / `download.js` / `restore.js` / `credential-pick.js` 各自薄封装。
  🟢 但**先做等价搬迁、后做拆分**（一次改动只做一件事），否则线上排障时分不清是拆分问题还是行为问题。
- 🟢 **改名要双端点兼容**：`/api/proxy/cookie-pick` 已被部署实例使用（backend 0.1.0-next/1.2.2 文档已写死）。
  建议：新 `/api/credential-pick` 为主，旧路径保留 N 个版本并记 `deprecated` 日志；后端在
  `/api/proxy-config` 中声明支持的词表版本，前端据此选路径（比"全靠猜"稳）。
- 🟢 **`x-panhub-backend` 语义拆干净**：该头现在同时表示"存在 backend"和"取到正式账号"
  （`functions/api/proxy.js:459`、`backend/src/proxy.js`）。建议改为
  `x-panhub-credential: picked|guest|none` + 保留 `x-panhub-account`（标签），
  于是"CF 侧不引入 backend 也能表达游客/无账号"，前端守卫不再依赖"backend 是否存在"这一事实。

### 3.3 待拍板
❓ B1 词表是否加 `legacy: prase`（我建议加，避免历史 trace 不可读）？
❓ B2 `get_download_url` 归 `download` 还是单列 `resolve`（我建议归 `download`，四类不扩）？
❓ B3 `credential-pick` 端点形态：`/api/credential-pick`（取号）+ `/api/credential-pick/accounts`（探测）是否可接受？

## 4. 后端：插件体系 + 浏览器 CDP 凭据刷新（C）

### 4.1 定稿（按 Tzz 草案）
- 9229/9230 = wrangler inspector，**废弃，仅作 /health**；9222 = 真实浏览器 CDP，**凭据刷新专用**；
- 用浏览器而非 node 模拟（最大程度减风控），插件定期（1-2h）模拟操作 + F5，抓下游下发的**已知凭据**；
- 无头服务器：提供安装脚本（CPU arch / system / chromium 检测安装 / 检测或启动 CDP 服务），可 SSH 全程完成；
  激活后面板按 ws 客户端显示浏览器 health；安装/启动前 y/N 确认；
- 插件格式：**压缩包**（magisk / qq-chat-export 风格），底层插件加载器执行 `install.sh` 解压到指定位置；
  支持在线（github 断连备选）与离线安装；要求 package 说明；**热加载**；
- 插件可向 webui 注入自己的配置（宏录制 / 定时任务 / 打开网页注入 cookie / 回传 snapshot ≈ 扫码登录）；
- **敏感凭据优先交 `db.js`/`log.js` 等本地服务，不经 backend 中转**（防劫持）；
- 一个上游多账号：需要在插件侧解决。

### 4.2 我的建议
- 🟢 **端口用途写死进文档 + 代码注释**（9229=inspector/health，9222=browser CDP），避免下次再混；
  并把"ws 客户端标识浏览器 health"定义为 `{ plugin, instance, port, lastTick, credExpiry }` 结构。
- 🟢 **首次登录必须有人参与**：无头服务器上"SSH 装完就激活"只在**已有登录态**时成立。
  建议提供两条路：
  ① 首选：SSH 端口转发（`ssh -L 9222:127.0.0.1:9222`）+ 本地 Chrome 打开 → 人工登录/扫码（一次性）；
  ② 兜底：接受"人工粘贴一次 auth/cookie 播种"，之后交给 CDP 定时刷新（正好用上现有凭据串通道）。
  安装脚本不要把 ② 漏掉，否则头一次激活必然失败。
- 🟢 **刷新调度按凭据到期倒推**（`exp - 30min` 时刷新，无 exp 时兜底 60min），不要固定 1.5h 盲刷：
  盲刷 = 无谓风控暴露 + 上游发现异常节奏。并建议加"连续失败 N 次 → 退避 + 面板告警"。
- 🟢 **`install.sh` 是任意代码执行，先立三条规矩**（否则这功能是给用户埋雷）：
  ① 安装必须打印包的名称/来源/哈希并显式 y/N；② 包内必须有 `package.json`（名称/版本/入口/权限声明/可选 sha256）；
  ③ **默认非 root 运行**，只允许写 `backend/plugins/` 与 `data/`；需要 root 的步骤（装 chromium 等）单独一步、
  把命令打印出来后确认。离线安装同规矩（"离线"不等于"可信"）。
- 🟢 **热加载首版降级为"进程级启停"**（禁用=停子进程、启用=重启），真正的模块热替换留 v2：
  插件是常驻进程 + 持有浏览器连接时，热替换的状态泄漏很难查，收益不成正比。
- 🟢 **多账号用"实例"而不是"多装一份插件"**：`plugins/<name>/instances/<id>.json`（各自凭据/参数），
  面板按 `(plugin, instance)` 展示 health 与到期时间；`db.js` 的 `accounts` 表加 `plugin_id`/`instance`（可选列，
  遵守上次草案"阿里专属字段必须可选、不污染通用 schema"的原则）。
- 🟢 **宏录制/扫码登录：首版不要做通用宏引擎**。建议只做"固定脚本流程"（打开 URL → 等待选择器 → 抓 snapshot/凭据 → 回写），
  把"录制"留到有明确需求且安全评审过之后。理由：通用宏 = 任意页面操作能力，风控与误操作代价都高。
- 🟢 **顺手修掉现状小口**：插件管理页在请求 `/api/web/plugins`，但后端**没有这个端点**（页面永远「加载中…」）。
  要么补端点（返回内置插件 + 目录扫描结果），要么页面显式提示"插件加载器未启用"。

### 4.3 待拍板
❓ C1 插件是否需要"可卸载/回滚"（`uninstall.sh` + 备份）—— 我建议要，成本低。
❓ C2 CDP 浏览器由谁提供：系统 chromium（安装脚本装）还是插件自带便携版（体积大但可控）？我建议前者 + 检测已有。
❓ C3 敏感凭据直写 `db.js`：插件与 backend 同机同用户，绕过 HTTP 层即等同 backend 权限 —— 是否接受
  （否则需插件独立进程 + Unix socket 权限隔离，成本高）？

## 5. 后端：hop / credential-pick / 架构同步（D）

### 5.1 定稿（按 Tzz 草案 + 现状）
- `backend/src` = hop（服务端），`backend/webui/src` = 面板，`webui/src/api.js` = 权限隔离层
  （面板有的服务器可以没有，穿透后这点很重要）；
- `server.js:133` 一带向 `${cfg.wrangler.port}/api/proxy` 的转发**需要同步改名**（实际代码在
  `backend/src/proxy.js:135`：`const url = \`http://127.0.0.1:${cfg.wrangler.port}/api/proxy\``；
  `server.js:661` 启动日志里也写死了该目标），当前只需向 `${cfg.wrangler.port}/api/download` 转发凭据；
  下游 `${cfg.wrangler.port}/api` 的上报用于后端审计/凭据刷新；
- `GET {代理}/api/credential-pick/accounts?provider=&account=` → `{ accounts: string[] }`（上轮 `/api/hop/accounts` 形态被认可）
  **加鉴权、行为不变**；该 auth 可以发给 functions（**不暴露给 SPA**，凭据 2h 但滚动更新 = 一直有效）。

### 5.2 我的建议
- 🟢 **hop 侧路径：一换一留**。薄转发目标改为 `${wrangler.port}/api/<四类>`；老 `/api/proxy` 保留为
  `/api/download` 的兼容别名一版（本地 launcher 与已部署实例都还写着 `/api/proxy`）。
- 🟢 **SPA 探 hop 要"过 functions 一道"**（这是我上轮实现与本草案的冲突点，必须定）：
  上轮 SPA 直接打 `GET {代理}/api/hop/accounts`。若凭据不许暴露给 SPA，则应改为
  SPA → `POST {functions}/api/credential-pick`（带 operation + provider + 账号身份）→ functions 去问 backend，
  **结果以响应头回传**（`x-panhub-credential: hit|miss`），SPA 永远拿不到 auth 本体。
  改动量：`carry.ts#onAlipanExpired` 的探测入口换一次（约 20 行）+ 端点常量改名。
- 🟢 **写清"凭据可以在哪几层存在"**（安全边界表，进 `docs/`）：
  SPA localStorage（用户自填，仅直连兜底）· functions 内存（仅请求生命周期，不落库）· backend 加密库（长期，CDP 写）。
  并明确 **CF 侧永远不落库长期凭据**（Tzz 的约束），functions 只做"转发时借用"。
- 🟢 **滚动更新与托管模式的衔接**：托管/取号生效时，SPA 侧的 carry 缓存键不应再依赖"用户手填的 auth"，
  而应取响应头 `x-panhub-account`（后端回传的标签）→ 账号身份由后端给，carry 照常工作（同账号 = 续杯成立）。
  建议把这列为 P3 的验收项之一（否则"手工 auth 过期 + 后端托管"两条路会各说各话）。
- 🟢 `GET .../accounts` 加 `Cache-Control: no-store` + 每 IP 限频 + 只回身份集合（不回任何凭据/过期时间）。

### 5.3 待拍板
❓ D1 hop 探测改走 functions（我建议改）还是维持 SPA 直连（实现最省，但身份/凭据边界不如前者干净）？
❓ D2 `x-panhub-account` 作为 carry 缓存键是否可接受（后端标签形如 `alipan#3`，够不够表达"同一账号"）？
❓ D3 四类改名后，是否给老 `/api/proxy` 一个明确的下线版本号（如 1.4 移除）？

## 6. 面板：读写分离（E）

### 6.1 定稿（按 Tzz 草案）
- 大型网站的 API key 语义：**关闭窗口即不可见**；写凭据要二次验证（已有），**读不能裸奔**；
- 只显示备注；账号管理页数据**来自加密数据库的实时快照**（5min 自动刷新 + 可选手动），只查询指定信息；
  且**查询不由 webui 发出**（防抓接口越权查询）；
- 读/写分开是设计重点：读只给非敏感备注类；写 = 临时写入保留 + CDP 只写 + functions set-cookie 只写。

### 6.2 我的建议
- 🟢 **删掉指纹字段**：`listAccounts()` 的 `cookieTail`/`cookieLength`/`keys`（`cookies.js:70-72`）不进接口，
  面板列 `#ID / 网盘 / 备注 / 状态 / 过期 / 最近使用 / 操作` 即可（少一列"cookie"，健康程度用 status/exp 表达）。
- 🟢 **"写新不读旧"**：删掉 `GET /api/web/accounts/:id` 的凭据回填语义（现在已被迫返回空）。
  编辑 = 覆盖写入（表单留空 + 说明"出于安全不回填"），并加"危险操作"提示。
- 🟢 **快照化**：`/api/web/accounts` 改为读**后端内存快照**（`accounts` 模块 5min 定时 + 写操作立即刷新 +
  `POST /api/web/accounts/refresh` 手动），webui 不做任何"按字段查询"，**接口只暴露白名单字段**（白名单写在 server.js 一处）。
- 🟢 **删除操作也纳入二次令牌**（现在只是 `window.confirm`）。
- 🟢 **"临时写入"加 TTL**（如 30min 自动清），否则"临时"迟早变长期；TTL 到期只清凭据、保留备注与审计。
- 🟢 **审计口径**：写路径审计已存在（`audit('account.upsert',…)`）；建议补"读"的审计
  （谁在什么时候读了账号列表 —— 不含凭据，只记行为），这样"读写分开"可被验证而不只是被声明。

### 6.3 待拍板
❓ E1 面板是否需要"凭据整体导出/导入（备份）"？我建议**不要**在面板做，走 launcher 的 `backup` 子命令（已有）。
❓ E2 快照 5min 是否够（写入后立即刷新已覆盖实时性）？
❓ E3 是否保留 `keys`（"关键 key 是否齐全"）作为健康信号？我建议不显示给用户，仅内部 status 计算用。

## 7. 分批落地计划（建议）

| 批 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| **P1 前端** | A：合并写入 + last-account + 内存态本次有效 + 覆盖弹窗 + 副本提示；B 前端侧：adapter 内 `copy`→`restore` 词表对齐 | 无 | typecheck/build ✅、自测（合并/覆盖/拦截三态）、真机 prase 两跳 ✅ |
| **P2 functions** | B：`_shared/proxy-core.js` 等价搬迁 → 拆 `scan/download/restore/credential-pick`；`x-panhub-credential` 头；credential-pick 双端点 | 与 P3 同步部署 | 本地 wrangler 8788 冒烟（scan/download/restore 各 1 条真实请求）、旧路径仍 200 |
| **P3 backend** | D：hop 薄转发改 `/api/<四类>`（旧 `/api/proxy` 别名）；`/api/credential-pick[/accounts]`；E：快照 + 去指纹 + 写新不读旧 + 删除二次令牌 + 临时写入 TTL | 与 P2 同步 | `test/hop-smoke.mjs` 全绿 + 面板手测（读不到凭据、写需令牌） |
| **P4 插件** | C：包规范 + 加载器（进程级启停）+ 面板端点 + 浏览器 CDP 凭据刷新插件 + 安装脚本（含首次登录两条路） | P3 就绪 | 干净机器跑安装脚本 → 激活 → 面板 health 正常 → 一次真实凭据刷新写入（脱敏日志） |

🟢 每批独立出 diff + changelog 条目；**P2/P3 之间必须能"新老混跑"**（双端点 + 词表加宽），
否则用户升级到一半就断路 —— 这批改动"可以一并 push"的前提就是这段兼容窗口。

## 8. 待拍板清单（Tzz 2026-09-15 已全部回复）

| # | 事项 | Tzz 回复 | 落地 |
|---|---|---|---|
| A1 | “上次使用账号”存储 | **只能用本地存储**（carry 要能不发 restore 请求） | ✅ 已按统一记录落地 |
| A2 | 必填项不全 | 小字改「缺少必填项xx」+ 确定按钮置灰 | ✅ P1 |
| A3 | 副本清理 | 只做提示（x-sign+delete 高危、易风控） | 提示文案待补（P1 未做提示，列为 P3 小活） |
| B1 | 词表保留 prase | 得加，不然没法审计 | ↘ P2 |
| B2 | 四类 + 双端点 | 同意，平滑过渡 | ↘ P2 |
| B3 | credential-pick 两级 | 备注可回 SPA，凭据仅供 functions | ↘ P3（照应 D2） |
| C1 | 插件卸载/回滚 | 同意 | ↘ P4 |
| C2 | chromium 来源 | 同意（检测已有） | ↘ P4 |
| C3 | 插件直写 db.js | 同意 | ↘ P4 |
| D1 | hop 探测走向 | **只能走 functions**（不下发 SPA） | ↘ P3（carry.ts 已标 TODO） |
| D2 | carry 键 | 要返回 userId（不要 `#3`）—— 长期非敏感凭据 | ↘ P3 |
| D3 | tag | 本批打 **1.3.1**；1.4 = 迅雷云盘 | ✅ changelog |
| E1 | 面板备份 | 不做（走 launcher backup） | ↘ P3 |
| E2 | 快照 5min | 够了（凭据→插件响应最长 35min，均不会过期） | ↘ P3 |
| E3 | 面板不显示 keys | 不需要 | ✅ 已去掉（连 cookie 指纹一起） |
| TTL | 临时写入 | 最好可配置；**算新号也要保留审计**；备注缺失时回退用 userId，不要 `#num` | ↘ P3 |

### 8.1 Tzz 补充细节的采纳情况

| 补充 | 采纳 | 说明 |
|---|---|---|
| 把 last_auth / drive_id / to_parent_file_id / files **丢在一起**（一条记录） | ✅ 采纳 | 已在 P1 落地；旧键只读兼容 |
| 内存态（选「否」）刷新即失效、不写 localStorage、不进后端统计 | ✅ 采纳 | `setAlipanSessionAuth` + 内存 carry（不污染记录） |
| 优先后端取号，没有/没号才回退本地输入 | ✅ 采纳（P3） | 前端仅保留本地回退路径；取号链路在 functions/backend |
| 下载报错「存过又删了」→ 重跑 restore + 刷记录 | ✅ 采纳 | 已按 403 `ForbiddenFileInTheRecycleBin` 落地并单独测 |
| 后端异步入库（一次 prase 一条：原文件名 + size，供周期性统计） | ✅ 采纳（P3） | 与上次草案待办 #3（file_hits 可选列）合并 |
| 「一个上游账号多人使用」目标 | ✅ 采纳 | 企业场景降转存次数；文档说明 |
| 宏录制/扫码登录 | ❌ 不采纳（首版） | 你已定「宏也太可怕了」→ 首版只做固定脚本化流程 |

## 9. 实施进度

| 批 | 内容 | 状态 |
|---|---|---|
| P1 | 前端：合并写入 / 统一记录 / 仅本次有效 / 账号覆盖弹窗 / 必填项置灰 / 回收站回退 | ✅ **已完成**（typecheck/build ✅ + 自测 82/0） |
| P2 | functions 四类拆分 + `x-panhub-credential` + credential-pick 路由 + SPA 按类路由 | ✅ **已完成**（本地 wrangler 路由冒烟 ✅ + 真实 scan 转发 200） |
| P3 | backend：hop 按类转发、`/api/credential-pick[/accounts]`、统计归一、**面板读写分离 + 快照 + 临时 TTL** | ✅ **完成**（hop-smoke 43/43） |
| P4 | CDP 最小客户端 + 凭据刷新**手动预设**（限频/单飞/审计）+ 面板插件页 | ✅ **完成**（无浏览器时安全降级已验证；真实取值待真机） |
| D1 | SPA 探测改走 functions | ⬜ 暂缓（Tzz：后面再做） |

commit 备注（Tzz 定）：`pref：functions separeted` · `feat：backend extensions` · `feat：temp&usual credentials（both frontend and backend）`

## 附：与上次草案（STRUCTURE 后端待办）的合并结果

| 上次待办 | 本轮归属 |
|---|---|
| 1 随机选号（需 hop API） | → §5 credential-pick（P2/P3）：`accounts` 探测 + 选择策略放 backend（前端不做随机） |
| 2 写入 auth 时解码展示 userId | → §5：backend 侧同一套 JWT 离线解码（复用 `carry.ts` 的规则：`user_id→userId→sub→uid`，解不出降级 `drive:<drive_id>`），面板只显示非敏感 userId |
| 3 长期定位数据（file_hits 思路） | → §5/§6：`restore` 类写入 `(srcFid, newFid, md5, size, driveId?, userId?)`，阿里专属列**可选**、不污染通用 schema |
| 4 alipan 滚动更新（需探测端点） | → 上轮已实现（SPA 侧）+ 本轮 §5 端点归位到 credential-pick、身份改由后端回传 |
