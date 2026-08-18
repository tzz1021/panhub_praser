# 变更日志（changelog）

> 面向开发者（repo:/dev/ 入口）。面向用户的说明见 README.md。
> 约定：`## [版本] 日期` + 三块（新增 / 修复 / 变更）。

---

## [v1.1.5.3] 2026-08-18 —— 导出路径修复与 fid 复用落地（细节优化）

### 修复

- **curl / aria2 / gopeed 批量导出无法使用**：目录树 path 形如 `/dir1/sub/file.zip`，
  导出时目录段开头带 `/` 被 shell / aria2 / gopeed 当作根目录绝对路径；三处 dirNameOf
  统一剔除开头 `/`（根目录文件仍平铺到 outDir / 默认目录）
- **cloudflare 温馨提示弹窗不出现**：原判定是「手动终止与重试发生在相同 MM:SS」，
  真实点击必然跨秒导致永远不触发；改为「终止后 5s 内重试」窗口（pages.dev 代理 + 手动终止场景）
- **批量解析选「算了吧」后文件状态不变红**：整批请求共用一个 cookie，终止即整批失败；
  现在批量与单文件一致，全部标红（status:red 手动终止 + 重新解析按钮），已可复用的直链不受影响

### 新增

- **prase 结果按 fid 落库复用**（开发日志/足迹体系）：解析完成的 oss+sig + 同响应 __pugs +
  获取时间/终止标记存入 footprint 新 store（shareId::fid），刷新/重进分享自动恢复 ——
  未过期直链直接可导出，不再请求接口；读不到/已过期则
  正常显示解析按钮。手动刷新资源列表 / 删除链接 / 清空足迹时同步清理
- 开发日志：目录树 / 解析结果折叠块加「复制」按钮，一键复制全文方便贴给开发者分析；
  解析结果每行附 oss 直链 URL
- 设置 → 资源复用窗口 sub 提示：建议按直链过期时间最短的云服务设置（UC 实测 3-6h）
- UAC 表新增「oss/sig 较小有效期」行（先填已知：UC 约 3h，直链 3-6h / __pugs 3h，实测）

### 变更

- 移除结果页每个 file 的 status:xxx 文本标签（保留四色行底色与 重试/续杯/重新解析/解析 按钮）
- 开发日志术语：ls 改为 scanner（获取资源列表），prase（解析下载方式）不变

---

## [v1.1.5] 2026-08-17 —— 复用落地与直链状态标签（细节优化）

> 1.1.x 阶段说明：不再区分“哪个版本新增什么功能”，全部是细节优化（水军）；
> 1.2 起主力转向 linkswift / oss+sig 协议研究，不再做 UI/日志/偏好等基础设计。

### 重点突破：复用为什么要有

这是一个很不起眼的功能，只是为了应对分享者很懒、把一大堆文件一股脑分享出来。
如果不小心刷新页面或者浏览器闹脾气，你无需再等待漫长的“资源列表加载”。
一次加载默认一小时有效（设置 → 资源复用窗口可改；云服务商最多允许多长时间未知）。
层数很多的文件夹容易出现 0B 空文件夹问题，后续会修复。

### 已知问题

- ~~**oss+sig 复用失败（列表复用成功，不是问题）**：直链是敏感凭据，故意不落暂存区~~
  （v1.1.5.3 已推翻：改为按 fid 落库复用，见 1.1.5.3「新增」；敏感凭据仅存本地 IndexedDB）
- 目录层数很多的分享容易出现 0B 空文件夹问题，后续修复

### 新增

- 文件行直链状态标签：`上次HH:MM剩xhxm` / `上次HH:MM已过期` / `上次HH:MM手动终止`，
  替换原「用导出命令下载」（含其 title 属性）；已过期/手动终止的文件行出现「重新解析」按钮，
  顶部倒计时移除（下沉到文件行）
- 解析结果留痕：prase 完成后把每个文件的 路径/大小/格式/凭据有无/剩余时间 写入全局日志（折叠块）
- cookie 状态弹窗：复制按钮旁新增「当前长度 xxx」按钮；话术改为「该 cookie 叫做 __pugs，
  标准长度 208，请自行核对后继续；你可以在设置中关闭该提示」
- cookie 弹窗选「算了吧」= **主动终止解析**（原为跳过继续）：toast「用户主动终止解析」，
  单文件写「上次HH:MM手动终止」标记 + 重新解析按钮，开发日志同步
- aria2 保留目录结构导出修复：input-file（pan-web-tasks.txt）此前从未被导出（1.0 遗留）；
  改为每文件一条带 `--dir="相对目录"` 的完整命令（aria2 自动建目录），单文件导出
  （浏览器默认拦截连续下载两个文件，双文件方案废弃）
- curl 支持保留目录结构（--create-dirs + 相对目录输出路径），跨文件夹不再拦截 →
  移除 BatchWarnModal（批量解析仅支持 aria2/gopeed 弹窗）及其设置开关
