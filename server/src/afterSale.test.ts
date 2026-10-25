import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from './app';
import { prisma } from './db';
import { approveAfterSale, rejectAfterSale, confirmReturnReceived, autoProgressAfterSales } from './services/afterSaleService';

// 售后状态机端到端测试。重点覆盖两类风险：
//  ① 资金：同一订单被重复退款、超额退款
//  ② 状态：跳步（未同意就退款）、并发（连点两次同意）

let token = '';
let addrId = 0;
let skuId = 0;

beforeEach(async () => {
  await prisma.address.deleteMany();
  await prisma.orderItem.deleteMany();
  // 售后单引用 Order/User，必须先删，否则外键约束会挡住
  await prisma.afterSale.deleteMany();
  await prisma.order.deleteMany();
  await prisma.cart.deleteMany();
  await prisma.sku.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.user.deleteMany();

  const cat = await prisma.category.create({ data: { name: '主粮' } });
  const p = await prisma.product.create({
    data: { categoryId: cat.id, name: '鸡肉猫粮', coverImage: 'http://img/a.png', status: 'ON' },
  });
  skuId = (await prisma.sku.create({ data: { productId: p.id, specName: '2kg', price: 19900, stock: 10 } })).id;

  const login = await request(createApp()).post('/api/auth/dev-login').send({ code: 'as-test' });
  token = login.body.data.token;
  const addr = await request(createApp())
    .post('/api/user/addresses')
    .set('Authorization', `Bearer ${token}`)
    .send({ receiverName: '张三', phone: '13800138000', province: '广东省', city: '深圳市', district: '南山区', detail: '科技园路 1 号' });
  addrId = addr.body.data.id;
});

function h() {
  return { Authorization: `Bearer ${token}` };
}

