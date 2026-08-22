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
│   │   └── README.md              #   新网盘接入指南（照着 uc/ 抄结构即可）
│   │
│   ├── core/                      # ★ 通用逻辑：不依赖任何网盘细节
│   │   ├── treeWalker.ts          #   目录树递归遍历（并发 2/翻页节流 250ms/大小聚合/jumper 根节点）
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