- 操作按钮人性化：失败 →「重试」；成功但已过期 →「一键续杯」；手动终止 →「重新解析」
- 导出后提醒：若部分直链剩余有效期不足以支撑完整下载（按 1.5 MiB/s 参考速率估算），
  导出完成几秒后追加一条黄色 toast 提示尽快下载或续杯

### 修复

- 导出任务失败弹窗文案改为排查指引：检查所选部分是否为空；【重新解析】= 上次已过期；
  仍失败请刷新资源列表（会清空所有暂存区 oss 直链）
- 导出只统计窗口内未过期直链；「重试失败项」覆盖已过期直链
- 设置面板移除冗余项：目录树格式、目录树详细程度（file 大小 / etag / 分享时间 /
  用户存储时间 / 平台存储时间）
- 直链新鲜度判定统一走 utils/linkStatus：复用窗口 + oss Expires（60s 边际）双判定
  （点赞项：按 oss 自带 expire 计算 60s，而非 prase 操作时间）


---

## [v1.1.4] 2026-08-17 —— pugs 同响应绑定（架构级修复）+ ls复用，这里心情不好，不记得了

---

## [v1.1.3] 2026-08-16 —— pugs 同响应绑定（架构级修复）+ 单文件解析 + CF 能力验证

### 新增
- 单文件解析：目录树操作列原“复制直链”位置改“解析”按钮（未解析/失败时显示；成功后提示用导出命令下载）
- docs/reserve-note.md（预留笔记）：pugs 同响应绑定实测矩阵 / CF 代理能力验证 / 项目定位 / 方案评估
- 代理跨域部署补 `Access-Control-Expose-Headers: x-pugs`（GitHub Pages SPA + pages.dev 代理时浏览器才能读到捕获值）

### 修复
- **架构级：__pugs 与直链同响应绑定**（实测：同环境跨请求混用也 403 ucidMd5 invalid）——
  DownloadResult/LinkResult/ExportFile 增加 cookie 字段，curl/aria2/gopeed 导出按文件注入各自响应绑定的值；
  废弃“全局单一 pugs 注入所有文件”（多批解析时只有最后一批能下）
- **顺序固化**（single-link 示例日志核对）：获取资源列表（ls）= 游客态浏览，不再弹 cookie 提示；
  cookie 状态弹窗移到结果页“获取下载链接”阶段（解析时才需要，且与直链同响应）
- UacTable 回滚 v1.1.2 改名与全局日志改动（label 恢复“读取 Cookie 警告弹窗”，副标修正“UC 下载需 __pugs，默认开”）

### 变更
- CookieWarnModal：完整明文显示捕获值（不再截断）+ 复制按钮（社区开发者调试，开关默认开）
- v1.1.2 “设置项改名”作废（见上 UacTable 回滚）；弹窗标题/文案保留 v1.1.2 版本
- 移除“解析前新标签预热”调用（§12 实测：跳转取 cookie 对导出链路无意义；浏览器直下已移除）
- reverse-notes-uc.md 追加 §12；changelog 前序条目相应修订

---

## [v1.1.2] 2026-08-16 —— cookie 状态弹窗 + 全局日志 + 架构纠偏（Tzz 反馈）

### 新增
- 全局日志（开发调试）：历史页十盘 banner 下方新增可展开 banner，明确标注“仅用于开发调试，不会过滤隐私信息”；记录服务启动/偏好变更/解析生命周期/代理测试 POST/导出 merger
- cookie 弹窗改造：如实显示本次捕获值（`双下划线pugs=…` 或空），空值时给出供应商排查话术（cookie 存储限制/无痕/AdGuard），按钮【算了吧】【我已阅，继续】
- ~~设置项改名：读取 Cookie 警告弹窗 → cookie读取状态警告（默认开）~~ → v1.1.3 已回滚改名，仅保留“默认开”

### 修复
- **架构纠偏**：`pugs.ts` 从 core/ 移入 adapters 层（`src/adapters/ucPugs.ts`），transport 回归“零网盘依赖”；__pugs 捕获收口到 UC 适配器 request()
- 历史导出空括号 bug：数据源从 links store 改为 records store（与时间轴一致，含成功/失败状态）
- 移除浏览器直下/复制直链（UC referer 白名单拒绝第三方源，§10.1.4），目录树改为提示“用导出命令下载”

### 变更
- 代理连通测试写入全局日志（打印 POST 方法与目标）
- reverse-notes-uc.md 追加 §11（2026-08-16 决策与实测）

---

## [v1.1.1] 2026-08-15 —— UC 下载层 __pugs 令牌（联调实测）

### 新增
- 解析前“读取 Cookie 提示”弹窗（默认开，设置可关）：确认后新标签预热分享页，自动提取 __pugs 写入浏览器 jar（reverse-notes-uc.md §10）
- CF 代理捕获 upstream `set-cookie: __pugs=` → 回传 `x-pugs` 头 → SPA 存 localStorage（§10.2 代理捕获通道）
- curl/aria2/gopeed 导出自动注入 `Cookie: __pugs=...`（缺失时 curl 附带提示注释）
- `_headers`：全局 `Referrer-Policy: no-referrer`（UC checkplay 只放行 drive.uc.cn 或空 referer，§10.1.4）

