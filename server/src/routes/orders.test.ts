import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../db';
import { cancelExpiredOrders } from '../services/orderService';

let sku1Id = 0; // 鸡肉猫粮 2kg @19900 stock 10
let sku2Id = 0; // 逗猫棒 单支 @1500 stock 5

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
  const p1 = await prisma.product.create({
    data: { categoryId: cat.id, name: '鸡肉猫粮', coverImage: 'http://img/a.png', status: 'ON' },
  });
  const p2 = await prisma.product.create({
    data: { categoryId: cat.id, name: '逗猫棒', coverImage: 'http://img/b.png', status: 'ON' },
  });
  sku1Id = (await prisma.sku.create({ data: { productId: p1.id, specName: '2kg', price: 19900, stock: 10 } })).id;
  sku2Id = (await prisma.sku.create({ data: { productId: p2.id, specName: '单支', price: 1500, stock: 5 } })).id;
});

// 登录 + 为该用户建地址（地址必须属于下单用户）
async function makeUser(code: string) {
  const login = await request(createApp()).post('/api/auth/dev-login').send({ code });
  expect(login.status).toBe(200);
  const token = login.body.data.token as string;
  const addr = await request(createApp())
    .post('/api/user/addresses')
    .set('Authorization', `Bearer ${token}`)
    .send({ receiverName: '张三', phone: '13800138000', province: '广东省', city: '深圳市', district: '南山区', detail: '科技园路 1 号' });
  expect(addr.status).toBe(200);
  return { token, addrId: addr.body.data.id as number };
}

