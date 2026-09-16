/**
 * 四类路由 · download（上游取直链 / OSS 相关请求）
 *
 * 薄路由：全部逻辑在 ../api/_shared/proxy-core.js（转发引擎一份实现）。
 * 托管/取号也在这条链路上生效（uc/quark 的 download 才取号，alipan 登录态由 SPA 自带）。
 */
import { handleProxyRequest, onRequestOptions } from './_shared/proxy-core.js';

export { onRequestOptions };

export function onRequestPost(context) {
  return handleProxyRequest(context, 'download');
}