### 修复
- UC 下载层认定从“游客零 cookie 可下”修正为“需 __pugs 人机校验令牌（游客态即可，3h 过期）”（§10）

### 变更
- reverse-notes-uc.md 追加 §10（__pugs 唯一必需 cookie + 双通道获取 + referer 白名单实测）
- UAC 表：UC needsCookie 置真、弹窗开关文案更新

---

## [v1.0.2] 2026-08-14 —— 待 Tzz 核验

### 新增
- 解析记录写入分享内容标题（ParseRecord.title = 首个文件/夹名），历史页标题不再回退裸链接
- 历史页："全部"筛选时条目前置网盘 logo（public/logos/<id>.png，缺省回退短字）

### 修复
- CORS 自动跳转后 30s 自动关闭新标签页并回到本站（桌面用户不再被晾在分享页）

### 变更
- 路线图新增：索引导出机制（本地足迹/历史 JSON 索引导出，供 clouddiskpub_subscription 项目对接）

---

## [v1.0.1] 2026-08-13 —— 小毛病修复 + 历史页

### 新增
- 历史页（#/history）：HISTORY 时间轴 + 十盘筛选（尾部"全部"）、标题取首个文件（夹）名多文件加"等"、
  同链接多次解析折叠展示、操作三件套（修改备注/重新解析/下载日志）
- LinkRecord.note 备注字段 + updateLinkNote；ParseRecord 全量查询 listAllRecords
- CORS 拦截兑底：偏好开关"CORS 拦截后自动跳转"（默认开；关=先弹窗 CorsJumpModal）——PC 端无书签可测
- PanTable 支持盘 logo（public/logos/<id>.png，缺省回退短字）+ 筛选模式 + 尾部"全部"
- 仓库地址按钮 GitHub 图标；Header 新增"查看历史"入口

### 修复
- 弹窗头部随内容滚动 → .modal-head sticky 固定（偏好设置/连接本地下载器等全部弹窗）

### 变更
- 重新解析：回输入页自动填充并触发解析

---

## [v1.0.0] 2026-08-13 —— v1.0 完结

### 新增
- 适配层：PanAdapter 接口 + registry + UC 适配器（token → detail → download 三连，零 Cookie）
- core：treeWalker（递归建树/分页/并发 3/大小聚合/失败容错）、linkFetcher（15 个/批 + 1s 节流）、errors（错误分类）、preferences（localStorage）
- footprint：IndexedDB 四件套（链接/树快照/解析记录/日志），日志 5MB 轮转 + 凭据删除线脱敏
- tasks：aria2（命令/input-file/RPC）、gopeed JSON、curl 命令、统一导出 + 目录树 md
- UI 1.0：输入页（分享文案提取/自动识别高亮/十盘表格）、结果页（目录树/勾选/批量直链/倒计时/失败重试/跨文件夹限制）、设置面板（UAC/默认方式/足迹）、弹窗全套（连接本地下载器/登录跳转/批量警告/Cookie 警告/重复点击提示）
- 文档：README、changelog、ai-usage、migration-linkswift、LICENSE(GPLv3)
- CSP 冒烟测试通过：drive.uc.cn 主文档无 CSP，书签注入路径可行

### 修复
- registry.ts 模块初始化 TDZ 崩溃（registerAdapter 先于 adapters 声明）——headless E2E 抓出
- 适配器 detail 响应 metadata（含 _total）位于 JSON 顶层而非 data 内

### 变更
- 项目更名 panhub_praser（package.json / 标签页标题）
- .gitignore 纳入 node_modules/、dist/

### 待办（v1.0 已知）
- bookmarklet（步骤 7）：inject/bridge/overlay + 独立构建，部署后按 Tzz 的 iframe 体验方案调整
- 23018 游客大小限制临界值待实测确认
- 提取码分享（passcode）全流程待实测

---

## 路线图（期待）

### 1.x —— 更多网盘适配
- 按 src/adapters/README.md 接入：百度 / 夸克 / 阿里 / 移动 / 天翼 / 城通 / 123 / 迅雷 / 光鸭
- 各盘 UAC 表真实值回填（转存/登录/限速/Cookie 需求）
- 需要登录的盘：Cookie 警告弹窗 + 登录跳转联动（组件已就位，接入时启用）
- 适配器单测（tests/uc.spec.ts 等，mock 响应）

### 2.0 —— FastAPI 后端（可选自托管）
- 用户填写后端地址即用：服务端代理解析（绕 CORS）
- Cookie 池：**不提供**，仅预留管理面板 + 用户账号鉴权
- 尝试绕过 IP 限制（多出口代理池方向）
- 口令转链接协议「敬请期待」

### 其他方向
- 本地下载器 RPC 直推任务（aria2.addUri / Gopeed API，配置弹窗已预留）
- 下载器 ETA 跟踪（偏好 trackEta 已预留，轮询 aria2 RPC 进度）
- 目录树懒加载（大目录按需展开子层）
- TUI 可视化进度（v1.1 交付）
- **索引导出机制**：本地足迹/历史 JSON 索引导出（TODOLIST，与 clouddiskpub_subscription 项目对接）
