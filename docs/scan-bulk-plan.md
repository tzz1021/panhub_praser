# 扫描完整性 + 大宗目录过滤 —— v1.3.2 契约（2026-09-23 拍板）

> 术语：scanner = 获取资源列表（token + 目录树）；prase = 解析下载方式。两者已解耦。

## 0. 背景（为什么做）

- 现象：同一条 UC 分享直连 223 次调用 = 4.18 GiB，经本地转发（60/min 限频）209 次调用（149×429）= 1.12 GiB。
  调用数与进度条同步变小 → **结果不完整却看起来完整**。
- 机制：`core/treeWalker.ts` 的 `catch` 把失败目录记 `size=0` + `children=undefined`，失败目录不再递归，
  UI 零提示（0B 文件夹只有「转到此文件夹」按钮，无任何"失败"表达）。
- 结论：429 基本不是上游风控，而是**本站转发层自己限的**。先让失败可见 + 放宽本地限频，
  再谈深度（maxDepth）与大目录过滤。

## 1. 数据契约（已落地在 src/core/types.ts / src/core/preferences.ts，勿改名）

```ts
/** 扫描问题条目（两种语义严格分开，禁止共用 size=0 表达） */
export interface ScanIssue {
  path: string;                       // 目录路径（相对分享根；根为 "/"）
  fid: string;
  kind: 'failed' | 'bulk';            // failed = 加载失败；bulk = 大宗主动跳过
  code?: number | string;             // failed：供应商业务码（无则 'unknown'）
  message?: string;                   // failed：错误文案
  count?: number;                     // bulk：判定时已知的一级对象数
  threshold?: number;                 // bulk：判定时生效的阈值
}
```

- `TreeNode` 新增：`scanError?: { code: number | string; message: string }`、`bulkSkipped?: { count: number; threshold: number }`
  - 不变量：`scanError` 与 `bulkSkipped` 互斥（失败优先）；**两者存在时 `children` 一定为 `undefined`**。
  - 反例（必须避免）：仅靠 `children === undefined && size === 0` 判断——那是空目录/失败/大宗三种情况的混合。
- `ListSnapshot` 新增：`issues: ScanIssue[]`（空数组 = 全部加载成功且无大宗跳过）
- `TreeWalkOptions` 新增：`bulkThreshold?: number`（0/缺省 = 关闭）
- `ListFetchOptions` 新增：`bulkThreshold?: number`（透传给 buildTree）
- `Preferences` 新增：`bulkThreshold: number`（默认 100，0 = 关闭；**改动后下次获取资源列表生效**）
- 失败目录也要写进**全局日志**（`addGlobalLog`）：`scanner：目录 ${path} 未加载成功（业务码 ${code}）：${message}`

## 2. 遍历行为（core/treeWalker.ts，CORE 负责）

### 2.1 失败可见
单个目录 list 失败（适配器抛错，如 `UcApiError.code` / HTTP 码 / 网络失败）时：
- `node.scanError = { code: extractCode(err), message: err.message }`，`node.size = 0`，`node.children = undefined`
- `issues.push({ path, fid, kind: 'failed', code, message })`
- 仍不中断整体遍历（容错语义不变）
- `extractCode`：`typeof err?.code === 'number' || typeof err?.code === 'string'` 时用它，否则 `'unknown'`

### 2.2 大宗判定（只看**一级对象数**）
- 阈值取自 `options.bulkThreshold`（0 = 关闭，直接跳过本机制）
- **快通道（uc/quark 等自带 `total` 的网盘）**：一级 list 返回 `ListResult.total` 存在且 `> 阈值`
  → 立刻判定大宗：**不再继续翻页、不递归**，`node.bulkSkipped = { count: total, threshold }`，
  `node.size = 0`，`node.children = undefined`，`issues.push({ kind:'bulk', count: total, threshold })`
- **慢通道（alipan/xunlei 等无 total 的网盘）**：按老逻辑收齐一级响应体 → 用 `files.length` 与阈值比较，
  超过则同上（这条通道必须先把一级响应体全部取出才能计数，省的是**下一层**递归）
- 未超阈值 → 行为与 1.3.1 完全一致（正常递归 + 大小聚合）
- 大目录一旦判定，整目录保持折叠（不展开、不递归），用户可用「转到此文件夹」单独扫描

## 3. UI 行为（UI 负责，文件清单见 §5）

### 3.1 结果页 banner（ResultPage）
- 触发：本次 scan 的 `issues.length > 0`（或存在 failed）
- 文案（要点必须齐全，可微调措辞）：
  - 「已放宽本地转发限制（120 次/分/IP）：若大量文件夹出现业务码非 200，多半是本站转发层限频，不是上游风控。」
  - 「请打开浏览器 devtools → Network，找到 scan 响应体确认业务码。」
  - 「隐私：总部后端**不记录目录树**，只做限频。」
  - 「有大宗目录树查看需求请自建转发代理；scan 完毕后切回原有后端不影响使用（总部公共账号池不受影响）。」
