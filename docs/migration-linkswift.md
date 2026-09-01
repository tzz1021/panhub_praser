# 从 LinkSwift 迁移说明（migration-linkswift）

> 首次提交时记录：panhub_praser 的哪些能力迁移自开源项目 LinkSwift，尊重版权。
> LinkSwift: https://github.com/hmjz100/LinkSwift 
## 版权声明

panhub_praser 的**核心解析能力**（网盘 API 调用方式）参考了 LinkSwift 的逆向成果，
包括但不限于：API 端点与参数、批量节流策略（15 个/批 + 1s）、
下载 UA。本项目基于这些思路**重新实现**，未复制 LinkSwift 源码；UI 布局参考 pdpb.cn（另行致谢）。
panhub_praser 以 GPLv3 开源（见 LICENSE），与上游许可精神一致：修改与再分发保持开源。

## 迁移对照

| 能力          | LinkSwift 实现                                | panhub_praser 实现      | 差异            |
| ----------- | ------------------------------------------- | --------------------- | ------------- |
| 执行环境        | 油猴脚本（注入网盘页）                                 | 书签注入（同源，免脚本管理器）       | 同源策略一致，载体不同   |
| getLink URL | `file/download?entry=ft&fr=pc&pr=UCBrowser` | 相同（reverse-notes 已验证） | 无             |
| 文件列表        | React props 读取页面状态                          | API 直取（detail 接口）     | 更稳，不依赖页面结构    |
| 批量节流        | 15 个/批 + 1s                                 | 相同（core/linkFetcher）  | 无             |
| 目录遍历        | 不支持（仅当前页）                                   | 支持（pdir_fid 递归）       | **本项目的差异化能力** |
| UA          | uc-cloud-drive 客户端 UA                       | 相同（tasks/curl 导出）     | 无             |
| 下载层         | 部分依赖用户已登录                                   | 相同                    | 平台策略变化，已实测    |

## 1.2.（next）2更新

上面是初次适配阶段(UC)的表述，这次加入完整的后端设计，功能上完美支持quark，此后多种平台都会陆续得到适配，这些都会借鉴linkswift的已有成果

## 致谢

感谢 LinkSwift 作者与社区的逆向工作。若本项目的实现细节与上游存在认知差异，
以本仓库 docs/reverse-notes-uc.md 的实测结论为准。
（由于初次AI自作主张，UC网盘没有完全与linkswift保持一致还请见谅）
**日后适配工作将会最大可能复用，并在此基础上人工试探改进措施**