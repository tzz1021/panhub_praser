/**
 * 四类路由 · scan（免登录：分享临时凭据 + 分享目录 list）
 *
 * 薄路由：全部逻辑在 ../api/_shared/proxy-core.js（转发引擎一份实现）。
 * 判据表见 proxy-core.js#classifyOperation；与目标 URL 分类不一致会 400 OP_MISMATCH。
 */
import { handleProxyRequest, onRequestOptions } from './_shared/proxy-core.js';

export { onRequestOptions };

export function onRequestPost(context) {
  return handleProxyRequest(context, 'scan');
}
