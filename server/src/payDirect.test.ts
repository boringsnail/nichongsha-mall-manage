import crypto from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from './db.js';

// 微信支付 APIv3 直连：签名 / 验签 / AES-GCM 解密 / 回调落库
// 用自签密钥模拟「商户私钥」与「微信支付平台公钥」，无需真实证书即可覆盖全部密码学路径。

const merchant = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const platform = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const merchantPem = merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const platformPubPem = platform.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const API_V3_KEY = 'abcdefghijklmnopqrstuvwxyz123456'; // 必须 32 位
const PLATFORM_KEY_ID = 'PUB_KEY_ID_TEST';
const ORDER_NO = 'NPA' + '7'.repeat(16);

function stubDirectPayEnv() {
  vi.stubEnv('PAY_PROVIDER', 'wechatpay-direct');
  vi.stubEnv('WXPAY_MCHID', '1001619740');
  vi.stubEnv('WXPAY_SERIAL_NO', 'SERIAL_TEST');
  vi.stubEnv('WXPAY_PRIVATE_KEY', merchantPem);
  vi.stubEnv('WXPAY_API_V3_KEY', API_V3_KEY);
  vi.stubEnv('WXPAY_PLATFORM_PUBLIC_KEY', platformPubPem);
  vi.stubEnv('WXPAY_PLATFORM_PUBLIC_KEY_ID', PLATFORM_KEY_ID);
  vi.stubEnv('WXPAY_NOTIFY_URL', 'https://example.com/api/pay/notify');
  vi.stubEnv('WX_APPID', 'wxce86198b133baa5e');
}

/** 按微信支付规则加密 resource（AES-256-GCM，密文尾部 16 字节为 tag） */
function encryptResource(plain: Record<string, unknown>) {
  const nonce = crypto.randomBytes(6).toString('hex');
  const aad = 'transaction';
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(API_V3_KEY, 'utf8'), Buffer.from(nonce, 'utf8'));
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  return {
    algorithm: 'AEAD_AES_256_GCM',
    ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64'),
    nonce,
    associated_data: aad,
  };
}

function buildNotifyBody(tradeState = 'SUCCESS') {
  const resource = encryptResource({
    out_trade_no: ORDER_NO,
    transaction_id: '4200009999202610160000000001',
    trade_state: tradeState,
    trade_state_desc: '支付成功',
  });
  const body = JSON.stringify({ id: 'evt-1', event_type: 'TRANSACTION.SUCCESS', resource });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = 'notifynonce123456';
  const signature = crypto
    .sign('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${body}\n`), platform.privateKey)
    .toString('base64');
  return { body, headers: { timestamp, nonce, signature, serial: PLATFORM_KEY_ID } };
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

async function seedOrder() {
  await cleanup();
  const category = await prisma.category.create({ data: { name: '直连支付测试' } });
  const product = await prisma.product.create({
    data: { name: '直连支付商品', coverImage: 'x', categoryId: category.id, minPrice: 100 },
  });
  const sku = await prisma.sku.create({ data: { productId: product.id, specName: '默认', price: 100, stock: 5 } });
  const user = await prisma.user.create({ data: { openid: 'pay-direct-user' } });
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

describe('APIv3 直连：JSAPI 下单', () => {
  it('构造合规的 Authorization 头与请求体，并返回可校验的 wx.requestPayment 参数', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: { headers: Record<string, string>; body: string }) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ prepay_id: 'wx201410272009395522657a690389285100' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
    stubDirectPayEnv();

    const { jsapiPrepay } = await import('./services/wechatpayV3Service.js');
    const payment = await jsapiPrepay({ orderNo: ORDER_NO, totalFee: 200, body: '测试商品', openid: 'o1' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi');
    const auth = init.headers.Authorization;
    expect(auth).toContain('WECHATPAY2-SHA256-RSA2048');
    expect(auth).toContain('mchid="1001619740"');
    expect(auth).toContain('serial_no="SERIAL_TEST"');
    expect(JSON.parse(init.body)).toMatchObject({
      appid: 'wxce86198b133baa5e',
      mchid: '1001619740',
      out_trade_no: ORDER_NO,
      notify_url: 'https://example.com/api/pay/notify',
      amount: { total: 200, currency: 'CNY' },
      payer: { openid: 'o1' },
    });

    // 返回给前端的支付参数必须能用商户公钥验签通过（signType=RSA）
    expect(payment.package).toBe('prepay_id=wx201410272009395522657a690389285100');
    expect(payment.signType).toBe('RSA');
    const verified = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${payment.appId}\n${payment.timeStamp}\n${payment.nonceStr}\n${payment.package}\n`),
      merchant.publicKey,
      Buffer.from(payment.paySign, 'base64'),
    );
    expect(verified).toBe(true);
  });
});

describe('APIv3 直连：支付结果通知', () => {
  it('验签 + 解密成功 → 订单置为已支付、写入交易号，并响应 {code:SUCCESS}', async () => {
    const { productId } = await seedOrder();
    vi.resetModules();
    stubDirectPayEnv();
    const { createApp } = await import('./app.js');
    const app = createApp();

    const { body, headers } = buildNotifyBody('SUCCESS');
    const res = await request(app)
      .post('/api/pay/notify')
      .set('Wechatpay-Timestamp', headers.timestamp)
      .set('Wechatpay-Nonce', headers.nonce)
      .set('Wechatpay-Signature', headers.signature)
      .set('Wechatpay-Serial', headers.serial)
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.code).toBe('SUCCESS');
    const order = await prisma.order.findUniqueOrThrow({ where: { orderNo: ORDER_NO } });
    expect(order.status).toBe('PAID');
    expect(order.paymentNo).toBe('4200009999202610160000000001');
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).salesCount).toBe(2);
  });

  it('签名被篡改 → 401 且订单状态不变（防伪造回调）', async () => {
    await seedOrder();
    vi.resetModules();
    stubDirectPayEnv();
    const { createApp } = await import('./app.js');
    const app = createApp();

    const { body, headers } = buildNotifyBody('SUCCESS');
    const res = await request(app)
      .post('/api/pay/notify')
      .set('Wechatpay-Timestamp', headers.timestamp)
      .set('Wechatpay-Nonce', headers.nonce)
      .set('Wechatpay-Signature', Buffer.from('fake-signature').toString('base64'))
      .set('Wechatpay-Serial', headers.serial)
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(401);
    const order = await prisma.order.findUniqueOrThrow({ where: { orderNo: ORDER_NO } });
    expect(order.status).toBe('PENDING_PAYMENT');
  });

  it('重复通知 → 幂等：仍返回成功且销量不重复累加', async () => {
    const { productId } = await seedOrder();
    vi.resetModules();
    stubDirectPayEnv();
    const { createApp } = await import('./app.js');
    const app = createApp();

    const { body, headers } = buildNotifyBody('SUCCESS');
    const send = () =>
      request(app)
        .post('/api/pay/notify')
        .set('Wechatpay-Timestamp', headers.timestamp)
        .set('Wechatpay-Nonce', headers.nonce)
        .set('Wechatpay-Signature', headers.signature)
        .set('Wechatpay-Serial', headers.serial)
        .set('Content-Type', 'application/json')
        .send(body);

    await send();
    const second = await send();
    expect(second.status).toBe(200);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).salesCount).toBe(2);
  });
});