- 明细行：`N 个目录未加载成功（业务码 xxx、yyy…），结果不完整` + `M 个大宗目录已跳过（阈值 100）`
- 「不再弹出」按钮：勾选后不再显示（localStorage 本地记忆即可，写进偏好文件也行但要能"不再弹"）
  —— 注意：这是"宽松提示"，不是错误；失败目录的行内提示不因它消失

### 3.2 目录行（DirectoryTree）
- **判据换掉**：不再用 `children === undefined && node.size === 0` 判 0B 文件夹
  - failed：`node.scanError` 存在 → 行内文本 `请求业务码 ${code}，内容不完整`（`--danger` 色）
  - bulk：`node.bulkSkipped` 存在 → 行内文本 `大宗目录（${count} 项 > 阈值 ${threshold}），未展开`
- 两种情况都把「转到此文件夹」作为该行的**主操作按钮**（此前的 0B 按钮位）——它是唯一入口，
  不做「一键重试」（反复造轮子，拍板明确否掉）
- 标题/提示语带上语义：失败 = 上游/转发失败可重扫；大宗 = 主动跳过可单独扫

### 3.3 设置项（DefaultMode，紧跟「扫描深度」下方）
- 新增「大宗文件判定」：标签文案「该目录下一级对象数量超过」+ 数字输入（默认 100）
- 副标题：「超过则不展开该目录（保持折叠，可用『转到此文件夹』单独查看）；0 = 关闭；改动后下次获取资源列表生效」
- 「扫描深度」副标题补语义：「0 = 不限；1 = 只列根层（`depth < maxDepth`，根 = 0）；
  jumper（转到此文件夹）二次获取时深度从 0 重算」

### 3.4 maxDepth 接线（拍板项 2，达成一致）
- `fetchListSnapshot` 三处调用（HomePage ×2、ResultPage `refreshList`）都要传 `maxDepth: prefs.scanDepth`
- 预览/缓存复用路径行为不变；jumper 路径深度从 0 重算（已在文案说明）

## 4. 代理层（主线程负责，已改）

- `functions/api/_shared/proxy-core.js`：`RATE_LIMIT_PER_MIN` 60 → **120**（宽松优先；被抱怨就请自建后端）
- 同一文件：`operation === 'scan'` 时 `body_preview` 置空且不落 `file_hits`（兑现 banner 的隐私承诺）
- `backend/src/proxy.js`（自建/本地）：保留原有 trace 语义（是用户自己的机器），只同步文档口径

## 5. 文件归属（避免并行冲突）

| 归属 | 文件 |
|---|---|
| CORE | `src/core/treeWalker.ts`、`src/core/listFetcher.ts`（`ListFetchOptions.bulkThreshold` + issues 回填） |
| UI | `src/pages/ResultPage.tsx`、`src/pages/HomePage.tsx`、`src/components/DirectoryTree.tsx`、`src/components/settings/DefaultMode.tsx` |
| 主线程（已完成） | `src/core/types.ts`、`src/core/preferences.ts`、`functions/api/_shared/proxy-core.js`、本文件、changelog/docs |

**已完成（勿重复改）**：types.ts 新字段、preferences.ts 默认值、proxy-core 限频与 scan 隐私。

## 6. 验证要求（各自跑，主线程复核）

- `npx tsc --noEmit` 0 错（两方都改完后由主线程再跑一次）
- CORE：`node`/`tsx` 脚本用 **stub adapter**（列表返回可控 total / 抛带 code 的错 / 无 total 的慢通道）
  断言：① 失败目录 `scanError.code` 正确 ② 快通道 total>阈值不翻页 ③ 慢通道收齐后判 bulk
  ④ 未超阈值行为与 1.3.1 一致 ⑤ `issues` 条数与内容
- UI：`npm run build` 通过；有 chromium 时可用 CDP 截图/断言（`/usr/local/bin/chromium`，无 playwright）
- 常驻约束：不改 `main.py` 类无关文件；**不 commit、不 push**；中文注释，改动最小化；test 残留清理

## 7. 已知遗留（本轮不做，勿扩范围）

- `detail(scan)` 不返回 md5，只有 download 给（tasks 导出能带上就带上，已具备）
- launcher.ps1 无语法错误（Tzz 已看过，本地无 pwsh 环境）
- historypage 重新解析若不能复用目录树 → 先跳转 homepage（现状即可）
