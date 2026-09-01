# panhub-backend —— 自托管转发代理 + 管理面板（v0.1.0-next）

> 设计稿：`docs/backend-wrangler-plan.md`（v1.2.2 定稿）。协议与 CF 版 `functions/api/proxy.js` 完全兼容。
> 角色：**配电室/仪表室** —— 管理面板 + 增强 hop；转发实现唯一一份在 wrangler 侧（`functions/api/proxy.js`）。
> 部署：SPA 走 CF/GitHub CDN 加载，**不本地托管**；B 端员工只拿 `proxy_address + proxy_token`（无管理面板令牌）。

## 快速开始（推荐：一键脚本）

```bash
# clone 后第一次使用：检测 node/wrangler → 装依赖 → 生成端口+双令牌 + 根 .dev.vars
./backend/launcher.sh setup

# 首次排查问题用 debug（wrangler 真 TTY 交互面板占主终端，backend 后台日志；有 tmux 自动分窗）
./backend/launcher.sh debug

# 日常启动/停止/状态
./backend/launcher.sh start
./backend/launcher.sh stop
./backend/launcher.sh status
./backend/launcher.sh logs      # 实时看 backend.log + wrangler.log
```

launcher 全部命令：`setup | start | stop | status | restart | debug | logs | build | backup | reset`
（也接受 `--` 前缀：`./backend/launcher.sh --stop` 等价 `./backend/launcher.sh stop`；无参数打印用法+状态）

手动启动（不推荐，跳过 launcher 的端口避让/进程管理）：

```bash
cd backend
npm install
node src/index.js     # debug 模式，前台运行，Ctrl+C 停止
```

## 首启行为

- 生成随机端口（单 listener，20000–60000）与令牌（WebUI/Proxy 各一），
  写入 `backend/data/period/config.json`（权限 600）；首启横幅打印完整令牌（仅首启）
- 生成 AES-256-GCM 密钥 `backend/data/period/secret.key`（权限 600，**与 DB 必须一起备份**）
- 半初始化 config.json（缺令牌/端口）会自动补全，不会"自己被拦住"
- **自动生成仓库根 `.dev.vars`**（权限 600）：`PROXY_TOKEN=<config.json 同一把>` + `TRACE_D1=0`；
  wrangler 从 cwd 的 `.dev.vars` 读取令牌（setup/start/debug 都会同步，不一致自动重写），
  **不再传 `--binding`**，避免令牌漂移；`.dev.vars` 已在根 .gitignore，不进归档
- wrangler：默认 8787（被占自动递增避让），inspector 9229；launcher 会把实际端口写回 config.json

## debug（前台排查，v1.2.2「debug 到底」）

- wrangler 以**真 TTY 零管道**前台运行（不 tee、不重定向 stdout），交互面板快捷键 `b / d / e / t / c / x` 可用
- backend 一律 `nohup` 后台 → `backend/data/logs/backend.log`
- 有 tmux：自动分窗 —— 左 pane wrangler 交互面板、右 pane `tail -f backend.log`（不是 tee）；
  `./backend/launcher.sh stop` 会连 tmux 会话一起关闭
- 无 tmux：wrangler 占主终端；backend 等面板就绪后自动后台启动（attach，不抢端口）；Ctrl+C 退出 wrangler
- `PANHUB_NO_SPAWN=1`：backend **跳过 spawn 但允许 attach**（测试场景用；inspector 探测失败自然降级 off）

## 架构（单 listener）

一个端口通吃：

| 路径 | 说明 |
|---|---|
| `/api/proxy-config` | 就绪探测端点（Host 限 127.0.0.1/localhost；**不再返回 token**） |
| `/api/proxy` | 增强 hop：令牌校验 → 账号注入 → 转发 wrangler → set-cookie 合并回账号池 → 两阶段 trace 落库 |
| `/api/proxy/cookie-pick` | 云端 proxy.js 取号端点（X-Proxy-Token；本机 hop 复用同一逻辑） |
| `/api/web/*` | 管理面板 API（Host 限 127.0.0.1/localhost；webui 令牌） |
| `/api/web/terminal/ws` | 严格终端穿透（原生 ws 实现，零依赖） |
| 静态 | 管理面板 webui/dist |

wrangler 侧（`wrangler pages dev .`，绑 `PANHUB_BIND`，默认 0.0.0.0 企业内网可达）：执行 `functions/api/proxy.js`
（白名单/限频/业务转发，唯一转发实现）。**不托管 SPA** —— 前端走 CF/GitHub CDN。

### B 端局域网部署（PANHUB_BIND，拍板之二）

默认 `PANHUB_BIND=0.0.0.0`：wrangler 转发端口全接口监听（企业内网可直连），
backend 单 listener 也全接口监听，但 `/api/web/*` 的 Host 检查只放行回环 + 固定内网 IP → 管理面板仍仅本机可进。

```bash
# 只给员工用代理（wrangler 0.0.0.0 内网可达；管理面板仍仅本机）
./backend/launcher.sh start

# 连管理面板也要开放：绑企业服务器固定内网 IP（webui 只允许这个 IP 绑定）
PANHUB_BIND=192.168.1.10 ./backend/launcher.sh start
```

