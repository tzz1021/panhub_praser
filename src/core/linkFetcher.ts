/**
 * 批量直链获取（docs/STRUCTURE.md：src/core/linkFetcher.ts）
 *
 * 节流参考 LinkSwift：15 个/批 + 批间 1s，防网盘风控。
 * 职责：按输入顺序把 ShareFile[] 分批调用 adapter.getDownloadLinks，
 * 每个输入文件产出一条 LinkResult，顺序与输入一致。
 * 缺 shareFidToken 的文件直接标记失败（不进请求）；单批失败默认继续下一批。
 */
import type { ShareFile } from '../adapters/types';
import type { LinkFetchContext, LinkFetchOptions, LinkResult } from './types';

/** 批间等待（sleep，用于节流） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 批量获取直链。
 * @param ctx     直链获取上下文（adapter/shareId/stoken，见 core/types.ts）
 * @param files   待获取的文件列表（应只传文件，传目录也会因缺令牌被安全拒掉）
 * @param options 节流与容错配置（batchSize/batchIntervalMs/continueOnError）
 * @returns 与输入 files 一一对应的 LinkResult[]（顺序一致）
 */
export async function fetchLinks(
  ctx: LinkFetchContext,
  files: ShareFile[],
  options?: LinkFetchOptions,
): Promise<LinkResult[]> {
  const batchSize = Math.max(1, options?.batchSize ?? 15);
  const batchIntervalMs = Math.max(0, options?.batchIntervalMs ?? 1000);
  const continueOnError = options?.continueOnError ?? true;

  // 预填结果：缺 shareFidToken 的文件直接失败，不进请求（目录同样走此规则）
  const results: LinkResult[] = files.map((file) =>
    file.shareFidToken
      ? { file, url: '', ok: true }
      : { file, url: '', ok: false, error: '文件令牌缺失，请重新解析' },
  );

  // 需要发请求的文件下标（保持输入顺序）
  const pending: number[] = [];
  files.forEach((file, i) => {
    if (file.shareFidToken) {
      pending.push(i);
    }
  });

  // 按输入顺序分批
  for (let start = 0; start < pending.length; start += batchSize) {
    const indices = pending.slice(start, start + batchSize);
    const batch = indices.map((i) => files[i]);
    const fids = batch.map((f) => f.fid);
    // 已按 shareFidToken 过滤，这里必然存在
    const fidsTokens = batch.map((f) => f.shareFidToken as string);

    try {
      const urls = await ctx.adapter.getDownloadLinks({
        shareId: ctx.shareId,
        stoken: ctx.stoken,
        fids,
        fidsTokens,
      });
      // 适配器返回与请求顺序一致（接口契约）；逐一回填，数量不足时补失败项
      indices.forEach((idx, j) => {
        const item = urls[j];
        if (item?.url) {
          results[idx] = { file: files[idx], url: item.url, ok: true, cookie: item.cookie };
        } else {
          results[idx] = { file: files[idx], url: '', ok: false, error: '未返回直链，请重试' };
        }
      });
    } catch (err) {
      // 单批失败：整批标记失败；continueOnError=false 时中止剩余批次
      const message = err instanceof Error ? err.message : String(err);
      // 业务错误码透传（duck-typing：适配器错误对象带 code 字段即可；core 零网盘依赖）
      const errorCode = (err as { code?: number | string } | null | undefined)?.code;
      indices.forEach((idx) => {
        results[idx] = { file: files[idx], url: '', ok: false, error: message, errorCode };
      });
      if (!continueOnError) {
        // 中止后剩余文件也标记失败，避免 ok:true + 空 url 的脏数据
        for (let k = start + batchSize; k < pending.length; k++) {
          const idx = pending[k];
          results[idx] = {
            file: files[idx],
            url: '',
            ok: false,
            error: '因前序批次失败已中止，未获取直链',
          };
        }
        break;
      }
    }

    // 批间节流（最后一批不必再等）
    if (start + batchSize < pending.length) {
      await sleep(batchIntervalMs);
    }
  }

  return results;
}