function h(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function createOrder(token: string, addrId: number, items: { skuId: number; quantity: number }[], remark?: string) {
  const app = createApp();
  const res = await request(app)
    .post('/api/orders')
    .set(h(token))
    .send({ items, addressId: addrId, ...(remark ? { remark } : {}) });
  return { app, orderNo: res.body.data?.orderNo as string, status: res.status };
}

describe('订单域 API', () => {
  describe('preview 计价', () => {
    it('混合多 SKU 合计正确（整数分）', async () => {
      const { token, addrId } = await makeUser('u13-p1');
      const res = await request(createApp())
        .post('/api/orders/preview')
        .set(h(token))
        .send({ items: [{ skuId: sku1Id, quantity: 2 }, { skuId: sku2Id, quantity: 3 }], addressId: addrId });
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d.totalAmount).toBe(19900 * 2 + 1500 * 3);
      expect(d.freight).toBe(0);
      expect(d.items).toHaveLength(2);
      const sku1 = d.items.find((i: any) => i.skuId === sku1Id);
      expect(sku1.subtotal).toBe(39800);
      expect(sku1.productName).toBe('鸡肉猫粮');
      expect(sku1.specName).toBe('2kg');
    });

    it('数量 ≤0 → 400', async () => {
      const { token, addrId } = await makeUser('u13-p2');
      const res = await request(createApp())
        .post('/api/orders/preview')
        .set(h(token))
        .send({ items: [{ skuId: sku1Id, quantity: 0 }], addressId: addrId });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PARAM_ERROR');
    });

    it('空 items → 400', async () => {
      const { token, addrId } = await makeUser('u13-p3');
      const res = await request(createApp())
        .post('/api/orders/preview')
        .set(h(token))
        .send({ items: [], addressId: addrId });
      expect(res.status).toBe(400);
    });

    it('地址不存在 → 404', async () => {
      const { token } = await makeUser('u13-p4');
      const res = await request(createApp())
        .post('/api/orders/preview')
        .set(h(token))
        .send({ items: [{ skuId: sku1Id, quantity: 1 }], addressId: 999999 });
      expect(res.status).toBe(404);
    });

    it('使用他人地址 → 404（隔离）', async () => {
      const { token } = await makeUser('u13-p5');
      const { addrId: otherAddrId } = await makeUser('u13-p6');
      const res = await request(createApp())
        .post('/api/orders/preview')
        .set(h(token))
        .send({ items: [{ skuId: sku1Id, quantity: 1 }], addressId: otherAddrId });
      expect(res.status).toBe(404);
    });
  });

  describe('create 事务', () => {
    it('成功创建：orderNo 格式、返回 totalAmount、状态 PENDING_PAYMENT、库存扣减、购物车清空', async () => {
      const { token, addrId } = await makeUser('u13-c1');
      const app = createApp();
      await request(app).post('/api/cart').set(h(token)).send({ skuId: sku1Id, quantity: 3 });
      await request(app).post('/api/cart').set(h(token)).send({ skuId: sku2Id, quantity: 2 });

      const res = await request(app)
        .post('/api/orders')
        .set(h(token))
        .send({ items: [{ skuId: sku1Id, quantity: 2 }, { skuId: sku2Id, quantity: 2 }], addressId: addrId, remark: '尽快发货' });
      expect(res.status).toBe(200);
      const orderNo = res.body.data.orderNo as string;
      expect(orderNo).toMatch(/^NPA\d{16}$/);
      // I2：创建响应必须带 totalAmount（支付结果页展示金额用）
      expect(res.body.data.totalAmount).toBe(19900 * 2 + 1500 * 2);

      const sku1 = await prisma.sku.findUnique({ where: { id: sku1Id } });
      const sku2 = await prisma.sku.findUnique({ where: { id: sku2Id } });
      expect(sku1!.stock).toBe(8);
      expect(sku2!.stock).toBe(3);

      const cart = await request(app).get('/api/cart').set(h(token));
      expect(cart.body.data.list).toHaveLength(0); // 下单后对应 SKU 条目从购物车移除
    });

    it('fromCart:false（立即购买）不清空购物车（m2）', async () => {
      const { token, addrId } = await makeUser('u13-c6');
      const app = createApp();
      await request(app).post('/api/cart').set(h(token)).send({ skuId: sku1Id, quantity: 3 });
      const res = await request(app)
        .post('/api/orders')
        .set(h(token))
        .send({ items: [{ skuId: sku1Id, quantity: 1 }], addressId: addrId, fromCart: false });
      expect(res.status).toBe(200);
      const cart = await request(app).get('/api/cart').set(h(token));
      expect(cart.body.data.list).toHaveLength(1); // 立即购买不触动购物车
      expect(cart.body.data.list[0].quantity).toBe(3);
    });

    it('快照：下单后改 SKU 价，旧订单仍旧价（Review Focus #3）', async () => {
      const { token, addrId } = await makeUser('u13-c2');
      const app = createApp();
      const res = await request(app)
        .post('/api/orders')
        .set(h(token))
        .send({ items: [{ skuId: sku1Id, quantity: 1 }], addressId: addrId });
      const orderNo = res.body.data.orderNo;
      await prisma.sku.update({ where: { id: sku1Id }, data: { price: 29900 } });
      const detail = await request(app).get(`/api/orders/${orderNo}`).set(h(token));
      expect(detail.body.data.items[0].price).toBe(19900);
      expect(detail.body.data.totalAmount).toBe(19900);
    });

    it('库存不足 → 412 STOCK_NOT_ENOUGH 且无脏订单（事务回滚，Review Focus #1）', async () => {
      const { token, addrId } = await makeUser('u13-c3');
      const app = createApp();
      const before = await prisma.order.count();
      const res = await request(app)
        .post('/api/orders')
        .set(h(token))
        .send({ items: [{ skuId: sku1Id, quantity: 99 }], addressId: addrId });
      expect(res.status).toBe(412);
      expect(res.body.code).toBe('STOCK_NOT_ENOUGH');
      const sku1 = await prisma.sku.findUnique({ where: { id: sku1Id } });
      expect(sku1!.stock).toBe(10);
      expect(await prisma.order.count()).toBe(before);
      const list = await request(app).get('/api/orders').set(h(token));
      expect(list.body.data.list).toHaveLength(0);
    });

    it('订单含地址快照（JSON 解析）', async () => {
      const { token, addrId } = await makeUser('u13-c4');
      const app = createApp();
      const res = await request(app)
        .post('/api/orders')
        .set(h(token))
        .send({ items: [{ skuId: sku1Id, quantity: 1 }], addressId: addrId });
      const detail = await request(app).get(`/api/orders/${res.body.data.orderNo}`).set(h(token));
      expect(detail.body.data.address.receiverName).toBe('张三');
      expect(detail.body.data.address.detail).toBe('科技园路 1 号');
    });

    it('已下架商品的 SKU → 404', async () => {
      const { token, addrId } = await makeUser('u13-c5');
      await prisma.product.update({ where: { id: (await prisma.sku.findUnique({ where: { id: sku1Id } }))!.productId }, data: { status: 'OFF' } });
      const res = await request(createApp())
        .post('/api/orders')
        .set(h(token))
        .send({ items: [{ skuId: sku1Id, quantity: 1 }], addressId: addrId });
      expect(res.status).toBe(404);
    });
  });

  describe('状态机 pay/cancel/confirm', () => {
    it('pay（模拟支付 provider=mock）：PENDING_PAYMENT → PAID，记录 paidAt，销量+quantity', async () => {
      const { token, addrId } = await makeUser('u13-s1');
      const { app, orderNo } = await createOrder(token, addrId, [{ skuId: sku1Id, quantity: 2 }]);
      const res = await request(app).post(`/api/orders/${orderNo}/pay`).set(h(token));
      expect(res.status).toBe(200);
      // 支付返回结构：{ provider, paid, order }（wechatpay 时 paid=false 且带 payment 参数）
      expect(res.body.data.provider).toBe('mock');
      expect(res.body.data.paid).toBe(true);
      expect(res.body.data.order.status).toBe('PAID');
      expect(res.body.data.order.paidAt).toBeTruthy();
      const product = await prisma.product.findUnique({
        where: { id: (await prisma.sku.findUnique({ where: { id: sku1Id } }))!.productId },
      });
      expect(product!.salesCount).toBe(2);
    });

    // 幂等而非报错：用户付完款后再点一次支付（重复点击、回调刚到、从列表点「去支付」），
    // 必须直接回「已支付」，绝不能返回 409 —— 那会让付过钱的用户看到报错。
    // 真资损红线是「重复扣款」，而这里没有再次下单，只是把当前状态如实返回。
    it('已支付订单再次支付 → 返回 paid:true（幂等，不报错）', async () => {
      const { token, addrId } = await makeUser('u13-s2');
      const { app, orderNo } = await createOrder(token, addrId, [{ skuId: sku1Id, quantity: 1 }]);
      await request(app).post(`/api/orders/${orderNo}/pay`).set(h(token));
      const res = await request(app).post(`/api/orders/${orderNo}/pay`).set(h(token));
      expect(res.status).toBe(200);
      expect(res.body.data.paid).toBe(true);
      // 订单仍然只有一笔已支付，金额没有被重复累加
      const order = await prisma.order.findUnique({ where: { orderNo } });
      expect(order?.status).toBe('PAID');
    });

    it('cancel：PENDING_PAYMENT → CANCELLED 且回滚库存', async () => {
      const { token, addrId } = await makeUser('u13-s3');
      const { app, orderNo } = await createOrder(token, addrId, [{ skuId: sku1Id, quantity: 3 }]);
      const res = await request(app).post(`/api/orders/${orderNo}/cancel`).set(h(token));
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('CANCELLED');
      const sku1 = await prisma.sku.findUnique({ where: { id: sku1Id } });
      expect(sku1!.stock).toBe(10);
    });

    it('取消已支付订单 → 409', async () => {
      const { token, addrId } = await makeUser('u13-s4');
      const { app, orderNo } = await createOrder(token, addrId, [{ skuId: sku1Id, quantity: 1 }]);
      await request(app).post(`/api/orders/${orderNo}/pay`).set(h(token));
      const res = await request(app).post(`/api/orders/${orderNo}/cancel`).set(h(token));
      expect(res.status).toBe(409);
    });

    it('非 SHIPPED 确认收货 → 409', async () => {
      const { token, addrId } = await makeUser('u13-s5');
      const { app, orderNo } = await createOrder(token, addrId, [{ skuId: sku1Id, quantity: 1 }]);
      const res = await request(app).post(`/api/orders/${orderNo}/confirm`).set(h(token));
      expect(res.status).toBe(409);
    });

    it('SHIPPED 确认收货 → COMPLETED（直接置 SHIPPED 模拟发货）', async () => {
      const { token, addrId } = await makeUser('u13-s6');
      const { app, orderNo } = await createOrder(token, addrId, [{ skuId: sku1Id, quantity: 1 }]);
      await prisma.order.update({ where: { orderNo }, data: { status: 'SHIPPED', shippedAt: new Date() } });
      const res = await request(app).post(`/api/orders/${orderNo}/confirm`).set(h(token));
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('COMPLETED');
      expect(res.body.data.completedAt).toBeTruthy();
    });

    it('操作他人订单 → 404', async () => {
      const { token, addrId } = await makeUser('u13-s7');
      const { orderNo } = await createOrder(token, addrId, [{ skuId: sku1Id, quantity: 1 }]);
      const { token: other } = await makeUser('u13-s8');
      const pay = await request(createApp()).post(`/api/orders/${orderNo}/pay`).set(h(other));
      expect(pay.status).toBe(404);
      const detail = await request(createApp()).get(`/api/orders/${orderNo}`).set(h(other));
      expect(detail.status).toBe(404);
    });
  });

  describe('过期订单自动取消（m8）', () => {
    it('超过 N 分钟未支付 → 扫单取消并回滚库存；未到期不受影响', async () => {
      const { token, addrId } = await makeUser('u13-e1');
      const app = createApp();
      // 一笔老订单：回拨 createdAt 到 61 分钟前（> 默认 30 分钟）
      const old = await request(app).post('/api/orders').set(h(token)).send({ items: [{ skuId: sku1Id, quantity: 3 }], addressId: addrId });
      await prisma.order.update({
        where: { orderNo: old.body.data.orderNo },
        data: { createdAt: new Date(Date.now() - 61 * 60000) },
      });
      // 一笔新订单：保持当前时间
      const fresh = await request(app).post('/api/orders').set(h(token)).send({ items: [{ skuId: sku2Id, quantity: 1 }], addressId: addrId });

      const cancelled = await cancelExpiredOrders(30);
      expect(cancelled).toBe(1);

      const oldDetail = await request(app).get(`/api/orders/${old.body.data.orderNo}`).set(h(token));
      expect(oldDetail.body.data.status).toBe('CANCELLED');
      expect(oldDetail.body.data.cancelledAt).toBeTruthy();
      // 库存回滚：10 - 3 + 3 = 10
      const sku1 = await prisma.sku.findUnique({ where: { id: sku1Id } });
      expect(sku1!.stock).toBe(10);

      const freshDetail = await request(app).get(`/api/orders/${fresh.body.data.orderNo}`).set(h(token));
      expect(freshDetail.body.data.status).toBe('PENDING_PAYMENT');
    });
  });

  describe('查询', () => {
    it('列表初始为空 + 分页结构', async () => {
      const { token } = await makeUser('u13-q1');
      const res = await request(createApp()).get('/api/orders').set(h(token));
      expect(res.status).toBe(200);
      expect(res.body.data.list).toEqual([]);
      expect(res.body.data.total).toBe(0);
    });

    it('列表按 status 过滤 + 分页', async () => {
      const { token, addrId } = await makeUser('u13-q2');
      const app = createApp();
      const o1 = await request(app).post('/api/orders').set(h(token)).send({ items: [{ skuId: sku1Id, quantity: 1 }], addressId: addrId });
      const o2 = await request(app).post('/api/orders').set(h(token)).send({ items: [{ skuId: sku2Id, quantity: 1 }], addressId: addrId });
      await request(app).post(`/api/orders/${o1.body.data.orderNo}/pay`).set(h(token));

      const paid = await request(app).get('/api/orders?status=PAID').set(h(token));
      expect(paid.body.data.total).toBe(1);
      expect(paid.body.data.list[0].orderNo).toBe(o1.body.data.orderNo);

      const all = await request(app).get('/api/orders?page=1&size=1').set(h(token));
      expect(all.body.data.list).toHaveLength(1);
      expect(all.body.data.total).toBe(2);
      // 最新在前
      expect(all.body.data.list[0].orderNo).toBe(o2.body.data.orderNo);
    });

    it('详情返回 items 与状态', async () => {
      const { token, addrId } = await makeUser('u13-q3');
      const app = createApp();
      const res = await request(app).post('/api/orders').set(h(token)).send({ items: [{ skuId: sku1Id, quantity: 2 }], addressId: addrId });
      const detail = await request(app).get(`/api/orders/${res.body.data.orderNo}`).set(h(token));
      expect(detail.body.data.status).toBe('PENDING_PAYMENT');
      expect(detail.body.data.items[0].productName).toBe('鸡肉猫粮');
      expect(detail.body.data.items[0].quantity).toBe(2);
    });

    it('不存在的 orderNo → 404', async () => {
      const { token } = await makeUser('u13-q4');
      const res = await request(createApp()).get('/api/orders/NPA0000000000000000').set(h(token));
      expect(res.status).toBe(404);
    });
  });
});
