# 云链解析站（pan-web）— 源码目录结构 v1

> 命名规范：kebab-case 文件名、PascalCase 组件、camelCase 变量
> 职责分离：`adapters/`（网盘差异）与 `core/`（通用逻辑）严格隔离，UI 不直接碰网盘细节

```
pan-web/
├── README.md                      # 用户入口：一句话定位 + 零上传承诺 + 快速开始 + 致谢
├── LICENSE                        # GPLv3（首次提交写明迁移自 LinkSwift 思路，尊重版权）
├── vite.config.ts                 # 构建配置；base:'./' 支持任意静态托管
├── index.html                     # 主站入口（hash 路由区分页面）
├── public/
│   └── favicon.svg
│   └── logos/
├── docs/
│   ├── reverse-notes-uc.md        # UC 逆向笔记（完工版，适配器开发依据）
│   ├── Cautions.md                # 坑位日志（时间倒序：现象/根因/修法/教训，只记已查实的）
│   ├── changelog.md               # 面向开发者：变更日志（repo:/dev/ 入口）
│   ├── ai-usage.md                # 面向开发者：AI 协作规范（本项目如何被 AI 维护）
│   └── migration-linkswift.md     # 首次提交：LinkSwift 功能迁移说明 + 版权声明
├── src/
│   ├── main.tsx                   # React 入口，挂载 App + 全局错误边界
│   ├── app.tsx                    # 路由：/#/（输入页）/ 结果页 / /#/dev（开发页）
│   │
│   ├── adapters/                  # ★ 网盘适配层：所有网盘差异收口在这
│   │   ├── types.ts               #   PanAdapter 接口（detect/token/tree/download/limits/jumper）
│   │   ├── registry.ts            #   适配器注册表 + detectShareUrl(url) 识别网盘
│   │   ├── uc/                    #   UC 子目录（v1.1.6 规范：一个网盘一个子目录）
│   │   │   ├── types.ts           #     UC 静态属性（API 地址/错误码/特性表/原始类型）
│   │   │   ├── registry.ts        #     组装完整 ucAdapter（其余文件只提供能力）
│   │   │   ├── scanner.ts         #     扫描能力（token/detail/download，原 uc.ts）
│   │   │   ├── cookies.ts         #     __pugs 存取（原 ucPugs.ts）
│   │   │   ├── selector.ts        #     链接识别：短链接 / #/list/share 长链接（v1.1.6）
│   │   │   └── jumper.ts          #     0B 文件夹跳转链接构建/解析（v1.1.6）
│   │   ├── quark/                 #   夸克子目录（v1.1.9：第二个网盘，结构与 uc/ 同构）
│   │   │   ├── types.ts           #     夸克静态属性（API 地址/错误码/特性表/原始类型）
│   │   │   ├── registry.ts        #     组装完整 quarkAdapter
│   │   │   ├── scanner.ts         #     scanner/prase（分享根包装层自动下钻；23018 → 登录 cookie）
│   │   │   ├── cookies.ts         #     sdid/up/wk 存取 + 懒人导入解析 + __pugs 捕获
│   │   │   ├── selector.ts        #     链接识别：短链接 / #/list/share 长链接
│   │   │   └── jumper.ts          #     0B 文件夹跳转链接构建/解析
│   │   ├── alipan/                #   阿里云盘子目录（v1.2.x 初稿：第三个网盘，结构与 quark 同构）
│   │   │   ├── types.ts           #     alipan 静态属性（API 地址/x-canary 阶段值/特性表/原始类型）
│   │   │   ├── registry.ts        #     组装完整 alipanAdapter
│   │   │   ├── scanner.ts         #     scan（免登录三连，next_marker 分页）/ prase（两跳：转存→直链）
│   │   │   ├── auth.ts            #     登录态凭据串（auth=Bearer xxx;to_parent_file_id=…）存取/解析
│   │   │   ├── carry.ts           #     v1.3 滚动更新（carry-over）：转存 file_id 缓存 + 续杯 + 过期判定
│   │   │   ├── selector.ts        #     链接识别：短链接 / /folder/ 深链（双域）
│   │   │   └── jumper.ts          #     深链文件夹跳转链接构建/解析
│   │   └── README.md              #   新网盘接入指南（照着 uc/ 抄结构即可）
│   │
│   ├── core/                      # ★ 通用逻辑：不依赖任何网盘细节
│   │   ├── treeWalker.ts          #   目录树递归遍历（并发 2/翻页节流 250ms/大小聚合/jumper 根节点；
│   │   │                          #   v1.2.x：兼容 next_marker 游标分页网盘（alipan），uc/quark 页码制不变）
│   │   ├── linkFetcher.ts         #   批量直链获取（15 个/批 + 1s 节流，参考 LinkSwift）
│   │   ├── preferences.ts         #   偏好设置（localStorage，默认值见 docs/changelog）
│   │   ├── errors.ts              #   错误码 → 中文文案 + 错误分类（游客超限/需登录/过期）
│   │   └── footprint/             #   ★ 足迹系统（IndexedDB，仅存本地）
│   │       ├── db.ts              #     IndexedDB schema + 打开/迁移
│   │       ├── links.ts           #     已填链接（查重/时间/限制 100 条）
│   │       ├── trees.ts           #     目录树快照（md 导出用）
│   │       ├── records.ts         #     解析记录（时间/次数/成功与否）
│   │       ├── logs.ts            #     完整解析日志（独立存储/5MB 轮转/删除线 cookie）
│   │       └── prase.ts           #     直链结果按 fid 复用（shareId::fid，v1.1.5.3）
│   │
│   ├── components/                # UI 组件（纯展示，props 驱动）
│   │   ├── LinkInput.tsx          #   输入框 + 自动识别网盘 + 历史下拉
│   │   ├── DirectoryTree.tsx      #   目录树（两种模式：|--- / 缩进，默认 |---）
│   │   ├── FileCheckbox.tsx       #   文件勾选（全选/按大小类型过滤）
│   │   ├── CookieWarnModal.tsx    #   读取 cookie 警告弹窗（一次性确认）
│   │   ├── CookieInputModal.tsx   #   登录态 cookie 填写/导入弹窗（v1.1.9 夸克 sdid/up/wk）
│   │   ├── JumptoFolderTipModal.tsx #  0B 文件夹跳转提示弹窗（v1.1.6，驼峰命名）
│   │   ├── LoginJumpModal.tsx     #   需要登录 → 跳转提示 + 自动关标签选项
│   │   └── settings/              #   偏好设置面板（按设计稿三块：UAC/默认方式/足迹）
│   │       ├── UacTable.tsx       #     网盘 × 转存/登录/限速 配置表
│   │       ├── DefaultMode.tsx    #     单文件/同目录/跨目录 默认下载方式
│   │       └── FootprintOpts.tsx  #     足迹保留开关与存储限制
│   │
│   ├── pages/
│   │   ├── HomePage.tsx           # 输入链接 → 识别 → 解析
│   │   ├── ResultPage.tsx         # 目录树 + 勾选 + 导出（核心页）
│   │   └── DevPage.tsx            # /#/dev 开发者页（changelog + ai-usage 入口）
│   │
│   ├── tasks/                     # ★ 下载任务生成：输出格式收口在这
│   │   ├── aria2.ts               #   aria2 命令 / RPC JSON（保留目录结构）
│   │   ├── gopeed.ts              #   gopeed 任务 JSON（保留目录结构）
│   │   ├── curl.ts                #   cURL 命令（单文件）
│   │   └── export.ts              #   统一导出：目录树 md / 直链列表 / 任务文件
│   │
│   └── utils/
│       ├── clipboard.ts           # 原生剪贴板封装（直链零损耗复制，勿走 DOM 文本）
│       ├── format.ts              # 大小/时间格式化
│       └── storage.ts             # localStorage 封装（带过期/配额守卫）
│
├── scripts/
│   ├── csp-smoke.mjs              # CSP 冒烟
│   ├── dev-proxy-server.mjs       # 本地开发代理
│   └── proxy.smoke.mjs            # 代理链路冒烟
│
└── tests/
    ├── uc.spec.ts                 # 适配器单测（mock 响应）
    ├── treeWalker.spec.ts         # 遍历/深度/并发
    └── footprint.spec.ts          # 足迹存储轮转/导出
```

