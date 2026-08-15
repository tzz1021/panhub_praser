/**
 * 传输层抽象（1.1 核心：docs/transport.md）
 *
 * 现状：adapter 直接 fetch 网盘 API，非 drive.uc.cn 域直连被 CORS 白名单拦死。
 * 1.1 目标：把"浏览器直连"变成可切换的传输方式，UI/adapter 逻辑零改动。
 *
 * 三种传输（对应三种用户方案，见 docs/transport.md）：
 * - direct：浏览器直连（现状，受 CORS 限制；书签注入=同源直连，同一实现）
 * - proxy：用户配置的 API 转发代理（CF Pages Function / Worker / 家庭内网），
 *   代理在服务端转发请求，天然无 CORS；直链下载仍走 OSS CDN，代理只过 JSON 小流量
 * - plugin：浏览器扩展桥（v2.0，不做）；扩展请求不受页面 CORS 限制，可读 cookie
 *
 * 约束：core/ 零网盘依赖 —— 本层只认识 HTTP，不认识任何网盘。
 */

/** 结构化网络错误（替代现在 adapter 里"猜 message 含 CORS"的方式） */
export class TransportError extends Error {
  /** cors：被浏览器 CORS 拦截（direct 下才会发生） */
  readonly kind: 'cors' | 'network' | 'http' | 'invalid';
  /** HTTP 状态码（http 类才有） */
  readonly status?: number;

  constructor(kind: TransportError['kind'], message: string, status?: number) {
    super(message);
    this.name = 'TransportError';
    this.kind = kind;
    this.status = status;
  }
}

/** 传输层请求（adapter 用） */
export interface TransportRequest {
  /** 完整目标 URL（含 query，原样透传） */
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** 请求头（Content-Type 等；Cookie 类凭据禁止进 proxy，见 docs/transport.md） */
  headers?: Record<string, string>;
  /** 请求体（JSON 字符串；GET 不带） */
  body?: string;
}

/** 传输层响应（统一为文本，由 adapter 自行 JSON.parse） */
export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  /** 原始响应文本（非 JSON 也原样给） */
  body: string;
}

/** 传输实现（direct / proxy / plugin） */
export interface Transport {
  readonly id: 'direct' | 'proxy' | 'plugin';
  /** 发起请求；网络/CORS 错误抛 TransportError（adapter 捕获后转中文文案） */
  request(req: TransportRequest): Promise<TransportResponse>;
  /** 当前是否可用（proxy 未填地址 = 不可用） */
  available(): boolean;
}

/** 直连实现：浏览器 fetch（现状逻辑搬移，错误结构化） */
export class DirectTransport implements Transport {
  readonly id = 'direct' as const;

  available(): boolean {
    return true;
  }

  async request(req: TransportRequest): Promise<TransportResponse> {
    let res: Response;
    try {
      res = await fetch(req.url, {
        method: req.method ?? 'GET',
        headers: req.headers,
        body: req.body,
      });
    } catch (err) {
      // fetch TypeError：CORS 拦截 / 断网 / DNS 失败（浏览器层拿不到具体原因）
      throw new TransportError('cors', `网络请求失败：${err instanceof Error ? err.message : String(err)}`);
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return {
      status: res.status,
      headers,
      body: await res.text(),
    };
  }
}

/** 代理实现：POST {proxyUrl}/api/proxy 转发（协议见 docs/transport.md §协议） */
export class ProxyTransport implements Transport {
  readonly id = 'proxy' as const;
  private readonly base: string;
  private readonly token: string;

  constructor(base: string, token = '') {
    this.base = base;
    this.token = token;
  }

  available(): boolean {
    return Boolean(this.base);
  }

  async request(req: TransportRequest): Promise<TransportResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/api/proxy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { 'X-Proxy-Token': this.token } : {}),
        },
        body: JSON.stringify({
          url: req.url,
          method: req.method ?? 'GET',
          headers: req.headers ?? {},
          body: req.body ?? null,
        }),
      });
    } catch (err) {
      // 代理地址不可达 / 代理没带 CORS 头
      throw new TransportError('network', `代理请求失败：${err instanceof Error ? err.message : String(err)}（请检查代理地址或网络）`);
    }
    if (!res.ok) {
      // 代理自身错误（token 校验失败等）
      const text = await res.text().catch(() => '');
      throw new TransportError('http', `代理返回 ${res.status}${text ? `：${text.slice(0, 200)}` : ''}`, res.status);
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return {
      status: res.status,
      headers,
      body: await res.text(),
    };
  }
}

/* ============ 单例（类定义之后再初始化，避免 TDZ） ============ */

let active: Transport = new DirectTransport();

/** 设置当前传输（设置面板切换时调用；null = 回退直连） */
export function setActiveTransport(t: Transport | null): void {
  active = t ?? new DirectTransport();
}

/** 取当前传输（adapter 内部用；缺省直连） */
export function getActiveTransport(): Transport {
  return active;
}

/** 根据偏好创建传输（preferences.transport 配置 → 实例） */
export function transportFromPrefs(prefs: { mode: 'direct' | 'proxy'; proxyUrl: string; proxyToken?: string }): Transport {
  if (prefs.mode === 'proxy' && prefs.proxyUrl.trim()) {
    return new ProxyTransport(prefs.proxyUrl.trim().replace(/\/+$/, ''), prefs.proxyToken ?? '');
  }
  return new DirectTransport();
}
