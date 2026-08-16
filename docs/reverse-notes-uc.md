# UC 网盘逆向笔记 v1（完工版）

> 整理日期：2026-08-12
> 适用：云链解析站（pan-web）UC 适配器开发
> 验证方式：纯 requests 实测 + Chromium CDP 实测 + 真实下载实测

---

## 1. 分享链接结构

```
https://drive.uc.cn/s/<pwd_id>
例：https://drive.uc.cn/s/dd2ad2345e124
```

- `<pwd_id>` = 分享 ID，是后续所有 API 的核心参数
- 可能形态：`/s/xxx` 或 `/share/xxx`

## 2. API 全流程（v1 核心，全部实测通过）

### 2.1 获取 stoken
```
POST https://pc-api.uc.cn/1/clouddrive/share/sharepage/token?pr=UCBrowser&fr=pc
Content-Type: application/json

{"pwd_id":"<pwd_id>","passcode":""}

→ data.stoken = "<stoken>"   （分享访问令牌，后续所有接口都要带）
```
- passcode 为空（无提取码时）
- 若分享有提取码，passcode 填提取码

### 2.2 文件列表 / 目录遍历
```
GET https://pc-api.uc.cn/1/clouddrive/share/sharepage/detail
    ?pwd_id=<pwd_id>
    &stoken=<stoken>
    &pdir_fid=0                  ← 根目录用 "0"，子目录用父目录 fid
    &force=0
    &_page=1
    &_size=50
    &_fetch_banner=1             ← 根目录 1，子目录 0
    &_fetch_share=1              ← 根目录 1，子目录 0
    &_fetch_total=1
    &_sort=
    &pr=UCBrowser&fr=pc
Content-Type: application/json

→ data.list[] 每个元素：
  fid            文件 ID（后续下载用）
  file_name      文件名
  dir            是否目录（true=目录）
  size           文件大小（目录为 0）
  share_fid_token 分享文件令牌（下载必带）
  format_type    格式（application/zip 等）
```

**遍历目录**：`pdir_fid` 换成该目录的 `fid` 再次请求即得子目录内容。

### 2.3 获取下载直链
```
POST https://pc-api.uc.cn/1/clouddrive/file/download?entry=ft&fr=pc&pr=UCBrowser
Content-Type: application/json

{"fids":["<fid>"],"fids_token":["<share_fid_token>"],"pwd_id":"<pwd_id>","stoken":"<stoken>"}

→ data[0].download_url = "<OSS 签名直链>"
  data[0].file_name / size / md5
```

**⚠️ 关键：`?entry=ft&fr=pc&pr=UCBrowser` 三个参数缺一不可，漏掉直接 401 加密串。**

## 3. 重大结论（决定架构的事实）

### 3.1 API 层零 cookie ✅
- token / detail / download 三个接口**均不需要 cookie**，纯 requests 全通
- 之前误以为需要 `__pugs` 等指纹 cookie——**错的**，真正缺的是 entry 参数
- 意味着：服务端/书签注入都不需要读取、存储用户 cookie（隐私友好）

### 3.2 CORS 白名单（限制部署形态）
```
Origin: https://drive.uc.cn   → 200 + Access-Control-Allow-Origin: https://drive.uc.cn
Origin: https://xxx.github.io → HTTP 403（服务端拒绝）
```
- UC 只放行 drive.uc.cn 自己 → **任何非 drive.uc.cn 域名的纯前端直连不可行**
- 架构选择：书签注入（在 drive.uc.cn 域执行，同源）——本项目选型 ✅

### 3.3 直链 = OSS 签名 URL（字符敏感）
- 格式：`https://dl-uf-zb.pds.uc.cn/<bucket>/<path>?Expires=...&OSSAccessKeyId=...&Signature=...&callback=...`
- **一个字符都不能改**：粘贴/复制/传输中 URL 编码损坏 → `403 SignatureDoesNotMatch`
- UI 复制必须用 `navigator.clipboard` 原生 API，禁止走文本渲染层
- 直链有效期 **3-6 小时**（实测），过期可重新调 download 获取新直链，配合 `-C -` 断点续传

### 3.4 游客下载实测成功 ⛔（2026-08-15 修正，见 §9）
- ~~未登录（游客）状态下，curl 下载直链返回 200，总大小 3.46GB 正常开始下载~~
- **修正：所有成功案例均带了完整 cookie 组（§5），纯无 cookie 请求会被 checkplay 掐流（§9），游客路线实际不可用**
- 大文件（3.7GB）可下，**23018 超限的临界值未知**（偏好设置里标注"临界未知"）

## 4. 错误码映射（→ 前端中文文案）

