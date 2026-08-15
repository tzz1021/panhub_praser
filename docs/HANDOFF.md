# 新会话提示词（HANDOFF）— 云链解析站开发启动包  
  
> 用法：在新会话第一句话把本文件**全文**发给 agent（或 `read` 本路径）。  
> 本文件自包含：背景、已验证事实、设计、规范、分工、我的想法（斜体）。  
  
---  
  
## 0. 你是谁  
  
你是小扳（🔧），Tzz（主人）的编程搭档。风格：务实、直接、少废话、敢于动手。  
主人偏好：能增不改、能改不删；先给方案再动手；讨厌客套。  
模型：deepseek-v4-flash（当前会话）。工作区：`/home/user/.openclaw/workspace/pan-web/`。  
  
## 1. 项目一句话  
  
**云链解析站（pan-web）**：把 LinkSwift 的"装油猴脚本"变成"拖一个书签、打开分享页点一下"。  
定位：服务担心脚本安全、嫌麻烦、偶尔使用的普通玩家。GitHub 托管，无后端，零数据上传，GPLv3 开源。  
  
## 2. 已验证的技术事实（勿重复实验，直接采信）  
  
见 `docs/reverse-notes-uc.md`（完工版）。速记：  
  
- **UC API 三连**（全部零 cookie，纯 requests 可通）：  
 1. `POST pc-api.uc.cn/1/clouddrive/share/sharepage/token` `{pwd_id}` → `stoken`  
 2. `GET .../sharepage/detail?pwd_id&stoken&pdir_fid=<0=根|目录fid>` → `list[]`（fid/file_name/dir/size/share_fid_token）  
 3. `POST .../file/download?entry=ft&fr=pc&pr=UCBrowser` `{fids,fids_token,pwd_id,stoken}` → `download_url`  
- **⚠ entry 参数必带**（缺了 401 加密串）——这是本项目踩过最大的坑  
- **CORS 白名单只放行 drive.uc.cn** → 纯前端直连死路，必须书签注入（同源执行）  
- 直链是 OSS 签名 URL，**字符敏感**，复制必须原生剪贴板 API  
- 直链 3-6h 有效，可 `-C -` 续传；游客可下载大文件（23018 临界值未知）  
- 错误码映射：31001 需登录 / 23018 游客超限 / 14001 参数无效 / 41020 token 失效  
- 节流参考：批量 15 个/批 + 1s 间隔（LinkSwift 同款）  
  
## 3. 项目设计（Tzz 定稿，照做）  
  
### 3.1 用户/开发者分离  
- README 面向用户：只说前端 feature，承诺零上传、免安装、GitHub 托管不跑路  
- `docs/changelog.md` + `docs/ai-usage.md` 面向开发者（repo:/dev/ 入口），完全站在开发角度  
- 首次提交写 `docs/migration-linkswift.md`：LinkSwift 功能怎么迁移的，尊重版权，GPLv3  
  
### 3.2 核心功能  
1. 输入分享链接 → 自动识别网盘（registry）  
2. 目录树遍历（深度可配、显示文件夹大小、可过滤文件、md5/sha1 等标识符可选）  
3. 勾选文件 → 批量直链 → 导出（aria2/gopeed 保留目录结构 / cURL / 浏览器直下）  
4. 足迹系统（仅本地 IndexedDB）：已填链接（查重、限 100 条）、目录树快照、解析记录（时间/次数/成败）、完整日志（5MB 轮转，cookie  
用删除线标记）  
5. 偏好设置（localStorage）：  
  - UAC 表：网盘 × {是否转存 / 是否登录 / 能否移除限速 / 读取 cookie 警告 / 登录跳转弹窗 / 自动关标签}  
  - 默认下载方式：单文件（解析|下载二选一）、同目录批量、跨目录（保留结构开关、扫描深度、确认弹窗默认开、ETA 跟踪默认开、目录树  
默认开、TUI 进度默认开（v1.1 交付，1.0 不做））  
  - 批量解析仅支持 aria2/gopeed（弹窗提醒）；反复点击"批量解析"给提示  
6. 弹窗 = React hooks 事件（不是手写 DOM）  
  
### 3.3 网盘支持  
- v1 只做 UC（已验证）。适配器接口预留，后续百度/夸克/阿里/移动/天翼/城通/123/迅雷/光鸭按 `src/adapters/README.md` 指南接入  
- 未来：可选的 FastAPI 后端（用户填后端地址即用），nfd 云解析待议；口令转链接协议"敬请期待"  
  
## 4. 代码规范（照做）  
  
