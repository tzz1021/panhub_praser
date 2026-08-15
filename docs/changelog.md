# 变更日志（changelog）

> 面向开发者（repo:/dev/ 入口）。面向用户的说明见 README.md。
> 约定：`## [版本] 日期` + 三块（新增 / 修复 / 变更）。

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
