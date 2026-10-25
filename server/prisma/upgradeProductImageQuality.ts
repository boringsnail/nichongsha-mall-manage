/**
 * 商品图片清晰度升级：把美团图片 CDN 的 88×88 缩略图后缀换成适合手机展示的尺寸。
 *
 * 背景：商品从美团闪购后台导入时，接口给的是 88×88 缩略图（`@88h_88w_1e`），
 * 列表页勉强够用，但商品详情页会明显发虚。美团图片服务支持在 URL 后拼尺寸参数，
 * 去掉或替换后缀即可拿到大图（实测原图 800KB+，`@600w_600h_1e` 约 56KB，清晰度与体积更均衡）。
 *
 * 用法（在 server/ 目录下）：
 *   npx tsx prisma/upgradeProductImageQuality.ts            # 只统计，不写库
 *   npx tsx prisma/upgradeProductImageQuality.ts --apply    # 实际更新
 *   npx tsx prisma/upgradeProductImageQuality.ts --apply --size 750w_750h
 *
 * 幂等：已经是目标尺寸的图片会被跳过，可重复执行。
 */
import { prisma } from '../src/db.js';

const DEFAULT_SIZE = '600w_600h';
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const sizeArg = args.find((a) => a.startsWith('--size='))?.slice('--size='.length) || DEFAULT_SIZE;
/** 目标后缀：仅允许 数字w_数字h 形式，避免把非法字符拼进 URL */
if (!/^\d{2,4}w_\d{2,4}h$/.test(sizeArg)) {
  console.error(`尺寸参数不合法：${sizeArg}（期望形如 600w_600h）`);
  process.exit(1);
}
const targetSuffix = `@${sizeArg}_1e`;

/** 只处理美团图片 CDN（p0/p1/img.meituan.net），且带 @... 后缀的 URL */
function upgrade(url: string | null): string | null {
  if (!url) return null;
  if (!/^https:\/\/(p[0-9]|img)\.meituan\.net\//.test(url)) return null;
  const matched = /^(.+?)@([0-9]+h_[0-9]+w|[0-9]+w_[0-9]+h|w_[0-9]+|h_[0-9]+)(.*)$/.exec(url);
  if (!matched) {
    // 无尺寸后缀：原图直接用，不加工
    return null;
  }
  const next = `${matched[1]}${targetSuffix}`;
  return next === url ? null : next;
}

async function main() {
  const products = await prisma.product.findMany({ select: { id: true, name: true, coverImage: true } });
  const changes: { id: number; name: string; from: string; to: string }[] = [];
  for (const p of products) {
    const next = upgrade(p.coverImage);
    if (next) changes.push({ id: p.id, name: p.name, from: p.coverImage!, to: next });
  }

  console.log(`商品总数: ${products.length}，需要升级: ${changes.length}，目标尺寸: ${sizeArg}`);
  if (changes.length) {
    console.log('示例：');
    console.log(`  商品 ${changes[0].id} ${changes[0].name.slice(0, 20)}`);
    console.log(`    from: ${changes[0].from}`);
    console.log(`    to  : ${changes[0].to}`);
  }

  if (!apply) {
    console.log('\n[dry-run] 未写库。确认无误后加 --apply 执行。');
    return;
  }

  let done = 0;
  for (const change of changes) {
    await prisma.product.update({ where: { id: change.id }, data: { coverImage: change.to } });
    done += 1;
  }
  console.log(`\n✅ 已更新 ${done} 个商品封面`);

  const remain = await prisma.product.count({
    where: { coverImage: { contains: '@88h_88w' } },
  });
  console.log(`剩余 88×88 缩略图: ${remain}`);
}

main()
  .catch((error) => {
    console.error('执行失败:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