| code | 含义 | 文案 |
|---|---|---|
| 31001 | 需登录 | 请先登录网盘（分享者或访问者要求） |
| 23018 | 游客可获取大小限制 | 超出游客可获取大小限制，请登录后获取 |
| 14001 | 参数缺失 | 分享 ID 或 stoken 无效，请刷新重试 |
| 41020 | 转存文件 token 校验异常 | 文件令牌失效，请重新解析 |
| 15000 | 内部错误 | 服务暂时不可用，请稍后重试 |
| 401 + 加密串 | 缺 entry 参数 / 风控 | 请检查请求参数完整性 |

## 5. 下载最佳实践（实测组合）

```
UA:  Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)
     uc-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36
     Channel/pckk_other_ch
Referer: https://drive.uc.cn/
Cookie:  __itrace_wid=...; ctoken=...; b-user-id=...; __sdid=...; __pugs=...（完整组）
```

- 游客直链 + 完整 cookie 组可下载（200）
- `-C -` 断点续传可用
- 直链过期：重新调 download 接口拿新直链，续传原文件

## 6. 与 LinkSwift 对照（L8631-L9013）

| 项 | LinkSwift | 本项目 |
|---|---|---|
| 执行环境 | 油猴脚本（注入网盘页） | 书签注入（同源，免脚本管理器） |
| getLink URL | `file/download?entry=ft&fr=pc&pr=UCBrowser` | 相同（已验证） |
| 文件列表来源 | React props 读取 | API 直取（更稳，不依赖页面结构） |
| 批量 | 15 个/批 + 1s 节流 | 复用该节流策略防风控 |
| 目录遍历 | 不支持（仅当前页） | 支持（detail?pdir_fid 递归）✅ 本项目的差异化 |
| UA | uc-cloud-drive 客户端 UA | 相同 |

## 7. 待验证项

- [ ] 23018 游客大小限制临界值（4G 以下都成功，临界未知）
- [ ] 直链下载是否存在 IP 限制（当前单 IP 实测成功，多 IP 未测）
- [ ] 提取码分享（passcode）流程（当前测试分享无提取码）
- [ ] 子目录多层的遍历稳定性（当前测到 2 层）
- [x] ~~下载限速：直链带 `x-oss-traffic-limit=503316480`（约 480MB 流量限制？）~~ → **已解（§9.4）：这是 60MB/s 带宽限速参数，不是字节上限**

## 8. 测试样本

- 分享链接：`https://drive.uc.cn/s/dd2ad2345e124`（CorelDRAW 2026 企业高级版）
- 根目录 fid：`af63c0308acd46b3bb902fc4ddd1afda`
- 文件 1：`090d1515f4794601b0818163ccfe0655`（CorelDRAW TS 2025 install.zip, 3.72GB）
- 文件 2：`b124571b37ad453c917f429d6b4856f4`（CorelDRAW 2026 CN Repack.zip, 2.09GB）
- 测试脚本存档：`linkswift-uc/cdp_uc_test*.js`、`uc_nocookie_test.sh`

---

## 9. 2026-08-15 追加：下载层 cookie 强校验（curl 双命令实测）

> 追加人：小扳（与 Tzz 联调）

### 9.1 实验设置（同一分享、同一文件、两条新签名直链）

| 命令 | 差异 | 结果 |
|---|---|---|
| panhub 导出 curl（`src/tasks/curl.ts` 原样） | UA + Referer，**无 cookie** | 200 开始传输 → **提前终止**（>378B 的文件必断） |
| LinkSwift 导出 curl | UA + Referer + **完整登录 cookie 组**（`ctoken`/`b-user-id`/`__pugs`/`__sdid` 等） | 正常下载，`-C -` 断点续传成功（同一文件、新签名 URL） |

- 两条命令 URL 结构完全一致（同 object、同 `x-oss-traffic-limit`、同 callback 参数），**唯一变量是 cookie**。
- “378 字节”不是魔法阈值，是**掐流前能吐出的数据量**的观察值：小文件（整个响应塞进这个窗口）能下完，大文件必断。

### 9.2 根因：OSS 下载前回调 `checkplay` 强校验登录态

直链 URL 里带 OSS callback 参数（`callbackStage: before-execute`，目标 `https://auth-cdn.uc.cn/outer/oss/checkplay`），
回调 body 显式携带请求的 `cookie`/`referer`/`size`/`range` 等字段——**checkplay 就是拿这些校验“是不是登录用户在下载”**。

- 无 cookie → 校验不通过 → 网关掐流。
  - 2026-08-11 CDP 实测表现：直接 `403 RequestDeniedByCallback: require login [auth not found]`（LinkSwift REVERSE_NOTES v2）
  - 2026-08-15 curl 实测表现：200 + 少量数据后掐断（`callbackFailAction: ignore` 放行后由网关侧掐流）
- 带登录 cookie → 校验通过 → 正常下载。

### 9.3 为什么“居然续传”成功