- 目录结构见 `docs/STRUCTURE.md`（带注释，先按它建骨架）  
- TS strict；kebab-case 文件、PascalCase 组件、camelCase 变量  
- **UI 永不 import 具体适配器**，只走 `registry` + `PanAdapter` 接口  
- `core/` 零网盘依赖；bookmarklet 独立入口复用共享组件  
- 不引埋点/统计库（隐私承诺）；中文提交信息  
  
## 5. 开发顺序（防上下文不足：小步走，每步可验证）  
  
1. **骨架**：按 STRUCTURE.md 建目录 + types.ts（PanAdapter 接口）+ registry 桩  
2. **UC 适配器**（uc.ts）：按 reverse-notes 实现三连 API，纯函数，可单测  
3. **core**：treeWalker（深度/并发 3/聚合大小）、linkFetcher（15/批节流）、errors 映射  
4. **footprint**：IndexedDB 四件套（db/links/trees/records/logs）+ 轮转  
5. **tasks**：aria2/gopeed/curl 生成器 + export（目录树 md）  
6. **UI**：LinkInput → DirectoryTree → 结果页 → 设置面板（UAC/默认方式/足迹）  
7. **bookmarklet**：inject + bridge + overlay，独立构建  
8. **文档**：README / changelog / ai-usage / migration-linkswift / LICENSE(GPLv3)  
  
## 6. 子 agent 分工建议（并行时用）  
  
| Agent | 任务 | 依赖 | 输出 |  
|---|---|---|---|  
| **A-适配器** | uc.ts + registry + 单测 | reverse-notes-uc.md | `src/adapters/*` |  
| **B-核心** | treeWalker/linkFetcher/errors | types.ts（先定） | `src/core/*` |  
| **C-足迹** | IndexedDB 四件套 + 轮转/导出 | types.ts | `src/core/footprint/*` |  
| **D-任务** | aria2/gopeed/curl/export | types.ts | `src/tasks/*` |  
| **E-UI** | 页面 + 组件 + 设置面板 | B/C/D 接口（可 mock） | `src/pages/*` `src/components/*` |  
| **F-书签** | inject/bridge/overlay | A 接口 | `src/bookmarklet/*` |  
  
主 agent 负责：先定 `types.ts` → 派发 B/C/D（互不依赖）→ A 并行 → E/F 后置 → 集成测试 → 文档。  
子 agent 一律 `sessions_spawn`，任务里写明：目标文件、依赖路径、接口签名、完成定义（可运行/可单测）。  
  
## 7. 我的想法（斜体，供 Tzz 参考，不阻塞开发）  
  
- *书签注入有个隐患：drive.uc.cn 页面可能带 CSP（Content-Security-Policy），会阻止注入的 `<script>` 或浮层 iframe。建议骨架阶段先  
做 5 分钟冒烟测试：书签往网盘页注入脚本 + 渲染浮层，确认 CSP 不拦。若拦，备选方案是"书签跳转主站 + 主站 iframe 嵌入分享页"（但 CO  
RS 已证死，这条基本走不通），或"书签只负责收集 URL，跳回主站用后端代理解析"（违背零上传，最后手段）。*  先测试书签，如果失败请及时通知
- *"自动关闭新标签页"在浏览器里有限制：JS 只能关自己 open 的窗口。设计上登录跳转弹窗要区分"我们打开的标签"（可关）和"用户自己开的  
"（不能关），否则功能会失效还显得像 bug。*  这里前端组件需要写清楚
- *UAC 表里"读取 cookie 警告弹窗"——既然 API 零 cookie，v1 的 UC 其实不需要读 cookie。建议这个开关默认关，等接入需要 cookie 的网盘  
（如某些要求登录的）再启用，避免误导用户以为我们读了他的 cookie。*  大部分都是需要的，不过测试版可以先放着
- *批量下载"保留目录结构"只有 aria2/gopeed 支持，浏览器直下和 cURL 都不行——UI 上这三个选项要联动禁用，别让用户选了 cURL 又勾"保留  
结构"然后报错。*  批量下载仅在“跨文件夹”时候才会仅支持 aria2/gopeed
- *日志文件命名规范里带"解析操作次数+时间+状态"会让文件名很长，建议文件名只保留"链接缩写+时间戳+状态"，详情放文件头元数据。*  同意
- *TUI 可视化进度（偏好默认开）：网页里做 TUI 是伪需求，建议默认关；真正的价值是 aria2 RPC 轮询进度展示在结果页，这个可以做但放 v  
1.1。*  1.0不交付
  
## 8. 交付标准  
  
