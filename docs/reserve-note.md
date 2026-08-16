# Reserve Note —— 预留/备忘笔记（重要结论与坑）

> 用途：记录“踩过坑后确认的结论”，防止未来接入新网盘/重构时重蹈覆辙。
> 时间：2026-08-16（v1.1.2 联调后，Tzz 反馈 + 实测复现）

---

## 1. 下载直链与 __pugs 必须同响应绑定（UC，实测复现）

### 1.1 结论

- **linkswift 获取的“下载直链”（本项目直接复用，非必要不做更深逆向）都需要 __pugs 鉴权。**
- **不同环境（即使是不同浏览器）获取的 __pugs 无法混用**；实测更严：**同一环境、相邻两次请求的 pugs 也不能混用** —— 绑定粒度是**响应级**，不是环境级。

### 1.2 报错特征（379 字节 XML）

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Error>
 <Code>RequestDeniedByCallback</Code>
 <Message>Callback deny this request reason: Cdn auth fail: ucidMd5 invalid.</Message>
 <RequestId>6A815AEAB10DF43339DABFA7</RequestId>
 <HostId>dl-uf-zb.pds.uc.cn</HostId>
 <EC>0007-00000209</EC>
 <RecommendDoc>https://api.aliyun.com/troubleshoot?q=0007-00000209</RecommendDoc>
</Error>
```

### 1.3 实测矩阵（2026-08-16，真实 UC 分享 + OSS 直链探测）

| 组合 | 结果 |
|---|---|
| 直链A + A响应下发的 pugs | HTTP 200，正常文件流 ✅ |
| 直链B + B响应下发的 pugs（同环境相邻请求） | HTTP 200 ✅ |
| **直链A + B响应的 pugs（同环境跨请求）** | **HTTP 403，379B XML（ucidMd5 invalid）❌** |
| 直链A + 本地直连取的 pugs（跨“环境”） | HTTP 403 ❌ |
| 批量（一次请求 2 个 fids）两个直链 + 该响应的同一个 pugs | 双双 200 ✅ |

**推论：**

1. `download_url` 的 OSS callback 签名绑定了**该次响应下发的 pugs**（ucidMd5），
   客户端必须原样回带同一个值。
2. 批量解析**一次请求多个 fids** 时，同一次响应的所有直链共享该响应的 pugs —— 可行。
3. 分批解析（linkFetcher 15/批）时，**每批各有一个 pugs**，导出命令必须**按文件注入各自的值**；
   用一个全局值注入所有文件 → 只有最后一批能下，其余全部 403。
4. “跳转页面去拿 cookie”对导出链路**毫无意义**：跳转只能把 __pugs 写进浏览器 jar
   （SPA 跨域读不到 jar 值），而直链需要的 pugs 必须来自**产生该直链的同一个请求环境**。

### 1.4 架构落点（已固化到 core）

- `DownloadResult.cookie` / `LinkResult.cookie` / `ExportFile.cookie`：
  适配器把**本次响应捕获的 pugs**（代理回传 `x-pugs` 头）绑定到每个返回项。
- 导出 merger（curl/aria2/gopeed）按文件注入各自的 `Cookie: __pugs=...`，
  **不再使用全局 localStorage 值**（全局值仅用于弹窗展示捕获状态）。
- 顺序固化（single-link 示例日志验证）：**ls（获取资源列表）不需要 cookie**，
  游客态浏览即可；**解析（request command）才需要 cookie**，且与直链同响应对应。

---

## 2. CF（Cloudflare Pages）代理能力验证（2026-08-16 再跑一遍）

### 2.1 结论：游客态 cookie 可以传回，CF 代理通道成立

- 本地模拟 Pages 运行时（node 直接调 `functions/api/proxy.js`）+ 真实 UC API：
  **download 接口响应带 `set-cookie: __pugs`，代理提取后回传 `x-pugs` 头成功** ✅
- token / detail 接口只下发 `__sdid`，**只有 download 接口下发 `__pugs`** ——
  所以“代理捕获 pugs”必须发生在**解析（下载直链）请求**上，列表请求捕获不到。
- v1.1.2 部署版弹窗显示 pugs 为空的原因：**部署的 proxy.js 是旧版**
  （x-pugs 捕获代码当时未提交/未部署）—— 不是 CF 能力问题。

### 2.2 前提与风险（Tzz 关注点，记录）

1. **必须同域或跨域放行响应头**：SPA 在 GitHub Pages、代理在 pages.dev 时，
   CORS 需 `Access-Control-Expose-Headers: x-pugs`（已补进 proxy.js）。
2. **CF 免费额度 10 万请求/天**：只转发 API JSON（KB 级），直链下载仍由用户本地
   直连 OSS CDN（不经代理转发文件流）。但所有 API 请求都走 CF 边缘 IP，
   请求量大会触发 UC 的 IP 限制 —— 白嫖可行但要有节流/兜底。
3. **待真实部署验证**：UC 是否给 CF 边缘 IP 正常下发 __pugs、__pugs 是否绑 IP/UA
   （本地模拟同 IP，跨 IP 未测）。验证方法：部署后 curl 一次直链看是否 200。
4. **隐私**：cookie 不随请求上传（代理只捕获值，导出命令本地拼接），可接受。

---

## 3. 项目定位（Tzz 强调，务必记住）

- **nfd 云解析**主要做小飞机 / pikpak / 蓝奏 / 1rd 等，**不需要 cookie 即可请求 dl 接口**。
- **本项目的存在意义 = 支持更多网盘 + 方便国内用户使用**。如果做不到这一点，
  就没有做的必要 —— 一切取舍以此为准。
- 借鉴 linkswift 强大功能：**游客态读取目录树完全可行**（正常浏览就是这个逻辑），
  仅“解析”需要 cookie，且 cookie 必须与“下载直链”对应。

---

## 4. 方案评估（2026-08-16，Tzz 决策记录）

| 方案 | 状态/结论 |
|---|---|
| 浏览器书签注入（direct） | 书签注入的部分 JS **拿不到 cookie 回传 SPA**（依旧触发 CORS）；不推荐继续投入 |
| CF Pages 代理（proxy） | 游客态 cookie 可传回（§2 实测）；白嫖可行，但注意日限额 + IP 限制；继续观察 |
| 云服务器自建后端 | 有一定成本和隐私问题；**selfhost 或为最终方案**（局域网共享；穿透组网可能触发 IP 限制数据流甚至账号，不再建议） |
| 浏览器插件 | 拥有强大的管理页面（可读 cookie、跨域无限制），是开发者（进阶用户）的选择；v2.0 方向 |

**当前决策**：先按 §2 真实部署验证 CF 通道；若连游客态 cookie 都无法传回，
则 CF 代理无法继续白嫖，需要自己动手搭建后端（selfhost）。
