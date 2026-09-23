/**
 * 主题灯泡（v1.3.1：夜间模式）
 *
 * 形态：顶栏一个灯泡按钮，单击三态轮换 —— 跟随系统 → 浅色 → 深色 → 跟随系统（可循环）。
 * 挂在 SiteHeader（所有页面共享同一个 header，因此所有 page 都有灯泡）。
 *
 * 职责边界（不重写偏好存储层）：
 * - 读写走 core/preferences 现有 API（getPreferences / setPreferences / subscribePreferences），
 *   存储键仍是 'pan-web:prefs:v1'，未新增存储键；
 * - 应用方式：把「最终生效值」写到 <html data-theme="light|dark">（auto 时按系统解析），
 *   并监听 matchMedia('(prefers-color-scheme: dark)') 的 change 实时跟随；
 *   原始三态另存 <html data-theme-pref>，便于调试/断言。
 */
import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { getPreferences, setPreferences, subscribePreferences } from '../core/preferences';
import type { ThemePref } from '../core/types';

/** 单击轮换顺序（可循环）：跟随系统 → 浅色 → 深色 → 跟随系统 */
export const THEME_ORDER: ThemePref[] = ['auto', 'light', 'dark'];

/** 三态显示名（title 提示用） */
const THEME_LABEL: Record<ThemePref, string> = { auto: '跟随系统', light: '浅色', dark: '深色' };

/** 三态图标（auto=🌗 light=☀️ dark=🌙） */
const THEME_ICON: Record<ThemePref, string> = { auto: '🌗', light: '☀️', dark: '🌙' };

/** 系统深色偏好查询（无 matchMedia 环境返回 null = 按浅色处理） */
function systemDarkQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null;
  }
  return window.matchMedia('(prefers-color-scheme: dark)');
}

/** 解析最终生效主题：auto → 系统；其余原样 */
export function resolveTheme(theme: ThemePref): 'light' | 'dark' {
  if (theme !== 'auto') {
    return theme;
  }
  return systemDarkQuery()?.matches ? 'dark' : 'light';
}

/**
 * 应用主题到 <html>：data-theme 写最终生效值（auto 也解析为 light/dark，便于断言/调试），
 * data-theme-pref 保留原始三态。返回最终生效值。
 */
export function applyTheme(theme: ThemePref): 'light' | 'dark' {
  const resolved = resolveTheme(theme);
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePref = theme;
  }
  return resolved;
}

// 模块加载即应用一次：早于 React 首次渲染，深色用户不会先闪一帧白底
if (typeof document !== 'undefined') {
  applyTheme(getPreferences().theme);
}

/** 顶栏灯泡按钮（三态轮换，单击即存偏好） */
export function ThemeToggle(): JSX.Element {
  const [theme, setTheme] = useState<ThemePref>(() => getPreferences().theme);

  // 偏好被别处改动（设置面板 / 其它标签页 storage 事件）时跟随
  useEffect(() => subscribePreferences(() => setTheme(getPreferences().theme)), []);

  // 应用主题；auto 时监听系统主题变化实时跟随
  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'auto') {
      return;
    }
    const mq = systemDarkQuery();
    if (!mq) {
      return;
    }
    const onChange = (): void => {
      applyTheme(theme);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  /** 单击轮换：auto → light → dark → auto（循环） */
  const cycle = (): void => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    setTheme(next); // 立即生效（setPreferences 的订阅回调同样会同步一次）
    setPreferences({ theme: next });
  };

  const label = THEME_LABEL[theme];
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm theme-toggle"
      onClick={cycle}
      title={`主题：${label}（单击切换：跟随系统 → 浅色 → 深色）`}
      aria-label={`主题：${label}，单击切换`}
      data-theme-pref={theme}
    >
      <span className="theme-toggle-icon" aria-hidden="true">
        {THEME_ICON[theme]}
      </span>
    </button>
  );
}