- wrangler 与 backend 绑同一 `PANHUB_BIND`；`0.0.0.0` 时 wrangler 全接口、webui 仍仅回环（Host 检查）
- 固定内网 IP 时 webui Host 检查放行该 IP → 员工可直连 `http://<内网IP>:<port>` 管理面板（凭 webui 令牌）
- 员工代理凭据 = `proxy_address`（`http://<内网IP>:<proxy.port>`）+ `proxy_token`
- 注意：`0.0.0.0` 下 wrangler 静态服务（含源码树）内网可见，内网可信环境可接受；要收紧设 `PANHUB_BIND=127.0.0.1`

> 令牌一致性：`config.json` 是权威，launcher start/debug 自动同步根 `.dev.vars`；
> webui 轮换 proxy 令牌也会同步 `.dev.vars`（wrangler 需 restart 生效，避免新配置旧 token 全员 401）。

## 日志位置（排查问题先看这里）

| 位置 | 内容 |
|---|---|
| `backend/data/logs/backend.log` | backend 全部日志（launcher 重定向；`./backend/launcher.sh logs` 实时看） |
| `backend/data/logs/wrangler.log` | wrangler 输出（start 模式；debug 模式看交互面板） |
| `backend/data/tmp/debug-*.log` | 完整 trace（请求/响应头体、命中账号；600 权限，按天轮转留 7 天） |
| 管理面板「操作日志」页 | backend 自身活动（audit_log：账号增删改/令牌轮换/清理/hosts/取号）；上游调用记录在「数据看板」 |

**日志保留期**：默认 30 天（settings 键 `log_retention_days`）；backend 启动时 + 每小时自动清理
（proxy_logs / file_hits 两表），管理面板设置页可改天数（**重启后生效**），另有「手动清理日志」按钮
（`POST /api/web/logs/purge`，days 省略 = 全清）。

生命周期事件（终端连接/断开、wrangler attach/spawn、服务启动）会打到终端 console；
日常 info（hop 每笔请求）只进环形缓冲，`console: true` 标记的才上终端。

## 账号池（与 SPA 弹窗字段对齐，勿改）

| pan | 存储形态 | 关键 key |
|---|---|---|
| quark | 整串 cookie（大文件 23018 解锁必需） | `__pus` / `__uid` / `__puus`（同 `src/adapters/quark/cookies.ts`） |
| uc | `__pugs` 单值（下载层游客态凭据） | `__pugs` |
| guest | 空 cookie 自动生成随机 `__pugs`，label `guest#` 打标 | `__pugs` |

- 账号池增删改 = 高危操作：UI 需**二次输入 WebUI 令牌**确认
- 转发时按网盘自动注入账号 cookie（仅 prase/download 操作；scan 保持游客）
- 服务端 Set-Cookie 刷新（`__pus`/`__puus`/`__pugs`）自动合并回账号池
- cookie 轮转（多账号失败切换）为 P2 待办，代码已留口（wrangler 侧需 restart 同步）

## 安全模型

- backend 默认单 listener 绑 `PANHUB_BIND`（默认 0.0.0.0；webui Host 检查只放行回环 + 固定内网 IP，见上）
- webui 四件套：Host 校验 + Origin 校验 + CSRF + 随机端口（防 DNS rebinding）
- hop 令牌 timingSafeEqual；白名单/限频在 wrangler 侧（backend 不重复实现）
- cookie 密文 AES-256-GCM；日志脱敏（凭据值只存 SHA-256 前缀）；完整头只在 debug 文件（600）
- 终端高危命令过滤：rm / systemctl stop / curl|sh 整行拒绝，hosts add/del 走 builtin + 审计
- 隐私声明见设计稿 §11：IP 默认不采集，开启后 sha256(ip+salt) 哈希化；不存 cookie 明文 / stoken / 分享链接

## 目录

```
backend/
├── src/            # index/config/server/proxy/auth/db/cookies/log/wrangler/terminal
├── webui/          # Preact 管理面板（vite 构建 → webui/dist）
├── test/           # 冒烟测试（node test/hop-smoke.mjs，26 项）
├── launcher.sh     # 管理脚本（v1.2.2 起从仓库根 scripts/ 挪到这里）
└── data/           # 运行时数据（gitignore；period/ 含 config+secret.key+DB，一起备份）
```

## v0.1.0-next 已实现 / 待实现

已实现：单 listener（webui/hop/terminal ws 一个端口）、增强 hop（令牌 → 账号注入 →
转发 wrangler → set-cookie 合并 → 两阶段 trace 落库 + file_hits + 保留期清理 + debug 文件）、
wrangler spawn/attach 自动探测（`PANHUB_NO_SPAWN=1` = 跳过 spawn 但允许 attach）+ 普通 ws 健康监听 +
stdout 行解析入库、严格终端穿透（高危过滤 + hosts builtin + 原生 ws）、guest 账号、WebUI 看板
（Network 健康 widget + 重复检测 Tab + 日志保留期设置）、`./backend/launcher.sh`
（setup/start/stop/status/restart/debug/logs/build/backup/reset，端口避让 + .dev.vars 自动生成 + 一把令牌）、
`scripts/selfhost.sh`（codeload tarball 引导拉取）。

待实现：cookie 轮转 P2（wrangler 侧需 restart 同步，代码已留口）、P3 云端分支
（functions/api/proxy.js：BACKEND_URL cookie-pick + TRACE_D1 D1 双 sink + x-panhub-account 回传）、
Windows launcher.bat。