## 构建产物

| 产物 | 来源 | 用途 |
|---|---|---|
| 主站 SPA | `src/` 全部 | 静态托管，输入/结果/历史/开发页 |

## 关键设计约束

1. **UI 永不直接 import 具体适配器**（如 adapters/uc/scanner.ts）—— 只依赖 `registry.detectShareUrl()` + `PanAdapter` 接口
2. **core/ 零网盘依赖** —— treeWalker/linkFetcher 只操作 PanAdapter 抽象
3. **足迹全走 IndexedDB**（日志可能 5MB 级），偏好设置走 localStorage
4. **直链复制只用原生剪贴板 API**（签名 URL 字符敏感）

---

## 插件体系（草案 · 待 Tzz 审）

> 状态：**2026-09-12 起草，未定稿**。下面的分类来自 Tzz 本轮口述，与既有文档有出入的地方已在文末「冲突待拍板」列出，**以 Tzz 拍板为准**。

后端带插件位，插件分两类：**全局插件**（能力跨网盘）与**定制插件**（按上游/场景定制）。

| 类型 | 定位 | 例子 | 依赖 |
|---|---|---|---|
| 全局插件 | 能力跨网盘、后端可复用的一层 | CDP（凭据刷新） | **浏览器绑定**（需调试端口 + 面板绑定浏览器实例） |
| 定制插件 | 面向某个上游或某条链路的专用通道 | 三方 client（如 alist 的 refresh_token 通道） | 上游 OAuth / 自有协议 |