- 下载服务器支持 HTTP Range；`curl -C -` 发 `Range: bytes=N-`，服务器回 206 从断点继续。
- 续传用的是**同对象的新签名 URL**（新 Expires/Signature/x:token），不依赖上一次的连接状态。
- 结论：**“掐断 → 重新解析拿新直链 → `-C -` 续传”是可靠策略**，前提是带上 cookie。

### 9.4 修正：`x-oss-traffic-limit=503316480` 是限速不是限流量

- 503316480 bit/s = **60 MiB/s 带宽上限**（阿里云 OSS 官方取值域 819200~838860800 bit/s 内）。
- 不是“480MB 流量上限”（§7 旧猜测错误，503316480 恰好等于 480MiB 的字节数，纯巧合）。
- 限速本身不会掐断连接，大文件断流主因仍是 §9.2 的 cookie 校验。

### 9.5 修复方向（导出链路注入 cookie）

1. 设置面板新增**可选**“下载 Cookie”（提示：从已登录 drive.uc.cn 的浏览器复制，仅本地存储）；
2. `src/tasks/curl.ts`：配置了 cookie 时追加 `-b "<cookie 串>"`；
3. aria2/gopeed 导出：追加 `Cookie: <串>` 请求头（gopeed/aria2 header 参数）；
4. 浏览器内下载路径（`window.open(直链)` / `<a download>`）是 top-level 导航，已登录用户浏览器**自动带 SameSite 允许的 .uc.cn cookie**，大概率无需改动——待 Tzz 验证；
5. 未配置 cookie 时导出命令附注提示“可能被掐流”。

### 9.6 待验证

- [ ] 浏览器内下载路径（已登录）是否无需 cookie 配置即可完整下载
- [ ] 续传能否一路下完 3.72GB（Range 是否每次都放行、是否中途再次掐流）
- [ ] checkplay 是否绑定 x:token 与 cookie 的账号一致性（换账号 cookie 是否拒绝）
- [ ] 登录态 cookie 过期后是否静默退化为“掐流”而非 403

---

## 10. 2026-08-15 追加：`__pugs` 是唯一必需 cookie（游客态即可）——推翻“必须登录”结论

> 追加人：小扳（与 Tzz 联调，curl 双命令 + 完整链路实测）

### 10.1 结论（全部实测）

1. **下载层只认 `__pugs` 一个 cookie**，游客态即可，不需要登录。
   - Tzz 逐一测试 linkswift 给的 8 个 cookie：`__sdid` / `ctoken` / `b-user-id` / `__itrace_wid` / `HMACCOUNT` / 两个 Hm 时间戳全部无用；**唯一必需是 `__pugs`**（人机校验令牌，每次随机，3h 过期）。
   - §9 的“必须登录 cookie”结论作废——当时成功案例只是恰好整套 cookie 里含 `__pugs`。
2. **`__pugs` 由 pc-api 响应 `Set-Cookie` 下发**（Domain=uc.cn, Path=/, Max-Age=10800）：
   ```
   set-cookie: __pugs=b7aa098a…; Max-Age=10800; Domain=uc.cn; Path=/
   ```
   token/detail/download 任一接口的响应都带（实测 403 错误响应也带）。**代理/客户端直接捕获响应头即可，无需读页面 cookie。**
3. **OSS 直链 + `__pugs` → 206/200 正常下载**（实测 `-b "__pugs=..."` + UA + 任意合法 referer 或空 referer 均通过）；**无 cookie → 403**，拒绝体是 378 字节 XML（`RequestDeniedByCallback: require login [auth not found]`）——与 Tzz 观察到的“>378 字节文件提前终止”纯巧合同数字。
4. **referer 白名单校验（浏览器直连失败的根因）**：
   | Referer | 结果 |
   |---|---|
   | （无） | 200 ✅ |
   | `https://drive.uc.cn/` | 200 ✅ |
   | `https://<pages.dev 或 github.io>` | **403** ❌ |
   → SPA 部署在第三方域时，浏览器直连下载必须**去掉 referer**（`Referrer-Policy: no-referrer` 或 `rel="noreferrer"`），否则被 checkplay 拒绝。
5. **浏览器路径需要的 `__pugs` 在浏览器自己的 cookie jar 里**：访问一次分享页（drive.uc.cn/s/xxx，页面 JS 会自动调 API）即被 Set-Cookie 写入 jar；随后 top-level 下载导航（SameSite=Lax 默认）自动携带。SPA 无法跨域写/读 .uc.cn cookie，所以浏览器路径靠“新标签页预热”，导出路径靠“代理捕获值注入命令”。

### 10.2 两个获取通道（架构决策）

