/**
 * React 入口（docs/STRUCTURE.md：src/main.tsx）
 * 挂载 App + 全局错误边界。
 */
import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { logServiceStart } from './core/footprint/globalLog';
import './index.css';

/** 全局错误边界：渲染期异常兜底，不白屏 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error | null } {
    return { error };
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div role="alert" style={{ padding: '2rem', fontFamily: 'monospace' }}>
          <h1>出错了</h1>
          <pre>{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('挂载点 #root 不存在');
}

// 全局日志：记录服务启动（含上次启动时间，开发调试用）
logServiceStart();

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
