/**
 * 开发页（docs/STRUCTURE.md：src/pages/DevPage.tsx）
 * /#/dev：面向开发者的 changelog / ai-usage 入口。
 */
import type { JSX } from 'react';

export function DevPage(): JSX.Element {
  return (
    <div className="card">
      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 className="card-title" style={{ margin: 0 }}>
          🛠 开发者页
        </h2>
        <p style={{ margin: 0, color: 'var(--text-dim)' }}>
          面向开发者的文档（提交后随仓库可见）：
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <a className="link" href="./docs/changelog.md" target="_blank" rel="noreferrer">
            📄 docs/changelog.md — 变更日志
          </a>
          <a className="link" href="./docs/ai-usage.md" target="_blank" rel="noreferrer">
            🤖 docs/ai-usage.md — AI 协作规范
          </a>
          <a className="link" href="./docs/reverse-notes-uc.md" target="_blank" rel="noreferrer">
            🔍 docs/reverse-notes-uc.md — UC 逆向笔记
          </a>
        </div>
        <p className="field-hint" style={{ margin: 0 }}>
          页面状态：v1.0 UI 骨架 — 输入 → 目录树 → 勾选 → 批量直链 → 导出。
        </p>
      </div>
    </div>
  );
}
