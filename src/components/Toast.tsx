/**
 * 轻量 Toast（全局提示，替代手写 DOM）
 * 用法：const { toast } = useToast(); toast('识别失败，请检查格式是否正确', 'error');
 */
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';

type ToastType = 'info' | 'success' | 'error';

interface ToastItem {
  id: number;
  msg: string;
  type: ToastType;
}

interface ToastApi {
  toast: (msg: string, type?: ToastType) => void;
}

const ToastCtx = createContext<ToastApi>({ toast: () => undefined });

export function useToast(): ToastApi {
  return useContext(ToastCtx);
}

let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (msg: string, type: ToastType = 'info') => {
      const id = ++seq;
      setItems((prev) => [...prev.slice(-3), { id, msg, type }]); // 最多同时 4 条
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), type === 'error' ? 3600 : 2400),
      );
    },
    [dismiss],
  );

  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      <div className="toast-wrap">
        {items.map((t) => (
          <div key={t.id} className={`toast toast--${t.type}`} onClick={() => dismiss(t.id)}>
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
