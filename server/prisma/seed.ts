import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  // 幂等：清空重建
  await prisma.cart.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.sku.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.address.deleteMany();
  await prisma.user.deleteMany();
  await prisma.merchant.deleteMany();

  // 商家
  await prisma.merchant.create({
    data: {
      username: 'merchant',
      passwordHash: await bcrypt.hash('商家123', 10),
      nickname: '你宠啥掌柜',
    },
  });

  // 测试用户
  await prisma.user.create({ data: { openid: 'dev-openid-1', nickname: '铲屎官一号' } });
  await prisma.user.create({ data: { openid: 'dev-openid-2', nickname: '铲屎官二号' } });

  // 分类与商品（显式类型，避免异构元组推断成 union）
  interface SeedSku { stock: number; specName: string; price: number }
  interface SeedProduct { name: string; subtitle: string; skus: SeedSku[] }
  interface SeedCategory { name: string; icon: string; products: SeedProduct[] }

  const catDefs: SeedCategory[] = [
    { name: '主粮/罐头', icon: '🍖', products: [
      { name: '天然鸡肉猫粮 2kg', subtitle: '高蛋白养胃鸡肉配方', skus: [
        { stock: 1500, specName: '2kg/鸡肉', price: 9900 }, { stock: 1900, specName: '2kg/三文鱼', price: 10900 },
      ] },
      { name: '冻干双拼犬粮 5kg', subtitle: '添加鸡肉冻干 适口性好', skus: [{ stock: 500, specName: '5kg', price: 16800 }] },
      { name: '主食罐头 85g×12', subtitle: '无谷主食罐 补水神器', skus: [{ stock: 1200, specName: '85g×12罐', price: 8800 }] },
    ] },
    { name: '零食/奖励', icon: '🍪', products: [
      { name: '风干鸡胸肉 300g', subtitle: '纯肉无添加 训练奖励', skus: [
        { stock: 1000, specName: '300g', price: 3900 }, { stock: 600, specName: '500g', price: 5500 },
      ] },
      { name: '冻干鹌鹑蛋黄 200g', subtitle: '美毛补营养', skus: [{ stock: 800, specName: '200g', price: 4500 }] },
    ] },
    { name: '用品/玩具', icon: '🧸', products: [
      { name: '猫抓板 瓦楞纸', subtitle: '耐抓不掉屑 送猫薄荷', skus: [{ stock: 300, specName: '标准款', price: 1900 }] },
      { name: '逗猫棒 仙羽', subtitle: '羽毛替换头 激光逗猫', skus: [{ stock: 400, specName: '单支', price: 1500 }] },
      { name: '自动饮水机 2L', subtitle: '静音水泵 四重过滤', skus: [{ stock: 100, specName: '2L 白色', price: 12900 }] },
    ] },
  ];

  let skuSeq = 1;
  for (const cat of catDefs) {
    const category = await prisma.category.create({ data: { name: cat.name, icon: cat.icon, sortOrder: skuSeq } });
    for (const productDef of cat.products) {
      const product = await prisma.product.create({
        data: {
          name: productDef.name,
          subtitle: productDef.subtitle,
          description: `${productDef.name}——${productDef.subtitle}，本商品为演示种子数据。`,
          coverImage: `https://dummyimage.com/400x400/ffd43b/333333&text=${encodeURIComponent(productDef.name.slice(0, 6))}`,
          categoryId: category.id,
          minPrice: Math.min(...productDef.skus.map((s) => s.price)),
        },
      });
      for (const sku of productDef.skus) {
        await prisma.sku.create({
          data: { productId: product.id, specName: sku.specName, price: sku.price, stock: sku.stock },
        });
        skuSeq++;
      }
    }
  }

  console.log(`[seed] 商家1 用户2 分类${catDefs.length} 商品${catDefs.reduce((a, c) => a + c.products.length, 0)} SKU${skuSeq - 1}`);
}

main().finally(() => prisma.$disconnect());