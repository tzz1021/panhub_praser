/**
 * 登录态 cookie 填写/导入弹窗（docs/STRUCTURE.md：src/components/CookieInputModal.tsx）
 *
 * v1.1.9：夸克 >50MB 大文件强制登录（23018 size limit）时弹出，
 * 让用户**手动填写/导入**登录态 cookie（sdid/up/wk），随 download API 请求发送。
 * 与 CookieWarnModal 的区别：那是展示自动捕获的游客态凭据；这是填登录态凭据。
 *
 * 内容（按 Tzz 弹窗规范）：
 * - 供应商名 + 「下面是本次获取到的必要 cookie 值」+ 各键填写框（如实展示）
 * - 懒人导入：选择文件（Netscape）/ 粘贴文本自动识别（Netscape / JSON / Header string）
 * - 红色圆点：登录态 cookie 风险提示（公用代理自担账号安全）
 * - 插件推荐：get cookies.txt locally（chrome/edge/safari）+ 本机插件模式 / 自建代理
 * - 自建代理不显示时排查话术（账号状态 + 代理面板登录态）
 */
import { useRef, useState } from 'react';
import type { JSX } from 'react';
import type { CookieInputRequirement } from '../adapters/types';
import {
  parseCookieText,
  buildQuarkCookieString,
  quarkCookieKeysPresent,
} from '../adapters/quark/cookies';

export interface CookieInputModalProps {
  /** 网盘名称（如 "夸克网盘"） */
  panName: string;
  /** 登录态 cookie 输入规格（adapter.cookieInput） */
  cookieInput: CookieInputRequirement;
  /** 已保存的整串 cookie（wholeString 模式）或 key→value 映射（多键模式） */
  value: string | Record<string, string>;
  /** 保存：wholeString 模式给整串；多键模式给映射 */
  onSave: (value: string | Record<string, string>) => void;
  onCancel: () => void;
}

/** 插件商店链接（get cookies.txt LOCALLY，社区常用导出插件） */
const PLUGIN_LINKS: Array<{ label: string; href: string; note?: string }> = [
  {
    label: 'chrome',
    href: 'https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc',
  },
  {
    label: 'edge',
    href: 'https://microsoftedge.microsoft.com/addons/search/get%20cookiestxt%20locally',
  },
  {
    label: 'safari',
    href: 'https://github.com/kairi003/Get-cookies.txt-LOCALLY',
    note: '（Safari 无商店版，用 GitHub 版或手动复制）',
  },
];

/** 红色圆点行（登录态风险 / 自建代理排查） */
function RedDot({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <p style={{ margin: '6px 0 0', fontSize: 12.5, color: 'var(--text)' }}>
      <span style={{ color: '#dc3545' }}>●</span> {children}
    </p>
  );
}

