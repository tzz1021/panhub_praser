# 夸克网盘逆向笔记（reverse-notes-quark.md）

> 适配器实现依据（2026-08-23 真机实测，分享链接）。对照：reverse-notes-uc.md（UC 版，同源架构）。
> 术语：scanner = 获取资源列表（token + 目录树）；prase = 解析下载方式（download 接口取直链）。

## 1. 分享链接形态

- 短链：`https://pan.quark.cn/s/<pwd_id>`（如 `3efb93ba1306`）
- 长链（跳转）：`https://pan.quark.cn/s/<pwd_id>#/list/share/<fid>-<name>/...`（地址栏格式，可定位分享内文件夹）
- 识别正则与 UC 同构（quark.cn 域）：`src/adapters/quark/selector.ts`

## 2. API（全部 `drive-h.quark.cn/1/clouddrive`，与 UC 同源但 host 不同）

### 2.1 token（获取分享访问令牌 stoken）
```
POST /share/sharepage/token?pr=ucpro&fr=pc&uc_param_str=&ver=2
{ "pwd_id": "<shareId>", "passcode": "" }
→ { code:0, data:{ stoken } }
```
- stoken 是**分享绑定**的：一个分享一个 stoken，混用报 14001
- 短链用户直接走这里拿 stoken（长链 URL 里也带 stoken，但我们不解析 URL 里的）

### 2.2 detail（单层目录/文件列表）
```
GET /share/sharepage/detail?pr=ucpro&fr=pc&uc_param_str=&ver=2&pwd_id=&stoken=&pdir_fid=&force=0&_page=1&_size=50&_fetch_banner=0|1&_fetch_share=0|1&fetch_relate_conversation=0&_fetch_total=1&_sort=file_type:asc,file_name:asc
→ { code:0, data:{ is_owner, list:[...] }, metadata:{ _total, _count, _page, _size } }
```
- **游客态零 cookie**，直接可读目录树
- **根目录必须 `_fetch_banner=1&_fetch_share=1`**，否则 metadata 不返回 → treeWalker 分页截断
- **包装层**：`pdir_fid=0` 返回分享文件夹本身（分享标题，dir），网页端从文件夹**内容**开始展示。
  适配器 list() 在 isRoot 且单目录时自动下钻一层（等价网页视图）
- list[] 关键字段：`fid`、`file_name`、`dir`、`size`、`share_fid_token`（prase 必带）、
  `format_type`、`file_type`（0=目录 1=文件）、`include_items`（目录内元素数）
- 分页：metadata._total 驱动（>50 文件目录翻页）

### 2.3 download（批量取直链，prase）
```
POST /file/download?entry=ft&fr=pc&pr=ucpro
{ "fids": [...], "fids_token": [...], "pwd_id": "...", "stoken": "..." }
→ { code:0, data:[{ download_url, file_name, size, md5, ... }] }
+ Set-Cookie: __pugs=...; Max-Age=10800; Domain=quark.cn
```
- 请求头可带 `Cookie: sdid=...; up=...; wk=...`（登录态，大文件必需）
- **fids_token 是短效的**（share_fid_token，实测几十分钟内过期 → 41020），过期需重新 scanner

## 3. 直链与下载凭据（§12 同响应绑定，与 UC 完全一致）

- `download_url` 形如 `https://dl-guest-sz-u.drive.quark.cn/...?auth_key=<6h签名>`（guest 后缀 = 游客直链）
- **直链必须带同响应 `__pugs`**：不带 → CDN 412（Tengine Precondition Failed）
- 响应 Set-Cookie `__pugs`（Max-Age 10800 = 3h），经代理 `x-pugs` 头回传 SPA（proxy.js 通用捕获，与 UC 同键）
- auth_key 有效期 21600s（6h），URL 带 Expires 语义（getExpiry 可直接解析 auth_key 过期）
- 适配器实现：直链 + 同响应 pugs 绑定；登录态 cookie + pugs 时拼 `cookieString` 整串

