# AI 协作规范（ai-usage）

> 本项目如何被 AI 维护。所有接手本仓库的 AI（以及人类）请先读这里。
> 配套：STRUCTURE.md（目录结构）、HANDOFF.md（新会话启动包）、reverse-notes-uc.md（UC 逆向事实）。

## 铁律

1. **能增不改，能改不删**（Tzz 偏好）：新增能力优先加文件/加函数，不重构不删旧接口
2. **先读后写**：改任何模块前先读它的文件头注释和 docs/STRUCTURE.md 对应章节
3. **core/ 零网盘依赖**：treeWalker/linkFetcher/errors 只操作 PanAdapter 抽象，禁止 import 具体适配器
4. **UI 永不直接 import 适配器**：只走 `registry.detectShareUrl()` + PanAdapter 接口
5. **逆向事实不可臆改**：UC API 的 entry 参数、响应字段、错误码以 reverse-notes-uc.md 为准；改动前先看笔记，笔记错了改笔记再改代码
6. **真机验证**：任何 UI/适配层改动必须跑 headless E2E（见下），typecheck 查不出的运行时 bug（如 TDZ、CORS）只有真机能暴露

## 技术约束

- TypeScript strict（noUnusedLocals/noUnusedParameters 已开），`npm run typecheck` 必须零错误
- 零运行时依赖：只用 react/react-dom + 手写 CSS；不得引入状态库/UI 库/请求库/idb
- kebab-case 文件名、PascalCase 组件、camelCase 变量、中文注释
- 直链是 OSS 签名 URL，字符敏感：复制必须走 utils/clipboard 原生 API，禁止 DOM 文本中转
- 日志禁止明文凭据：任何 cookie/token 形态必须过 footprint/logs 的 redactSensitive

## 开发顺序（新功能参考）

骨架 → 适配器 → core → footprint → tasks → UI → bookmarklet → 文档
（详见 HANDOFF.md §5；子任务可 sessions_spawn 并行，主 agent 先定共享契约）

## 验证姿势

```bash
npm run typecheck          # 类型零错误
npm run build              # 产物 <250KB
# headless E2E（真实 UC 分享）：
npm run preview -- --port 4173
chromium --headless=new --disable-web-security --user-data-dir=/tmp/e2e-profile \
  --remote-debugging-port=9225 about:blank
node /tmp/uc_e2e.mjs       # CDP 驱动：粘贴链接 → 识别 → 目录树 → 勾选 → 批量直链
```

注意：
- 本机 Node 26 只有 strip-types（不支持参数属性等 transform 语法），跑 TS 冒烟用 esbuild bundle 后再执行
- `--disable-web-security` 只用于测试 CORS 之外的应用逻辑；生产环境靠书签同源注入（CORS 白名单只放行 drive.uc.cn）
- CSP 冒烟：`node scripts/csp-smoke.mjs`（结论：无 CSP，注入路径可行）

## 提交规范

- 中文提交信息，格式：`panhub_praser: <改动摘要>（<验证方式>）`
- 不提交：node_modules/、dist/、个人 memory 文件、凭据
- /his/ 目录为历史归档（YYYYMMDD_HHMMSS_ 前缀），只读索引，不参与代码评审
