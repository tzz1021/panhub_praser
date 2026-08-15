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

### 3.4 游客下载实测成功
- 未登录（游客）状态下，curl 下载直链返回 200，总大小 3.46GB 正常开始下载
- 下载时带完整 cookie 组 + UC 客户端 UA 更稳（见 §5）
- 大文件（3.7GB）游客可下，**23018 超限的临界值未知**（偏好设置里标注"临界未知"）

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
- [ ] 下载限速：直链带 `x-oss-traffic-limit=503316480`（约 480MB 流量限制？）——大文件可能触发，需验证

## 8. 测试样本

- 分享链接：`https://drive.uc.cn/s/dd2ad2345e124`（CorelDRAW 2026 企业高级版）
- 根目录 fid：`af63c0308acd46b3bb902fc4ddd1afda`
- 文件 1：`090d1515f4794601b0818163ccfe0655`（CorelDRAW TS 2025 install.zip, 3.72GB）
- 文件 2：`b124571b37ad453c917f429d6b4856f4`（CorelDRAW 2026 CN Repack.zip, 2.09GB）
- 测试脚本存档：`linkswift-uc/cdp_uc_test*.js`、`uc_nocookie_test.sh`
