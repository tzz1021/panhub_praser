/**
 * 原生剪贴板封装（docs/STRUCTURE.md：src/utils/clipboard.ts）
 *
 * 直链是 OSS 签名 URL，字符敏感 —— 复制必须走原生剪贴板 API，
 * 禁止经 DOM 文本渲染层中转（可能被转义/截断，见 reverse-notes §3.3）。
 */
/** 复制文本；返回是否成功（navigator.clipboard 不可用时降级 execCommand） */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限/非安全上下文等 → 降级
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
