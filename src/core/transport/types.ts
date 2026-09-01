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

/** 结构化网络错误（替代现在 adapter 里“猜 message 含 CORS”的方式） */
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

/** v1.2.2：最近一次代理响应回传的 x-panhub-account（代理托管账号 label；无则 null）。
 * 只记 label 不记 cookie 明文 —— 供 CookieInputModal 展示「代理托管账号」，服务端不回传真实凭据。 */
let lastProxyAccountLabel: string | null = null;

/** v1.2.2（wip2 修正）：x-panhub-account-id —— 命中账号的数字 id（后端 cookie-pick / hop 回传；无则 null）。 */
let lastProxyAccountId: number | null = null;

/** v1.2.2（wip2 修正）：x-panhub-backend: ok —— functions 检测到 backend 可取号（代理托管生效；无则 false）。 */
let lastProxyBackendOk = false;

/** 取最近一次代理响应回传的代理托管账号 label（无则 null；仅 label，不含任何 cookie 明文） */
export function getLastProxyAccountLabel(): string | null {
  return lastProxyAccountLabel;
}

/** 取最近一次代理响应回传的命中账号数字 id（无则 null；审计/判重用，不含 cookie 明文） */
export function getLastProxyAccountId(): number | null {
  return lastProxyAccountId;
}

/** 最近一次代理响应是否带 x-panhub-backend: ok（functions 已从 backend 取到号；无则 false） */
export function getLastProxyBackendOk(): boolean {
  return lastProxyBackendOk;
}

/** 代理实现：POST {proxyUrl}/api/proxy 转发（协议见 docs/transport.md §协议） */
export class ProxyTransport implements Transport {
  readonly id = 'proxy' as const;
  private readonly base: string;
  private readonly token: string;
  /** v1.2.2：IP 采集（哈希化后上传）——开时请求带 x-panhub-trace: ip-hash 头，服务端 sha256(ip+salt) 后落库 */
  private readonly ipHash: boolean;

  constructor(base: string, token = '', ipHash = false) {
    this.base = base;
    this.token = token;
    this.ipHash = ipHash;
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
          // v1.2.2：IP 采集开关（默认关）；开时服务端按 consent 头哈希化 IP 落 trace，不落明文
          ...(this.ipHash ? { 'x-panhub-trace': 'ip-hash' } : {}),
        },
        body: JSON.stringify({
          url: req.url,
          method: req.method ?? 'GET',
          headers: req.headers ?? {},
          body: req.body ?? null,
          // v1.2.2：请求级 ID，供服务端 trace 两阶段关联（直连无服务端日志，DirectTransport 不加）
          frontend_id: crypto.randomUUID(),
        }),
      });
    } catch (err) {
      // 代理地址不可达 / 代理没带 CORS 头
      throw new TransportError('network', `代理请求失败：${err instanceof Error ? err.message : String(err)}（请检查代理地址或网络）`);
    }
    // 代理**原样透传**上游状态码 + body（与直连同规格）：
    // 网盘业务错误（夸克 23018/31001 走 HTTP 400/403 + JSON body code）必须由 adapter
    // 从 body 里解析，这里不能因 !res.ok 提前抛错丢掉业务码 —— 否则登录态弹窗永远不触发。
    // 代理自身错误（401 令牌无效/403 白名单/429 限频）同样是 JSON body，
    // adapter 的 status 检查会兜底展示 message（见 adapters/*/scanner.ts request）。
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    // v1.2.2：代理托管账号 label（云端 cookie-pick / 本地 hop 命中账号时回传；经 headers 透传通道到达）
    // 服务端统一 encodeURIComponent（Node http 非 ASCII 头限制），这里解码回可读标签
    if (headers['x-panhub-account']) {
      try {
        lastProxyAccountLabel = decodeURIComponent(headers['x-panhub-account']);
      } catch {
        lastProxyAccountLabel = headers['x-panhub-account'];
      }
    }
    // v1.2.2（wip2 修正）：命中账号数字 id + backend 可用标记（functions cookie-pick 成功才回传；
    // 缺失 = 未取到号/未配置 BACKEND_URL，保持旧值不覆盖，避免误报）
    const accountIdRaw = headers['x-panhub-account-id'];
    if (accountIdRaw !== undefined && accountIdRaw !== null && accountIdRaw !== '') {
      const n = Number(accountIdRaw);
      if (Number.isFinite(n)) lastProxyAccountId = n;
    }
    if (headers['x-panhub-backend'] === 'ok') {
      lastProxyBackendOk = true;
    }
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
  // v1.2.2（wip2 修正）：切换传输时重置托管状态，避免旧代理的账号/可用性标记串到新传输
  lastProxyAccountLabel = null;
  lastProxyAccountId = null;
  lastProxyBackendOk = false;
}

/** 取当前传输（adapter 内部用；缺省直连） */
export function getActiveTransport(): Transport {
  return active;
}

/** 根据偏好创建传输（preferences.transport 配置 → 实例） */
export function transportFromPrefs(prefs: { mode: 'direct' | 'proxy'; proxyUrl: string; proxyToken?: string; ipHashUpload?: boolean }): Transport {
  if (prefs.mode === 'proxy' && prefs.proxyUrl.trim()) {
    return new ProxyTransport(prefs.proxyUrl.trim().replace(/\/+$/, ''), prefs.proxyToken ?? '', prefs.ipHashUpload ?? false);
  }
  return new DirectTransport();
}