- **全局插件**：CDP 属于全局插件——能力跨网盘（如凭据刷新），需要**浏览器绑定**。未绑定时插件不可用，**不阻塞主链路**（回落自填 cookie）。
- **定制插件**：三方 client（如 alist refresh_token 通道）按上游/场景定制，后续可能增多（迅雷 / 光雅 / 百度 …），统一以插件形式接入后端（hop）。

### 冲突待拍板

| # | 事项 | 说明 |
|---|---|---|
| 1 | CDP 的去留 | `docs/backend-wrangler-plan.md` v1.2.2 写的是「ws/CDP 全部删除」（9229 是 devtools 协议）；本节草案把 CDP 作为全局插件重新引入。两处需统一口径 |
| 2 | 历史插件位 | v1.2.1 讨论曾定「砍插件」，但 webui 保留了「插件管理」页（split/monitor/cdp 占位）与「保留插件加载位置（高级自定义）」——页面去留需一并拍板 |

---

## 后端待办（草案 · 待 Tzz 审）

> 状态：**2026-09-12 起草，未定稿**。按 Tzz 本轮描述整理，**尚未实现**。

| # | 事项 | 说明 | 依赖 / 约束 |
|---|---|---|---|
| 1 | 随机选号 | 账号池随机挑一个可用账号 | **需 hop 提供 API 能力，目前没有** |
| 2 | auth 写入时展示 userId | 管理面板写入 auth 时解码并展示 userId（**非敏感**，仅用于辨认账号） | 无（面板侧解码） |
| 3 | 长期定位数据（userId / driveId / file_id 映射） | 复用现有 `file_hits` 表思路（`docs/backend-wrangler-plan.md` §2.2 已定义 fid/md5/name/size） | **drive_id / user_id 是阿里 PDS 专属字段，必须做成可选，不得污染通用 schema** |
| 4 | alipan 滚动更新 | 前端缓存 file_id / driveId / userId，auth 有效期内「续杯」免转存 | 需 hop 侧**探测端点**（校验凭据仍有效 + 回传账号身份） |

- 待办 3 的通用列只放跨网盘事实（fid/md5/name/size）；阿里专属列（drive_id/user_id）以**可选列或旁表**追加，缺失时正常读取。
- 待办 4 的「续杯」前提是**同账号**（弹窗校验同账号）；auth 过期即退回完整两跳转存。
