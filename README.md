# panhub_praser 🔧

> 网盘分享链接 → 目录树 → 批量直链 → 一键导出到 aria2 / Gopeed / cURL。
> 免安装、零上传、开源免费。把分享页变成你自己的下载器。

## 一句话定位

把「装油猴脚本」变成「拖一个书签、打开分享页点一下」——服务担心脚本安全、嫌麻烦、偶尔使用的普通玩家。

## 零上传承诺

- **无后端、无数据库**：纯前端静态站，GitHub 托管
- **足迹全在本地**：历史链接 / 目录树快照 / 解析记录 / 日志只写入浏览器 IndexedDB，从未离开你的设备
- **不读你的 Cookie**：v1 UC 适配器 API 零 Cookie（隐私友好）；日志导出自动对凭据做删除线脱敏
- **无任何埋点统计**

## 快速开始

1. 打开任意 UC 网盘分享页（如 `https://drive.uc.cn/s/xxxx`）
2. 把下面的按钮拖到书签栏：
   ```text
   （书签产物：build 后见 public/bookmarklet.min.js 安装说明）
   ```
3. 在分享页点书签 → 自动解析目录树 → 勾选文件 → 批量取直链
4. 导出 aria2 / Gopeed 任务（可保留目录结构）或 cURL 命令，本地下载器接管

> 也可以在首页直接粘贴分享链接解析（需在网盘域内执行以绕过 CORS，详见 docs/reverse-notes-uc.md §3.2）。

## 功能

- 输入分享链接或整段分享文案（自动提取 URL 与提取码），自动识别网盘并高亮
- 目录树遍历（递归、并发 3、目录大小聚合、失败容错），支持 |--- / 缩进两种格式
- 批量直链：15 个/批 + 1s 节流（LinkSwift 同款），失败可单独重试
- 直链有效期倒计时（OSS Expires 解析），过期一键重新获取
- 导出：aria2 命令 / input-file（保留目录结构）/ RPC JSON、Gopeed 任务 JSON、cURL 命令、浏览器直下
- 连接本地下载器：配置 RPC 地址 / 密钥 / 保存路径（v1 仅存配置）
- 足迹系统（仅本地）：已填链接查重、目录树快照、解析记录、完整日志（5MB 轮转 + 脱敏）
- 偏好设置：UAC 表（转存/登录/限速）、默认解析方式、目录树样式、足迹保留策略

## 技术栈

React 19 + TypeScript strict + Vite，零运行时依赖（无状态库/无 UI 库，手写设计系统）。

## Wiki · 自托管与代理指南

被 CORS 拦了？不想用书签？给懂技术的人准备的免费代理部署指南：

- [入口/方案对比](docs/wiki.md)（Cloudflare 白嫖 vs 自建服务端）
- [白嫖 Cloudflare（10 分钟，10 万请求/天）](docs/wiki-cloudflare.md)
- [自建服务端代理（Node 零依赖，数据全自持）](docs/wiki-selfhost.md)

## 参考与致谢

- 核心功能参考开源项目 [LinkSwift](https://github.com/hmjz100/LinkSwift)（API 三连、entry 参数、节流策略）
- UI 部分参考 [pdpb.cn](https://pdpb.cn)（布局与配色）
- 功能方向参考 [nfd 云解析](https://github.com/qaiu/netdisk-fast-download)（自托管思路）
- 版权与迁移说明见 [docs/migration-linkswift.md](docs/migration-linkswift.md)

## License

[GPLv3](LICENSE) —— 完全开源免费，如果通过付费渠道获取到，请立即申请退款并差评。