/** 造一笔指定状态的订单 */
async function makeOrder(status: 'PAID' | 'SHIPPED' | 'COMPLETED') {
  const res = await request(createApp())
    .post('/api/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({ items: [{ skuId, quantity: 1 }], addressId: addrId, fromCart: false });
  const orderNo = res.body.data.orderNo as string;
  await prisma.order.update({
    where: { orderNo },
    data: {
      status,
      paidAt: new Date(),
      ...(status === 'SHIPPED' ? { shippedAt: new Date(), logisticsCompany: '顺丰', trackingNo: 'SF1' } : {}),
      ...(status === 'COMPLETED' ? { shippedAt: new Date(), completedAt: new Date() } : {}),
    },
  });
  return orderNo;
}

describe('售后申请', () => {
  it('待发货订单可申请仅退款，默认退全额', async () => {
    const orderNo = await makeOrder('PAID');
    const res = await request(createApp())
      .post('/api/after-sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderNo, type: 'REFUND_ONLY', reason: 'NOT_SHIPPED' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('PENDING');
    expect(res.body.data.refundAmount).toBe(19900);
  });

  it('待付款订单不能申请售后', async () => {
    const orderNo = await makeOrder('PAID');
    await prisma.order.update({ where: { orderNo }, data: { status: 'PENDING_PAYMENT' } });
    const res = await request(createApp())
      .post('/api/after-sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderNo, type: 'REFUND_ONLY', reason: 'NOT_SHIPPED' });
    expect(res.status).toBe(409);
  });

  it('原因与类型不匹配时拒绝：未发货只有仅退款', async () => {
    const orderNo = await makeOrder('SHIPPED');
    const res = await request(createApp())
      .post('/api/after-sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderNo, type: 'RETURN_REFUND', reason: 'NOT_SHIPPED' });
    expect(res.status).toBe(400);
  });

  it('已完成订单的「不想要了」必须走退货退款', async () => {
    const orderNo = await makeOrder('COMPLETED');
    const res = await request(createApp())
      .post('/api/after-sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderNo, type: 'REFUND_ONLY', reason: 'NO_LONGER_NEEDED' });
    expect(res.status).toBe(409);
  });

  it('退款金额不能超过订单实付', async () => {
    const orderNo = await makeOrder('PAID');
    const res = await request(createApp())
      .post('/api/after-sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderNo, type: 'REFUND_ONLY', reason: 'NOT_SHIPPED', refundAmount: 99999 });
    expect(res.status).toBe(400);
  });

  it('同一订单不能同时有两笔在途售后（防重复退款）', async () => {
    const orderNo = await makeOrder('PAID');
    const first = await request(createApp())
      .post('/api/after-sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderNo, type: 'REFUND_ONLY', reason: 'NOT_SHIPPED' });
    expect(first.status).toBe(200);

    const second = await request(createApp())
      .post('/api/after-sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderNo, type: 'REFUND_ONLY', reason: 'NOT_SHIPPED' });
    expect(second.status).toBe(409);
  });
});

describe('仅退款流程', () => {
  it('同意后立即退款并置为已完成，订单 refundedAmount 累加', async () => {
    const orderNo = await makeOrder('PAID');
    const apply = await request(createApp())
      .post('/api/after-sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderNo, type: 'REFUND_ONLY', reason: 'NOT_SHIPPED' });
    const afterSaleNo = apply.body.data.afterSaleNo;

    // mock 支付环境下退款直接成功
    await approveAfterSale(afterSaleNo);

    const row = await prisma.afterSale.findUnique({ where: { afterSaleNo } });
    expect(row?.status).toBe('COMPLETED');
    expect(row?.refundedAmount).toBe(19900);

    const order = await prisma.order.findUnique({ where: { orderNo } });
    expect(order?.refundedAmount).toBe(19900);
  });

  it('重复同意不会退两次（幂等）', async () => {
    const orderNo = await makeOrder('PAID');
    const apply = await request(createApp())
      .post('/api/after-sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderNo, type: 'REFUND_ONLY', reason: 'NOT_SHIPPED' });
    const afterSaleNo = apply.body.data.afterSaleNo;

    await approveAfterSale(afterSaleNo);
    // 第二次应被状态机拦住
    await expect(approveAfterSale(afterSaleNo)).rejects.toThrow();

    const order = await prisma.order.findUnique({ where: { orderNo } });
    expect(order?.refundedAmount).toBe(19900); // 不是 39800
  });

  it('拒绝后不再能同意', async () => {
    const orderNo = await makeOrder('PAID');
    const apply = await request(createApp())
      .post('/api/after-sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderNo, type: 'REFUND_ONLY', reason: 'NOT_SHIPPED' });
    const afterSaleNo = apply.body.data.afterSaleNo;

    await rejectAfterSale(afterSaleNo, '已确认发货，无法退款');
    await expect(approveAfterSale(afterSaleNo)).rejects.toThrow();

    const row = await prisma.afterSale.findUnique({ where: { afterSaleNo } });
    expect(row?.status).toBe('REJECTED');
    expect(row?.refundedAmount).toBe(0);
  });
});

describe('退货退款流程', () => {
  it('同意 → 待退货；填单号 → 已退货；确认收货 → 退款完成', async () => {
    const orderNo = await makeOrder('COMPLETED');
    const apply = await request(createApp())
      .post('/api/after-sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderNo, type: 'RETURN_REFUND', reason: 'SEVEN_DAY' });
    expect(apply.status).toBe(200);
    const afterSaleNo = apply.body.data.afterSaleNo;

    await approveAfterSale(afterSaleNo);
    let row = await prisma.afterSale.findUnique({ where: { afterSaleNo } });
    expect(row?.status).toBe('WAIT_RETURN');

    // 未填单号就确认收货 → 拒绝
    await expect(confirmReturnReceived(afterSaleNo)).rejects.toThrow();

    const ret = await request(createApp())
      .post(`/api/after-sales/${afterSaleNo}/return`)
      .set('Authorization', `Bearer ${token}`)
      .send({ logisticsCompany: '顺丰速运', trackingNo: 'SF123456' });
    expect(ret.status).toBe(200);
    expect(ret.body.data.returnTrackingNo).toBe('SF123456');

    await confirmReturnReceived(afterSaleNo);
    row = await prisma.afterSale.findUnique({ where: { afterSaleNo } });
    expect(row?.status).toBe('COMPLETED');
    expect(row?.refundedAmount).toBe(19900);
  });

  it('待退货状态下不能重复提交单号', async () => {
    const orderNo = await makeOrder('COMPLETED');
    const apply = await request(createApp())
      .post('/api/after-sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderNo, type: 'RETURN_REFUND', reason: 'SEVEN_DAY' });
    const afterSaleNo = apply.body.data.afterSaleNo;
    await approveAfterSale(afterSaleNo);

    await request(createApp())
      .post(`/api/after-sales/${afterSaleNo}/return`)
      .set('Authorization', `Bearer ${token}`)
      .send({ logisticsCompany: '顺丰速运', trackingNo: 'SF1' });

    const again = await request(createApp())
      .post(`/api/after-sales/${afterSaleNo}/return`)
      .set('Authorization', `Bearer ${token}`)
      .send({ logisticsCompany: '顺丰速运', trackingNo: 'SF2' });
    expect(again.status).toBe(409);
  });
});

describe('售后与订单的联动', () => {
  it('有在途售后时不允许确认收货', async () => {
    const orderNo = await makeOrder('SHIPPED');
    const apply = await request(createApp())
      .post('/api/after-sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderNo, type: 'REFUND_ONLY', reason: 'LOGISTICS_STUCK' });
    expect(apply.status).toBe(200);

    const confirm = await request(createApp())
      .post(`/api/orders/${orderNo}/confirm`)
      .set('Authorization', `Bearer ${token}`);
    expect(confirm.status).toBe(409);
  });

  it('撤销后可以重新申请', async () => {
    const orderNo = await makeOrder('PAID');
    const apply = await request(createApp())
      .post('/api/after-sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderNo, type: 'REFUND_ONLY', reason: 'NOT_SHIPPED' });
    const afterSaleNo = apply.body.data.afterSaleNo;

    const cancel = await request(createApp())
      .post(`/api/after-sales/${afterSaleNo}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(cancel.status).toBe(200);

    const reapply = await request(createApp())
      .post('/api/after-sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderNo, type: 'REFUND_ONLY', reason: 'NOT_SHIPPED' });
    expect(reapply.status).toBe(200);
  });

  it('退款已提交（REFUNDING）时不能撤销', async () => {
    const orderNo = await makeOrder('PAID');
    const apply = await request(createApp())
      .post('/api/after-sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderNo, type: 'REFUND_ONLY', reason: 'NOT_SHIPPED' });
    const afterSaleNo = apply.body.data.afterSaleNo;
    await prisma.afterSale.update({ where: { afterSaleNo }, data: { status: 'REFUNDING' } });

    const cancel = await request(createApp())
      .post(`/api/after-sales/${afterSaleNo}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(cancel.status).toBe(409);
  });
});

describe('超时处理', () => {
  it('商家超时未处理 → 只标记超时，不自动同意、不退款', async () => {
    const orderNo = await makeOrder('PAID');
    const apply = await request(createApp())
      .post('/api/after-sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderNo, type: 'REFUND_ONLY', reason: 'NOT_SHIPPED' });
    const afterSaleNo = apply.body.data.afterSaleNo;

    // 把创建时间改到 49 小时前（默认 48 小时提醒时限）
    await prisma.afterSale.update({
      where: { afterSaleNo },
      data: { createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000) },
    });

    await autoProgressAfterSales();

    const row = await prisma.afterSale.findUnique({ where: { afterSaleNo } });
    // 超时只是提醒：状态必须还是待处理，钱一分不能动
    expect(row?.status).toBe('PENDING');
    expect(row?.refundedAmount).toBe(0);
  });

  it('显式开启 AFTER_SALE_AUTO_APPROVE=1 才会超时自动同意并退款', async () => {
    const orderNo = await makeOrder('PAID');
    const apply = await request(createApp())
      .post('/api/after-sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderNo, type: 'REFUND_ONLY', reason: 'NOT_SHIPPED' });
    const afterSaleNo = apply.body.data.afterSaleNo;

    await prisma.afterSale.update({
      where: { afterSaleNo },
      data: { createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000) },
    });

    process.env.AFTER_SALE_AUTO_APPROVE = '1';
    try {
      await autoProgressAfterSales();
    } finally {
      delete process.env.AFTER_SALE_AUTO_APPROVE;
    }

    const row = await prisma.afterSale.findUnique({ where: { afterSaleNo } });
    expect(row?.status).toBe('COMPLETED');
    expect(row?.refundedAmount).toBe(19900);
  });

  it('买家超时未退货 → 售后自动关闭（不退款）', async () => {
    const orderNo = await makeOrder('COMPLETED');
    const apply = await request(createApp())
      .post('/api/after-sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderNo, type: 'RETURN_REFUND', reason: 'SEVEN_DAY' });
    const afterSaleNo = apply.body.data.afterSaleNo;
    await approveAfterSale(afterSaleNo); // → WAIT_RETURN

    // agreedAt 改到 8 天前（默认 7 天时限）
    await prisma.afterSale.update({
      where: { afterSaleNo },
      data: { agreedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
    });

    await autoProgressAfterSales();

    const row = await prisma.afterSale.findUnique({ where: { afterSaleNo } });
    expect(row?.status).toBe('CANCELLED');
    expect(row?.refundedAmount).toBe(0);
  });
});