| 通道 | 机制 | 用途 |
|---|---|---|
| 代理捕获 | CF Pages Function 转发 API 时提取 upstream `set-cookie: __pugs=` → 回传 `x-pugs` 响应头 → SPA 存 localStorage | curl/aria2/gopeed 导出命令注入 `-b`/header |
| 新标签预热 | `window.open(分享页)` → 页面 JS 自动触发 API → `__pugs` 写入浏览器 jar → 稍候自动关闭标签 | 浏览器内直连下载 |

### 10.3 修正旧记录

- §3.1 “API 层零 cookie”：请求端确实无需携带 cookie ✅，但**响应端会下发 `__pugs`（Set-Cookie）**——不是“零 cookie 链路”，是“请求零 cookie、响应带 cookie”。
- §3.4 “游客下载实测成功”：成立，但前提是带 `__pugs`；纯无 cookie 请求 403。
- §5 “完整 cookie 组更稳”：实际只需 `__pugs` 一个，其余 7 个可有可无。
- §7 “23018 临界未知”保留；`x-oss-traffic-limit` 已解（§9.4，60MB/s 限速）。

### 10.4 待验证

- [ ] `__pugs` 是否绑 IP/UA：代理（CF 边缘 IP）捕获的值，拿到用户本机 curl 是否仍放行（当前同 IP 实测通过，跨 IP 未测）
- [ ] 预热标签页打开后多久 `__pugs` 落 jar（当前等待 6s 关闭，是否够）
- [ ] 115 网盘是否同构（鸣谢 linkswift 模拟 UC 浏览器 PC 端 UA 的思路，115 浏览器同理可模拟）

---

## 11. 2026-08-16 追加：v1.1.2 实测反馈与架构决策（Tzz 联调）

> 追加人：小扳（Tzz 反馈整理 + 代码改造）

### 11.1 实测：预热标签 ≠ 拿到令牌值

- Tzz 部署 v1.1.1 后实测：aria2 报 `errorCode=22 状态=403`；curl 导出仍出现“未捕获 __pugs”提示。
- 结论确认：**预热标签只把 __pugs 写进浏览器 cookie jar，SPA 跨域读不到值**（§10.2 早已标注的 JS 限制）；
  **值只能走代理捕获通道**（download 接口响应 → x-pugs 头 → localStorage）。
- 若解析走 direct（CORS 拦）或代理未配置，捕获必然为空 → 导出命令无令牌 → 403。
- 对策：弹窗改为**如实显示捕获状态**（有值/空 + 排查话术），让用户一眼知道令牌是否到位。

### 11.2 浏览器直连下载正式移除

- 实测：浏览器内下载带 __pugs 仍被拒 —— 下载导航 referer 是 pages.dev，checkplay 白名单只认
drive.uc.cn 或空 referer（§10.1.4）；pdpb 等同类解析站同样不支持浏览器直下。
- 决策：移除“浏览器直下/复制直链”入口，目录树改为提示“用导出命令下载”；
  `_headers` 全局 no-referrer 保留（curl/aria2 无影响，未来若要恢复浏览器直下可再测空 referer 场景）。

### 11.3 架构纠偏：pugs 归 adapters

- 违反“core/ 零网盘依赖”承诺：v1.1.1 把 `pugs.ts` 放进了 core/。
- 已修正：`src/adapters/ucPugs.ts`（UC 专属），transport 层回归纯 HTTP；
  __pugs 捕获收口到 UC 适配器 `request()`（所有 UC API 响应的唯一路径）。

### 11.4 cookie 敏感度评估（Tzz 观点，记录）

- 参考 nfd 云解析：用户 cookie 会上传赞助服务器转发文件流绕 IP 限制；作者因此鼓励自建 + docker。
- Tzz 结论：cookie 定时过期 + CF 公共节点数据流大，劫持 cookie 无意义；
  携带 cookie 转发请求头可接受，且可顺带实测 IP 限制严格度。
- 更优方案（采纳）：**cookie 不随请求上传，导出命令本地拼接**（代理只捕获值，注入在本地完成）。

### 11.5 日志体系（开发调试）

- 全局日志：历史页十盘 banner 下方新增 banner（可展开），标注“仅用于开发调试，不会过滤隐私信息”；
  记录服务启动（含上次启动时间）/偏好变更/解析生命周期/代理测试 POST 方法/导出 merger。
- 原足迹日志保留（按链接归档 + 脱敏），两者分工：链接日志看单条链接行为，全局日志看系统状态。
- 日志体量：单条 <1KB、100 条才 5MB 的现状说明记录过于稀疏 —— 放开写，环形 300 条足够。

### 11.6 遗留待办（Tzz 列表，未实现）

- [ ] 单文件解析（当前只有批量）
- [ ] 设置备份/恢复（localStorage 导出导入）
- [ ] RPC 高级功能（aria2.addUri 直推等，v1.1 已预留下载器配置）
- [ ] 历史导出改为 records 数据源已修（v1.1.2）；单链接日志导出格式继续按 demo 打磨
