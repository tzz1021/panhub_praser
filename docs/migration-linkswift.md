# 从 LinkSwift 迁移说明（migration-linkswift）

> 首次提交时记录：panhub_praser 的哪些能力迁移自开源项目 LinkSwift，尊重版权。
> LinkSwift: https://github.com/hmjz100/LinkSwift （GPL 系开源，作者 Hmjz100、油小猴）

## 版权声明

panhub_praser 的**核心解析能力**（UC 网盘 API 调用方式）参考了 LinkSwift 的逆向成果，
包括但不限于：API 端点与参数、`entry=ft&fr=pc&pr=UCBrowser` 关键参数、批量节流策略（15 个/批 + 1s）、
下载 UA。本项目基于这些思路**重新实现**，未复制 LinkSwift 源码；UI 布局参考 pdpb.cn（另行致谢）。
panhub_praser 以 GPLv3 开源（见 LICENSE），与上游许可精神一致：修改与再分发保持开源。

## 迁移对照

| 能力 | LinkSwift 实现 | panhub_praser 实现 | 差异 |
|---|---|---|---|
| 执行环境 | 油猴脚本（注入网盘页） | 书签注入（同源，免脚本管理器） | 同源策略一致，载体不同 |
| getLink URL | `file/download?entry=ft&fr=pc&pr=UCBrowser` | 相同（reverse-notes 已验证） | 无 |
| 文件列表 | React props 读取页面状态 | API 直取（detail 接口） | 更稳，不依赖页面结构 |
| 批量节流 | 15 个/批 + 1s | 相同（core/linkFetcher） | 无 |
| 目录遍历 | 不支持（仅当前页） | 支持（pdir_fid 递归） | **本项目的差异化能力** |
| UA | uc-cloud-drive 客户端 UA | 相同（tasks/curl 导出） | 无 |
| 下载层 | 依赖用户已登录 | 游客可下载大文件（实测） | 平台策略变化，已实测 |

## 未迁移部分（刻意不做）

- LinkSwift 的多网盘全部逻辑：panhub_praser 按适配器接口逐盘接入（v1 仅 UC）
- 网页版"保存到网盘"等转存交互：本项目定位为解析+导出，不做转存
- 任何付费/会员功能：本项目完全开源免费

## 致谢

感谢 LinkSwift 作者与社区的逆向工作。若本项目的实现细节与上游存在认知差异，
以本仓库 docs/reverse-notes-uc.md 的实测结论为准。
