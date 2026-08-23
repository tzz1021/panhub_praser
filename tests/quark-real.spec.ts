/* 夸克适配器真机验证（direct transport，Node 直连） */
import { quarkScanner } from '../src/adapters/quark/scanner';
import { parseShareId, isLongJumpUrl } from '../src/adapters/quark/selector';
import { parseJumpUrl } from '../src/adapters/quark/jumper';
import type { ShareFile } from '../src/adapters/types';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra = ''): void => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name} ${extra}`); }
};

const BIG = 'https://pan.quark.cn/s/3efb93ba1306';
const SMALL_JUMP = 'https://pan.quark.cn/s/cdccb82aafe6#/list/share/4729c7e55ba94264a84f42ec12416034';

async function main(): Promise<void> {
  // ---------- 识别 ----------
  check('大文件短链识别', isLongJumpUrl(BIG) === false && parseShareId(BIG) === '3efb93ba1306', parseShareId(BIG) ?? '');
  check('小文件跳转链识别', isLongJumpUrl(SMALL_JUMP) && parseShareId(SMALL_JUMP) === 'cdccb82aafe6', '');
  const jump = parseJumpUrl(SMALL_JUMP);
  check('跳转链 fid 提取', jump?.segments.length === 1 && jump.segments[0].fid === '4729c7e55ba94264a84f42ec12416034', JSON.stringify(jump));

  // ---------- 大文件分享：token → 深扫找 >50MB 文件 → download（期望 23018） ----------
  console.log('--- 大文件分享 3efb93ba1306（深扫找大文件） ---');
  const { stoken: st1 } = await quarkScanner.getToken({ shareId: '3efb93ba1306', passcode: '' });
  check('大文件 token 获取', st1.length > 10, st1);
  const root1 = await quarkScanner.list({ shareId: '3efb93ba1306', stoken: st1, pdirFid: '0', isRoot: true });
  check('大文件根列表（包装层已下钻）', root1.files.length > 0, `total=${root1.total}`);
  check('根目录 total 有值（分页不截断）', typeof root1.total === 'number' && root1.total > 0, String(root1.total));
  // 有界深扫（≤5 层）找最大文件；分享内容是 Windows 镜像目录树，大 ISO 在深层
  let biggest: ShareFile | null = null;
  const queue: Array<{ fid: string; depth: number }> = [{ fid: '0', depth: 0 }];
  while (queue.length > 0) {
    const { fid, depth } = queue.shift()!;
    if (depth > 5) continue;
    const res = await quarkScanner.list({ shareId: '3efb93ba1306', stoken: st1, pdirFid: fid, isRoot: depth === 0 });
    for (const f of res.files) {
      if (f.dir) queue.push({ fid: f.fid, depth: depth + 1 });
      else if (!biggest || (f.size ?? 0) > (biggest.size ?? 0)) biggest = f;
    }
  }
  console.log(`    最大文件: ${biggest?.fileName} ${((biggest?.size ?? 0) / 1048576).toFixed(1)}MB`);
  check('找到 >50MB 文件（应触发 23018）', !!biggest && (biggest?.size ?? 0) > 50 * 1048576, String(biggest?.size));
  if (biggest && (biggest.size ?? 0) > 50 * 1048576) {
    try {
      await quarkScanner.getDownloadLinks({
        shareId: '3efb93ba1306', stoken: st1,
        fids: [biggest.fid], fidsTokens: [biggest.shareFidToken!],
      });
      check('大文件 guest 下载被拒（23018）', false, '竟然成功了？');
    } catch (err) {
      const code = (err as { code?: number }).code;
      check('大文件 guest 下载 → 23018 size limit', code === 23018, String(code) + ' ' + String((err as Error).message));
    }
  }

  // ---------- 小文件跳转目录：token → 列表（jumper 的 pdir_fid）→ download（期望成功） ----------
  console.log('--- 小文件跳转目录 cdccb82aafe6 ---');
  const { stoken: st2 } = await quarkScanner.getToken({ shareId: 'cdccb82aafe6', passcode: '' });
  const root2 = await quarkScanner.list({ shareId: 'cdccb82aafe6', stoken: st2, pdirFid: '0', isRoot: true });
  check('小文件根列表（包装层已下钻=2 个目录）', root2.files.length === 2, String(root2.files.length));
  const sub = await quarkScanner.list({
    shareId: 'cdccb82aafe6', stoken: st2,
    pdirFid: '4729c7e55ba94264a84f42ec12416034',
  });
  check('jumper 目录列表', sub.files.length > 0, String(sub.files.length));
  check('子目录 total 有值', typeof sub.total === 'number' && sub.total > 0, String(sub.total));
  const small = sub.files.find((f) => !f.dir && (f.size ?? 0) < 10 * 1048576);
  check('找到小文件', !!small, JSON.stringify(sub.files.filter((f) => !f.dir).slice(0, 3).map((f) => f.fileName)));
  if (small) {
    const links = await quarkScanner.getDownloadLinks({
      shareId: 'cdccb82aafe6', stoken: st2,
      fids: [small.fid], fidsTokens: [small.shareFidToken!],
    });
    check('小文件 guest 下载成功', links.length === 1 && !!links[0].url, JSON.stringify(links[0] ?? null));
    check('小文件 md5 免费附带', /^[0-9a-f]{32}$/i.test(links[0].md5 ?? ''), links[0].md5 ?? '');
    // 直链 + pugs 实测下载（pugs 直接模式下拿不到，这里用 curl 抓的旧值验证直链机制）
    const dl = await fetch(links[0].url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    check('直链无 cookie → 412（证明需要 __pugs）', dl.status === 412, String(dl.status));
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('异常', e); process.exit(1); });
