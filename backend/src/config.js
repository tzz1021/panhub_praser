/**
 * 配置加载/默认值/密钥文件管理（docs/selfhost-node.md §3/§4）
 *
 * - 配置文件：data/period/config.json（端口/对外暴露/限频/通知等）
 * - 密钥文件：data/period/secret.key（AES-256-GCM 加密 cookie 库用，权限 600）
 * - 首启：随机生成 proxy/webui 端口（20000–60000，避开常见端口）+ secret.key
 */
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); // backend/
export const DATA_DIR = join(ROOT, 'data');
export const TMP_DIR = join(DATA_DIR, 'tmp');
export const PERIOD_DIR = join(DATA_DIR, 'period');
const CONFIG_PATH = join(PERIOD_DIR, 'config.json');
const SECRET_PATH = join(PERIOD_DIR, 'secret.key');

/** 默认配置（首启合并写入 config.json） */
const DEFAULTS = {
  proxy: {
    port: null, // 首启随机生成
    host: '127.0.0.1', // 默认仅本机；对外暴露时才改 0.0.0.0
    expose: false, // 对外暴露开关（需二次确认）
    token: null, // X-Proxy-Token（首启随机生成，可轮换）
    rateLimitPerMin: 0, // 0 = 关（默认关，防家庭组误伤）
    ipBan: false, // IP 封禁（默认关，公网建议开）
  },
  webui: {
    port: null, // 首启随机生成（= proxy.port + 1，避免常见端口）
    host: '127.0.0.1', // 硬绑本机（代码层强制；改 host 需显式 + 启动 warning）
    token: null, // WebUI 门禁令牌（首启打印一次性；可轮换）
  },
  whitelist: ['uc.cn', 'quark.cn'], // 域名白名单（默认继承 CF 版 proxy.js）
  notify: {
    enabled: false,
    webhooks: [], // [{ id, name, url, type: 'ntfy'|'serverchan'|'pushplus'|'custom' }]
  },
  cdp: {
    enabled: false,
    wsUrl: '', // remote_debugging 地址（浏览器启动参数 --remote-debugging-port）
  },
  advanced: {
    terminalEnabled: false, // 系统终端默认关
  },
};

/** 当前配置（内存态；写回 config.json） */
let config = structuredClone(DEFAULTS);

function ensureDirs() {
  for (const d of [DATA_DIR, TMP_DIR, PERIOD_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

/** 随机端口（20000–60000；避开常用/易猜端口段） */
function randomPort() {
  return randomInt(20000, 60000);
}

/** 随机令牌（hex） */
export function randomToken(bytes = 24) {
  return randomBytes(bytes).toString('hex');
}

/** 读取 config.json（不存在则写默认 + 随机端口/令牌） */
export function loadConfig() {
  ensureDirs();
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      // 深合并（缺字段用默认）
      config = {
        proxy: { ...DEFAULTS.proxy, ...(raw.proxy ?? {}) },
        webui: { ...DEFAULTS.webui, ...(raw.webui ?? {}) },
        whitelist: Array.isArray(raw.whitelist) ? raw.whitelist : [...DEFAULTS.whitelist],
        notify: { ...DEFAULTS.notify, ...(raw.notify ?? {}) },
        cdp: { ...DEFAULTS.cdp, ...(raw.cdp ?? {}) },
        advanced: { ...DEFAULTS.advanced, ...(raw.advanced ?? {}) },
      };
    } catch (err) {
      console.error(`[config] config.json 损坏（${err.message}），使用默认值并备份`);
      writeFileSync(`${CONFIG_PATH}.bak-${Date.now()}`, readFileSync(CONFIG_PATH));
    }
  }
  const isFirstRun = !existsSync(CONFIG_PATH);
  if (isFirstRun) {
    config.proxy.port = randomPort();
    config.proxy.token = randomToken();
    config.webui.port = config.proxy.port + 1;
    config.webui.token = randomToken();
    saveConfig();
  }
  return { config, isFirstRun };
}

/** 写回 config.json（600 权限） */
export function saveConfig() {
  ensureDirs();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/** 读取（或生成）AES-256-GCM 密钥文件；返回 Buffer（32 字节） */
export function loadSecretKey() {
  ensureDirs();
  if (existsSync(SECRET_PATH)) {
    const buf = readFileSync(SECRET_PATH);
    if (buf.length === 32) return buf;
    console.error('[config] secret.key 长度异常，重新生成（旧 cookie 密文将无法解密）');
  }
  const key = randomBytes(32);
  writeFileSync(SECRET_PATH, key, { mode: 0o600 });
  try {
    chmodSync(SECRET_PATH, 0o600);
  } catch {
    /* 非 POSIX 平台忽略 */
  }
  return key;
}

/** 运行时长（ms） */
let bootAt = Date.now();
export function uptimeMs() {
  return Date.now() - bootAt;
}

export function getConfig() {
  return config;
}