- `npm run dev` 起得来；书签产物能构建  
- UC 真实分享链接端到端跑通：输入 → 目录树 → 勾选 → 导出 aria2 命令  
- 足迹/日志落 IndexedDB，导出 md 正常  
- 全部 git commit（中文信息），首次提交含 LICENSE(GPLv3) + migration-linkswift.md
## 9.你的附件
## 偏好设置页面参考，只参考布局样式而不是使用这里的默认设置，UAC表格里面需要大量开关，开关按钮边缘线需要相邻不重色设计，开启默认内部绿色否则灰色，按键白色，使用int.design风格
## 偏好设置

### 1.UAC选项

  

|                        |           |     |           |               |     |     |     |     |         |     |     |
| ---------------------- | --------- | --- | --------- | ------------- | --- | --- | --- | --- | ------- | --- | --- |
|                        |           | 百度  | 夸克        | UC            | 阿里  | 移动  | 天翼  | 城通  | 123     | 迅雷  | 光鸭  |
| 是否需要转存                 |           |     |           |               |     |     |     |     |         |     |     |
| 是否需要登录                 |           |     | 200mb+才需要 | 4G文件都不需要，临界未知 |     |     |     |     | 是       |     |     |
| 能否移除限速                 |           |     | 能         | 能             |     |     |     |     | 网盘承诺不限速 |     |     |
| 读取cookie警告弹窗           |           | 开关  | 开关        |               |     |     |     |     |         |     |     |
| 需要登录but未登录/登录过期        | 跳转提示弹窗    | 开关  |           |               |     |     |     |     |         |     |     |
|                        | 自动关闭新的标签页 |     |           |               |     |     |     |     |         |     |     |
| 需要登录and已经登录            | 跳转提示弹窗    |     |           |               |     |     |     |     |         |     |     |
|                        | 自动关闭新的标签页 |     |           |               |     |     |     |     |         |     |     |
| 不需要登录                  |           |     |           |               |     |     |     |     |         |     |     |
|                        |           |     |           |               |     |     |     |     |         |     |     |
| 批量解析“仅支持aria/gopeed“弹窗 |           |     |           |               |     |     |     |     |         |     |     |
| 检测到反复点击提示“批量解析”弹窗      |           |     |           |               |     |     |     |     |         |     |     |

弹窗=react里面的hooks事件

### 2默认下载/解析

1）单个文件默认下载方式：___

对于单个file提供“解析”“下载”两个选项

解析：获取文件直链并展示对应下载方式

下载：按照你的默认下载方式直接下载

2）同一目录下批量文件默认下载方式：___

解析：获取文件直链并展示对应下载方式

下载：默认使用单个文件下载方式

3）跨越文件夹的默认下载方式

是否保留原始目录结构（仅支持aria2和gopeed）：

扫描深度：

显示文件夹大小：

过滤的文件：

确认解析弹窗：默认开

显示每个 file 跟踪下载器 ETA：默认是

显示目录树：默认是

tui 可视化跟踪进度：默认是（v1.1 交付，1.0 不显示）

### 3.默认足迹保留（仅保留在本地，从未离开你的设备）

内部是json元数据索引式存储，日志单独存储。在导出时转换格式输出

1）已填入的链接（明文存储，附带时间，用于查重）：默认前端是

- - - - - - - - - - - - - - - - - -

| http自动分盘识别丨 丨确定 |

- - - - - - - - - - - - - - - - - -

存储限制：保留xx天/最近xx个（不管彼此是否重复），默认100个

2）自动获取的目录树（md格式）：默认是

目录树格式：两种格式（参考123云盘）默认“|---”模式

目录树详细程度：file大小✅etag（md5/sha1）✅分享时间✅用户存储时间✅平台存储时间（部分网盘支持）✅

存储限制：与1）保持同步

3）解析记录是否在目录树呈现：

是否斜体：默认是

记录解析时间，次数，是否成功

4）完整解析日志（md格式，cookie使用删除线标记求助时请勿明文出现）：默认是

命名规范：

{链接缩写，例子 uc-dd2ad2345e124 表示 https://drive.uc.cn/s/dd2ad2345e124}_{解析时间戳}_{状态，成功=s，失败=e，未知错误=u，部分成功=m}.log
（文件名保持简短：解析操作次数、批量解析标识（0=否）、日志等级等详情放文件头元数据，见 §7）

日志等级：fatal/info/debug，默认debug

存储限制：保留xx天/最近xx条（不推荐，一个链接可以多次参与解析）/最大体积：xxMB。默认5MB
## SPA默认页面参考
pdpb.cn
去掉最上方的教程文档，改成repo地址。可以现放一个图标后续我补充

