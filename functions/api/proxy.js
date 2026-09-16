/**
 * 兼容别名路由 · /api/proxy（v1.3.1 起保留一版，行为与四类拆分前完全一致）
 *
 * 老 SPA / 老部署仍往这里发；`kind = null` → 按目标 URL 自动分类（proxy-core#classifyOperation）。
 * 新代码请用 /api/scan、/api/download、/api/restore、/api/credential-pick。
 * TODO(P3)：等 backend hop 同步改名后，这里再考虑下线（Tzz D3：老路径 1.4 移除）。
 */
import { handleProxyRequest, onRequestOptions } from './_shared/proxy-core.js';

export { onRequestOptions };

export function onRequestPost(context) {
  return handleProxyRequest(context, null);
}