export function CookieInputModal({ panName, cookieInput, value, onSave, onCancel }: CookieInputModalProps): JSX.Element {
  const wholeString = Boolean(cookieInput.wholeString);
  const initialStr = typeof value === 'string' ? value : '';
  const [fieldStr, setFieldStr] = useState(initialStr);
  const [fields, setFields] = useState<Record<string, string>>(() =>
    typeof value === 'string' ? {} : { ...value },
  );
  const [pasteText, setPasteText] = useState('');
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /** 把解析结果填进输入（整串模式直接替换；多键模式按声明键合并） */
  const applyParsed = (parsed: Record<string, string>): void => {
    if (wholeString) {
      setFieldStr(buildQuarkCookieString(parsed));
      const found = quarkCookieKeysPresent(buildQuarkCookieString(parsed));
      setImportMsg(
        found.length > 0
          ? { ok: true, text: `识别到登录态 key：${found.join(' / ')}，已填入` }
          : { ok: false, text: '未识别到关键登录 key（__pus 等），请检查导出内容' },
      );
      return;
    }
    const next = { ...fields };
    let hit = 0;
    for (const { key } of cookieInput.keys) {
      if (parsed[key]) {
        next[key] = parsed[key];
        hit++;
      }
    }
    setFields(next);
    setImportMsg(
      hit > 0
        ? { ok: true, text: `识别到 ${hit} 个必要 cookie（${cookieInput.keys.map((k) => k.key).join('/')}），已自动填入` }
        : { ok: false, text: '未识别到必要 cookie 键，请检查导出的内容（如使用了提取码页的 cookie）' },
    );
  };

  /** 粘贴文本自动识别（Netscape / JSON / Header string 懒人导入） */
  const handlePasteImport = (): void => {
    try {
      applyParsed(parseCookieText(pasteText));
    } catch (err) {
      setImportMsg({ ok: false, text: err instanceof Error ? err.message : '解析失败' });
    }
  };

  /** 选择文件导入（.txt / .json，Netscape 导出文件最常见） */
  const handleFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      const text = await file.text();
      setPasteText(text);
      applyParsed(parseCookieText(text));
    } catch (err) {
      setImportMsg({ ok: false, text: err instanceof Error ? err.message : '文件读取失败' });
    }
  };

  /** 保存：整串模式提交整串（去空白）；多键模式提交声明键映射（去空白值） */
  const save = (): void => {
    if (wholeString) {
      onSave(fieldStr.trim());
      return;
    }
    const out: Record<string, string> = {};
    for (const { key } of cookieInput.keys) {
      const v = fields[key]?.trim();
      if (v) out[key] = v;
    }
    onSave(out);
  };

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="modal-head">
          <h3 className="modal-title">cookie 登录态鉴权</h3>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, color: 'var(--text-dim)' }}>
            <strong>{panName}</strong> 需要 cookie 鉴权，下面是本次获取到的必要 cookie 值 【如实显示】：
          </p>

          {/* 整串模式：单个大输入框（粘贴完整 cookie，最稳）；多键模式：各 key 填写框 */}
          {wholeString ? (
            <div style={{ margin: '10px 0' }}>
              <textarea
                value={fieldStr}
                onChange={(e) => setFieldStr(e.target.value)}
                placeholder={'粘贴完整 cookie 字符串（含 __pus 等；\n从已登录浏览器复制，或用下方导入）'}
                rows={4}
                style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, boxSizing: 'border-box' }}
              />
              {(() => {
                const found = quarkCookieKeysPresent(fieldStr);
                return found.length > 0 ? (
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-dim)' }}>
                    已检测到登录态 key：{found.join(' / ')}
                    {!found.includes('__pus') && '（缺少 __pus，可能无法解锁大文件）'}
                  </p>
                ) : (
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-faint)' }}>
                    未检测到 __pus —— 登录态 cookie 通常长这样：__pus=xxxx; __uid=xxxx
                  </p>
                );
              })()}
            </div>
          ) : (
            <div style={{ margin: '10px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {cookieInput.keys.map(({ key, label }) => (
                <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <code style={{ width: 56, flexShrink: 0, textAlign: 'right', userSelect: 'all' }}>{label}=</code>
                  <input
                    type="text"
                    value={fields[key] ?? ''}
                    onChange={(e) => setFields((prev) => ({ ...prev, [key]: e.target.value }))}
                    placeholder={`填写 ${key} 的值（从已登录浏览器复制）`}
                    style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
                  />
                </label>
              ))}
            </div>
          )}

          {/* 懒人导入 */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.json,text/plain,application/json"
              style={{ display: 'none' }}
              onChange={(e) => void handleFile(e.target.files?.[0])}
            />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}>
              选择文件
            </button>
            <input
              type="text"
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder="或粘贴 cookie（Netscape / JSON / Header 任意格式）"
              style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
            />
            <button type="button" className="btn btn-ghost btn-sm" onClick={handlePasteImport}>
              识别导入
            </button>
          </div>
          {importMsg && (
            <p style={{ margin: 0, fontSize: 12, color: importMsg.ok ? 'var(--text-dim)' : '#dc3545' }}>
              {importMsg.text}
            </p>
          )}

          <div style={{ marginTop: 10, borderTop: '1px solid var(--border, #e5e7eb)', paddingTop: 8 }}>
            <RedDot>{cookieInput.notice ?? '以上选项属于登录态的 cookie'}</RedDot>
            <RedDot>
              推荐使用插件 get cookies.txt locally 获取
              {PLUGIN_LINKS.map((l) => (
                <span key={l.label}>
                  {' '}
                  <a href={l.href} target="_blank" rel="noreferrer">
                    {l.label}
                  </a>
                  {l.note ?? ''}
                </span>
              ))}
            </RedDot>
            <RedDot>
              更推荐：使用本机插件模式（跳转到仓库 dev 分支）或者自建转发代理（跳转到 selfhost 的 wiki）
            </RedDot>
            <RedDot>
              {cookieInput.missingHint ?? '如果你在使用自建代理却没有显示，请检查和账号状态和自建代理面板登录状态否正常，其他问题参阅文档'}
            </RedDot>
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            算了吧
          </button>
          <button type="button" className="btn btn-primary" onClick={save}>
            保存并重试
          </button>
        </div>
      </div>
    </div>
  );
}