## 4. 错误码（HTTP 400/403 壳 + JSON 业务码，**必须先解析 body**）

| code | 含义 | 分类 | 备注 |
|---|---|---|---|
| 0 | 成功 | — | |
| 23018 | download file size limit | over-limit | **游客大小限制**，触发登录 cookie 弹窗 |
| 31001 | 请先登录 | need-login | |
| 14001 | 分享 ID 或 stoken 无效 | invalid | 常见于跨分享混用 stoken |
| 41020 | 转存文件 token 校验异常 | expired | share_fid_token 短效过期，重新 scanner |
| 15000 | 服务不可用 | server | |

- 注意与 UC 不同：UC 业务码走 HTTP 200 + body；夸克走 **HTTP 400/403 + body code**，
  scanner request() 必须先解析 JSON body 取业务码再判断 HTTP 状态（否则 23018 会丢失分类）

## 5. 游客大小限制（实测）

- 同一分享实测：41.43MB ✅ / 51.14MB ❌（23018）→ **guest 上限约 50MB**
- 8.5GB ISO guest 同样 23018；linkswift 称 200MB+ 强制登录，实测阈值更低（可能分时段/账号策略）
- 解法：用户填登录 cookie（sdid/up/wk）→ download 请求带 Cookie → 重试

## 6. 登录态 cookie（v1.1.9.1 修正：真实 key，非 sdid/up/wk）

- **真实 key**（交叉验证 alist/boxplayer/nfd/linkswift，2026-08-23）：
  - `__pus`：登录主凭证（必须，判断登录态就看它）
  - `__uid`：用户 id（辅助）
  - `__puus`：3h 会话 cookie（服务端在响应 Set-Cookie 里自动刷新，**请求缺失 __puus 时才下发新的**，alist#830）
  - 域 `.pan.quark.cn` 下有十几个 cookie，但 API 鉴权核心就是 __pus；找最小集合不划算
- **社区最佳实践：整串 cookie 原样发送**（linkswift/nfd 都是 document.cookie / 整串塞 Cookie 头）
- 适配器设计：
  - 弹窗 = 整串粘贴/导入（Netscape/JSON/Header 自动识别），自动检测 __pus/__uid/__puus 是否齐全
  - 存储：localStorage 整串；发送：download 请求头 `Cookie: <整串>` 原样
  - **自动刷新**：响应 Set-Cookie 的 __pus/__puus 经代理回传 x-quark-pus/x-quark-puus，适配器自动合并回本地
  - 直链导出 cookieString = 登录整串 + `; __pugs=<同响应>`
- 风险：过公用代理 = 登录凭据过第三方，SPA 弹窗红点警告
- 未实测：真实登录 cookie 下 8.5GB 下载是否解锁（无账号）—— 逻辑按 alist/linkswift 观察设计

## 7. etag / md5

- detail 响应**不含** md5；download 响应**免费带** md5（`data[].md5`，32 位 hex）
- 网盘侧 etag 查询接口需要登录 + 解密脚本，暂不做（adapter.limits.etagNote 已注明）
- 树行 md5 展示：v1.1.7 showEtag 列依赖 ShareFile.md5 —— 夸克 scanner 阶段没有，prase 后有（不回流树）

## 8. 与 UC 的差异速查

| 维度 | UC | 夸克 |
|---|---|---|
| API host | pc-api.uc.cn | drive-h.quark.cn |
| query | pr=UCBrowser&fr=pc | pr=ucpro&fr=pc&uc_param_str=&ver=2 |
| 分享根 | pdir_fid=0 直接是内容 | pdir_fid=0 是包装文件夹，需下钻 |
| 业务错误 | HTTP 200 + code | HTTP 400/403 + code（先解析 body） |
| 游客限制 | 4G+ 不限制（临界未知） | **约 50MB**（实测 41/51 边界） |
| 登录 cookie | 不需要（游客态） | 大文件需要 sdid/up/wk |
| etag | 不支持 | download 响应免费带 md5 |
| __pugs | 同机制 | 同机制（3h，Domain=quark.cn） |
