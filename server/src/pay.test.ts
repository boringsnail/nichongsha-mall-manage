import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from './db.js';

// 生产支付链路回归：云调用统一下单 + 支付结果回调（防伪造 / 幂等 / 落库）

const ORDER_NO = 'NPA' + '9'.repeat(16);

async function appWithWechatPay() {
  vi.resetModules();
  vi.stubEnv('PAY_PROVIDER', 'wechatpay');
  vi.stubEnv('WXPAY_SUB_MCHID', '1712734762');
  vi.stubEnv('WXPAY_ENV_ID', 'prod-d3gmusgcw6e97148b');
  vi.stubEnv('WXPAY_NOTIFY_SERVICE', 'ncspetmall');
  const { createApp } = await import('./app.js');
  return createApp();
}

/** 模拟云调用查单返回 */
function mockQueryOrder(tradeState: string, transactionId = '4200001234567890') {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    json: async () => ({
      errcode: 0,
      errmsg: 'ok',
      respdata: { return_code: 'SUCCESS', result_code: 'SUCCESS', trade_state: tradeState, transaction_id: transactionId },
    }),
  })));
}

async function cleanup() {
  // 顺序必须满足外键依赖：先删引用方，最后删 User（Address/Cart/Order 都带 userId 外键）
  await prisma.cart.deleteMany();
  await prisma.orderItem.deleteMany();
  // 售后单引用 Order/User，必须先删，否则外键约束会挡住
  await prisma.afterSale.deleteMany();
  await prisma.order.deleteMany();
  await prisma.address.deleteMany();
  await prisma.sku.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.user.deleteMany();
}

/** 造一个「待付款」订单（含 1 个商品 × 2 件），用于回调落库断言 */
async function seedOrder() {
  await cleanup();
  const category = await prisma.category.create({ data: { name: '支付测试分类' } });
  const product = await prisma.product.create({
    data: { name: '支付测试商品', coverImage: 'x', categoryId: category.id, minPrice: 100 },
  });
  const sku = await prisma.sku.create({ data: { productId: product.id, specName: '默认', price: 100, stock: 10 } });
  const user = await prisma.user.create({ data: { openid: 'pay-test-user' } });
  await prisma.order.create({
    data: {
      orderNo: ORDER_NO,
      userId: user.id,
      totalAmount: 200,
      addressSnapshot: '{}',
      items: {
        create: [{
          productId: product.id,
          skuId: sku.id,
          productName: product.name,
          specName: '默认',
          coverImage: 'x',
          price: 100,
          quantity: 2,
        }],
      },
    },
  });
  return { productId: product.id };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  await cleanup();
});

describe('支付结果回调 POST /api/pay/notify', () => {
  it('伪造回调（主动查单显示未支付）→ 不落库、返回非 0', async () => {
    const { productId } = await seedOrder();
    mockQueryOrder('NOTPAY');
    const app = await appWithWechatPay();

    const res = await request(app).post('/api/pay/notify').send({ outTradeNo: ORDER_NO });
    expect(res.body.errcode).not.toBe(0);

    const order = await prisma.order.findUniqueOrThrow({ where: { orderNo: ORDER_NO } });
    expect(order.status).toBe('PENDING_PAYMENT');
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).salesCount).toBe(0);
  });

  it('真实回调（查单 SUCCESS）→ 置为已支付 + 写交易号 + 累加销量', async () => {
    const { productId } = await seedOrder();
    mockQueryOrder('SUCCESS');
    const app = await appWithWechatPay();

    const res = await request(app).post('/api/pay/notify').send({ outTradeNo: ORDER_NO });
    expect(res.body.errcode).toBe(0);

    const order = await prisma.order.findUniqueOrThrow({ where: { orderNo: ORDER_NO } });
    expect(order.status).toBe('PAID');
    expect(order.paidAt).toBeTruthy();
    expect(order.paymentNo).toBe('4200001234567890');
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).salesCount).toBe(2);
  });

  it('重复回调 → 幂等：销量不重复累加且仍返回成功', async () => {
    const { productId } = await seedOrder();
    mockQueryOrder('SUCCESS');
    const app = await appWithWechatPay();

    await request(app).post('/api/pay/notify').send({ outTradeNo: ORDER_NO });
    const second = await request(app).post('/api/pay/notify').send({ outTradeNo: ORDER_NO });

    expect(second.body.errcode).toBe(0);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).salesCount).toBe(2);
  });

  it('缺少 outTradeNo → 返回非 0（平台会重试）', async () => {
    const app = await appWithWechatPay();
    const res = await request(app).post('/api/pay/notify').send({ foo: 'bar' });
    expect(res.body.errcode).not.toBe(0);
  });
});

