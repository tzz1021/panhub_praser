# panhub-backend —— 自托管转发代理 + 管理面板（v0.1.0）

> 设计稿：`docs/selfhost-node.md`（v1.2.x 里程碑）。协议与 CF 版 `functions/api/proxy.js` 完全兼容。

## 快速开始

```bash
cd backend
npm install
npm run build:webui   # 构建管理面板静态资源（webui/dist）
node src/index.js     # debug 模式，前台运行，Ctrl+C 停止
```

首启自动完成：
- 生成随机端口（proxy 20000–60000，webui = proxy + 1）与令牌（WebUI/Proxy 各一），
  打印在启动横幅（仅首启；之后看 `data/period/config.json`）
- 生成 AES-256-GCM 密钥 `data/period/secret.key`（权限 600）

常用：
- `node src/index.js --port 18787` 覆盖 proxy 端口（webui 自动 +1，不写回配置）
- 管理面板：`http://127.0.0.1:<webui端口>`（硬绑本机）
- SPA 设置 → API 转发代理 → 填 `http://127.0.0.1:<proxy端口>` + Proxy 令牌

## 账号池（与 SPA 弹窗字段对齐，勿改）

| pan | 存储形态 | 关键 key |
|---|---|---|
| quark | 整串 cookie（大文件 23018 解锁必需） | `__pus` / `__uid` / `__puus`（同 `src/adapters/quark/cookies.ts`） |
| uc | `__pugs` 单值（下载层游客态凭据，208 字符） | `__pugs` |

- 账号池增删改 = 高危操作：UI 需**二次输入 WebUI 令牌**确认
- 转发时按网盘自动注入账号 cookie（仅 prase/download 操作；scan 保持游客）
- 服务端 Set-Cookie 刷新（`__pus`/`__puus`/`__pugs`）自动合并回账号池（同 SPA 前端合并逻辑）

## 安全模型

- 双 listener：proxy 可对公网（默认仅本机，开启需二次确认）；webui 硬绑 127.0.0.1
- webui 四件套：Host 校验 + Origin 校验 + CSRF + 随机端口（防 DNS rebinding）
- cookie 密文 AES-256-GCM；日志脱敏（凭据值只存 SHA-256 前缀）；完整头在 `data/tmp/debug-*.log`（600）
- 白名单增删需二次令牌；令牌比较 timingSafeEqual；限频按 IP（默认关）

## 目录

```
backend/
├── src/            # index/config/server/proxy/auth/db/cookies/log
├── webui/          # Preact 管理面板（vite 构建 → webui/dist）
├── scripts/        # （v1.2 后续）一键脚本/备份
└── data/           # 运行时数据（gitignore；secret.key 与 DB 必须一起备份）
```

## v0.1.0 已实现 / 待实现

已实现：双 listener、/api/proxy 转发（协议兼容 + 白名单 + 限频 + 账号注入 +
set-cookie 合并 + 脱敏落库 + debug 文件）、WebUI 七页（基础信息/网络配置/实时日志/
数据看板/插件管理/系统终端占位/系统配置含账号池）、WebUI 鉴权四件套。

待实现（v1.2 后续板块）：排队机制（家庭组）、插件加载器 + split/monitor、
系统终端（xterm.js）、CDP 自动取 cookie、一键脚本 install.sh/bat、backup.sh。
