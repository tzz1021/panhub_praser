/**
 * 四类路由 · restore（转存，旧称 copy）
 *
 * 当前判据：alipan `/adrive/v4/batch`（内层 url:/file/copy 批量转存）。
 * v1.3.1 起「转存」统一叫 restore（旧代码里的 copy 一词退役）。
 */
import { handleProxyRequest, onRequestOptions } from './_shared/proxy-core.js';

export { onRequestOptions };

export function onRequestPost(context) {
  return handleProxyRequest(context, 'restore');
}