describe('云调用统一下单', () => {
  it('请求体带商户号/环境/回调服务，并原样返回 payment 参数', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: { body: string }) => ({
      json: async () => ({
        errcode: 0,
        errmsg: 'ok',
        respdata: {
          return_code: 'SUCCESS',
          result_code: 'SUCCESS',
          payment: { appId: 'wx1', timeStamp: '1', nonceStr: 'n', package: 'prepay_id=x', signType: 'MD5', paySign: 's' },
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
    vi.stubEnv('PAY_PROVIDER', 'wechatpay');
    vi.stubEnv('WXPAY_SUB_MCHID', '1712734762');
    vi.stubEnv('WXPAY_ENV_ID', 'prod-env');
    vi.stubEnv('WXPAY_NOTIFY_SERVICE', 'svc');

    const { unifiedOrder } = await import('./services/payService.js');
    const payment = await unifiedOrder({ orderNo: 'NPA1', totalFee: 199, body: '测试', openid: 'o1', clientIp: '1.2.3.4' });

    expect(payment.package).toBe('prepay_id=x');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/_/pay/unifiedOrder');
    expect(JSON.parse(init.body)).toMatchObject({
      sub_mch_id: '1712734762',
      env_id: 'prod-env',
      total_fee: 199,
      openid: 'o1',
      callback_type: 2,
      container: { service: 'svc', path: '/api/pay/notify' },
    });
  });

  it('errcode=0 但 prepay_id 为空（商户号未完成服务商授权）→ 502，不透传无效支付参数', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({
        errcode: 0,
        errmsg: 'ok',
        respdata: {
          return_code: 'SUCCESS',
          result_code: 'FAIL',
          err_code_des: '受理关系不存在',
          payment: { appId: 'wx1', timeStamp: '1', nonceStr: 'n', package: 'prepay_id=', signType: 'MD5', paySign: 's' },
        },
      }),
    })));
    vi.resetModules();
    vi.stubEnv('PAY_PROVIDER', 'wechatpay');
    vi.stubEnv('WXPAY_SUB_MCHID', '1712734762');
    vi.stubEnv('WXPAY_ENV_ID', 'prod-env');
    vi.stubEnv('WXPAY_NOTIFY_SERVICE', 'svc');

    const { unifiedOrder } = await import('./services/payService.js');
    await expect(
      unifiedOrder({ orderNo: 'NPA3', totalFee: 1, body: 'b', openid: 'o', clientIp: '1.1.1.1' }),
    ).rejects.toMatchObject({ status: 502, code: 'PAY_UNAVAILABLE' });
  });

  it('云调用返回非 0 errcode → 502 PAY_UNAVAILABLE（不吞错）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ errcode: 40001, errmsg: 'invalid credential' }),
    })));
    vi.resetModules();
    vi.stubEnv('PAY_PROVIDER', 'wechatpay');
    vi.stubEnv('WXPAY_SUB_MCHID', '1712734762');
    vi.stubEnv('WXPAY_ENV_ID', 'prod-env');
    vi.stubEnv('WXPAY_NOTIFY_SERVICE', 'svc');

    const { unifiedOrder } = await import('./services/payService.js');
    await expect(
      unifiedOrder({ orderNo: 'NPA2', totalFee: 1, body: 'b', openid: 'o', clientIp: '1.1.1.1' }),
    ).rejects.toMatchObject({ status: 502, code: 'PAY_UNAVAILABLE' });
  });
});
