# 变更日志（changelog）

> 面向开发者（repo:/dev/ 入口）。面向用户的说明见 README.md。
> 约定：`## [版本] 日期` + 三块（新增 / 修复 / 变更）。

---

## [v1.1.4] 2026-08-16 —— 回溯复用 + 首屏传输初始化修复（CF 链路实测确认）

### 新增
- **回溯功能**：历史页“再次解析”时，若上次解析在适配器复用窗口内（`reuseWindowHours`，
  取决于云服务商过期时间；UC = 6h）且快照带 stoken → **直接复用本地快照进结果页**：
  不请求代理（避免刷转发次数）、无弹窗，结果页时间/过期倒计时正常显示；窗口外回退正常重新解析
- scripts/live-proxy-check.mjs：线上代理 x-pugs 全链路验证脚本（token → stoken → 目录 →
  download 检查 x-pugs → 同响应 pugs 探测 OSS 直链），自动判定 CF 通道是否可用
- proxy.js 诊断日志（一行，定位后删除）：每次转发打印上游状态 + set-cookie 来源 + x-pugs 捕获与否

### 修复
- **首屏 CORS 弹窗**：启动即激活已保存的传输配置（main.tsx 初始化 setActiveTransport），
  不再默认 direct 导致每次获取资源列表都弹 CORS、必须进设置点“保存”才生效
- 移除远端残留的 src/core/pugs.ts（v1.1.2 架构纠偏遗漏，无引用）

### 变更
- TreeSnapshot 增加 stoken 字段（回溯复用需要；旧快照无 stoken 则不可复用）
- PanAdapter 增加 reuseWindowHours（默认缺省 = 不复用，各网盘按自身过期时间配置）
- reverse-notes-uc.md 追加 §12.6；changelog 同步

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
