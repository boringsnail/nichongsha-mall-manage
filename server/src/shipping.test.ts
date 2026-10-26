import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from './db.js';

// 订单发货管理：发货信息上报（实物交易合规）
// 校验点：access_token 复用、上报报文结构、快递公司名称→编码映射、订单缺物流信息时跳过

const ORDER_NO = 'NPA' + '6'.repeat(16);

// 微信侧响应在服务里用 res.text() 再 JSON.parse（非 JSON 也要能兜住），
// 所以 mock 必须同时提供 text()，只给 json() 会直接抛 "res.text is not a function"。
const fakeRes = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function stubWxEnv() {
  vi.stubEnv('WX_APPID', 'wxce86198b133baa5e');
  vi.stubEnv('WX_APPSECRET', '6514918f4240695d870a1cc1058c3abd');
}

async function cleanup() {
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

async function seedShippedOrder(opts: { withTracking: boolean }) {
  await cleanup();
  const category = await prisma.category.create({ data: { name: '发货测试' } });
  const product = await prisma.product.create({
    data: { name: '发货测试商品', coverImage: 'x', categoryId: category.id, minPrice: 100 },
  });
  const sku = await prisma.sku.create({ data: { productId: product.id, specName: '默认', price: 100, stock: 5 } });
  const user = await prisma.user.create({ data: { openid: 'shipping-user' } });
  await prisma.order.create({
    data: {
      orderNo: ORDER_NO,
      userId: user.id,
      totalAmount: 100,
      addressSnapshot: JSON.stringify({ receiverName: '张三', phone: '13800000000' }),
      status: 'SHIPPED',
      paymentNo: '4200001234202610160000000009',
      logisticsCompany: opts.withTracking ? '顺丰速运' : null,
      trackingNo: opts.withTracking ? 'SF1234567890' : null,
      items: {
        create: [{
          productId: product.id,
          skuId: sku.id,
          productName: product.name,
          specName: '默认',
          coverImage: 'x',
          price: 100,
          quantity: 1,
        }],
      },
    },
  });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  await cleanup();
});

describe('快递公司名称映射', () => {
  it('常见中文名映射为微信物流公司编码，未命中则原样返回', async () => {
    vi.resetModules();
    const { resolveExpressCompany } = await import('./services/shippingService.js');
    expect(resolveExpressCompany('顺丰速运')).toBe('SF');
    expect(resolveExpressCompany('中通快递')).toBe('ZTO');
    expect(resolveExpressCompany('极兔速递')).toBe('JT');
    expect(resolveExpressCompany('SF')).toBe('SF');
    expect(resolveExpressCompany('某小众快递')).toBe('某小众快递');
  });
});

describe('发货信息上报', () => {
  it('取 access_token 后按微信协议上报（含 order_key/payer/logistics_type）', async () => {
    await seedShippedOrder({ withTracking: true });
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ?? '' });
      if (String(url).includes('/cgi-bin/stable_token')) {
        return fakeRes({ access_token: 'TOKEN-1', expires_in: 7200 });
      }
      return fakeRes({ errcode: 0, errmsg: 'ok' });
    }));
    vi.resetModules();
    stubWxEnv();

    const { uploadShippingInfo } = await import('./services/shippingService.js');
    const result = await uploadShippingInfo(ORDER_NO);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('/cgi-bin/stable_token');
    expect(calls[1].url).toContain('/wxa/sec/order/upload_shipping_info');
    const payload = JSON.parse(calls[1].body);
    expect(payload.order_key).toEqual({ order_number_type: 2, transaction_id: '4200001234202610160000000009' });
    expect(payload.payer).toEqual({ openid: 'shipping-user' });
    expect(payload.logistics_type).toBe(1);
    expect(payload.delivery_mode).toBe(1);
    expect(payload.shipping_list[0]).toMatchObject({ tracking_no: 'SF1234567890', express_company: 'SF' });
    expect(payload.upload_time).toMatch(/\+08:00$/);
  });

  it('access_token 命中缓存：二次上报不重复取 token', async () => {
    await seedShippedOrder({ withTracking: true });
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      if (String(url).includes('/cgi-bin/stable_token')) {
        return fakeRes({ access_token: 'TOKEN-CACHE', expires_in: 7200 });
      }
      return fakeRes({ errcode: 0, errmsg: 'ok' });
    }));
    vi.resetModules();
    stubWxEnv();

    const { uploadShippingInfo } = await import('./services/shippingService.js');
    await uploadShippingInfo(ORDER_NO);
    await uploadShippingInfo(ORDER_NO);

    expect(calls.filter((u) => u.includes('/cgi-bin/stable_token'))).toHaveLength(1);
  });

  it('订单缺物流单号 → 跳过上报（不调用微信）', async () => {
    await seedShippedOrder({ withTracking: false });
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      return fakeRes({ errcode: 0 });
    }));
    vi.resetModules();
    stubWxEnv();

    const { uploadShippingInfo } = await import('./services/shippingService.js');
    const result = await uploadShippingInfo(ORDER_NO);
    expect(result.ok).toBe(false);
    expect(result.skipped).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('微信返回非 0 → 透出错误但不抛异常（发货本身不受影响）', async () => {
    await seedShippedOrder({ withTracking: true });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/cgi-bin/stable_token')) {
        return fakeRes({ access_token: 'T', expires_in: 7200 });
      }
      return fakeRes({ errcode: 9300502, errmsg: '物流公司编码有误' });
    }));
    vi.resetModules();
    stubWxEnv();

    const { uploadShippingInfo } = await import('./services/shippingService.js');
    const result = await uploadShippingInfo(ORDER_NO);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('9300502');
  });
});
