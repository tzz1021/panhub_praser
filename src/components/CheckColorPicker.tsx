/**
 * 勾选行底色调色盘（v1.3.1：结果页资源列表树面板的小 🎨 按钮）
 *
 * 面板内容：预设色板（8 色）+「默认」+「清除」。
 * 交互：选中即生效（父级更新 --check-bg）并持久化（setPreferences({ checkColor })）。
 * 冲突优先级：status 红/黄/绿始终优先于自定义勾选底色（见 index.css 的 .file-row--* 段）。
 */
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { setPreferences } from '../core/preferences';

/** 预设色板（浅/深两色主题下都能与文字形成对比；红/黄/绿状态行的颜色不在此列，避免与 status 语义撞色） */
export const CHECK_COLORS: Array<{ value: string; label: string }> = [
  { value: '#bbf7d0', label: '薄荷绿' },
  { value: '#bfdbfe', label: '天蓝' },
  { value: '#a5f3fc', label: '青碧' },
  { value: '#e9d5ff', label: '薰衣草' },
  { value: '#fbcfe8', label: '樱粉' },
  { value: '#ffedd5', label: '暖桔' },
  { value: '#d9f99d', label: '嫩芽' },
  { value: '#c7d2fe', label: '靛蓝' },
];

export interface CheckColorPickerProps {
  /** 当前偏好值（'' = 主题默认高亮） */
  value: string;
  /** 选中回调（父级负责立即生效；本组件负责持久化） */
  onChange: (color: string) => void;
}

/** 小调色盘按钮 + 弹出色板 */
export function CheckColorPicker({ value, onChange }: CheckColorPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  // 点面板外部 / 按 Esc 关闭
  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /** 选中：父级立即生效 + 写入偏好（'' = 默认/清除） */
  const pick = (color: string): void => {
    onChange(color);
    setPreferences({ checkColor: color });
    setOpen(false);
  };

  return (
    <span className="check-color-picker" ref={wrapRef}>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => setOpen((o) => !o)}
        title="勾选行底色（自定义打对钩行的背景色；红/黄/绿状态行优先显示状态色）"
        aria-label="勾选行底色"
        aria-expanded={open}
        data-check-color={value}
      >
        🎨
      </button>
      {open && (
        <div className="check-color-panel" role="dialog" aria-label="勾选行底色">
          <div className="check-color-title">勾选行底色</div>
          <div className="check-color-grid">
            {CHECK_COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                className={`check-color-swatch${value === c.value ? ' check-color-swatch--active' : ''}`}
                style={{ background: c.value }}
                onClick={() => pick(c.value)}
                title={c.label}
                aria-label={c.label}
                data-color={c.value}
              />
            ))}
          </div>
          <div className="check-color-actions">
            <button
              type="button"
              className={`btn btn-ghost btn-sm${value === '' ? ' check-color-default--active' : ''}`}
              onClick={() => pick('')}
              title="使用主题默认高亮色"
              data-color="default"
            >
              默认
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => pick('')}
              title="清除自定义底色（回到主题默认高亮）"
              data-color="clear"
            >
              清除
            </button>
          </div>
          <div className="field-hint" style={{ fontSize: 11.5 }}>
            红/黄/绿状态行优先显示状态色
          </div>
        </div>
      )}
    </span>
  );
}
