import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../db';
import { signMerchantToken } from '../auth/jwt';
import { hashPassword } from '../auth/password';
import { MEDIA_MAX_BYTES } from '../services/mediaService';

/**
 * 商品图片上传与回图。
 *
 * 关键约定：
 *  - 上传要商家登录态，读图必须公开（<img src> 带不了 Authorization 头）
 *  - 只收位图（jpg/png/webp/gif），SVG 拒绝
 *  - 同内容（sha256 相同）复用同一条记录，不重复占空间
 *  - 超过 1.5MB 直接 400，不静默截断
 */

let merchantToken: string;

function api() {
  return request(createApp());
}

/** 一张 1×1 的透明 PNG，够小、真实、base64 合法 */
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 构造任意字节数的 JPEG（头部魔数正确即可，服务端只按 mime 字段判断） */
function fakeJpeg(bytes: number): string {
  const buf = Buffer.alloc(bytes, 0xff);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

beforeEach(async () => {
  await prisma.mediaAsset.deleteMany();
  await prisma.merchant.deleteMany();
  const m = await prisma.merchant.create({ data: { username: 'merchant', passwordHash: await hashPassword('x') } });
  merchantToken = signMerchantToken(m.id);
});

describe('POST /api/admin/media', () => {
  it('上传 PNG 后返回 id 与 url，落库字节与 mime 正确', async () => {
    const res = await api()
      .post('/api/admin/media')
      .set('Authorization', `Bearer ${merchantToken}`)
      .send({ dataUrl: PNG_1PX, width: 1, height: 1 });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.id).toBeGreaterThan(0);
    // url 是绝对地址（存进商品后小程序能直接用），path 是相对路径
    expect(res.body.data.path).toBe(`/api/media/${res.body.data.id}`);
    expect(res.body.data.url).toMatch(/^https?:\/\/127\.0\.0\.1:\d+\/api\/media\/\d+$/);
    expect(res.body.data.mime).toBe('image/png');
    expect(res.body.data.width).toBe(1);
    expect(res.body.data.reused).toBe(false);

    const row = await prisma.mediaAsset.findUnique({ where: { id: res.body.data.id } });
    expect(row?.mime).toBe('image/png');
    expect(row?.byteSize).toBe(Buffer.from(PNG_1PX.split(',')[1], 'base64').length);
    expect(row?.data.length).toBe(row?.byteSize);
  });

  it('同一张图重复上传复用记录（sha256 去重）', async () => {
    const first = await api()
      .post('/api/admin/media')
      .set('Authorization', `Bearer ${merchantToken}`)
      .send({ dataUrl: PNG_1PX });
    const second = await api()
      .post('/api/admin/media')
      .set('Authorization', `Bearer ${merchantToken}`)
      .send({ dataUrl: PNG_1PX });

    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.reused).toBe(true);
    expect(await prisma.mediaAsset.count()).toBe(1);
  });

  it('未登录 401', async () => {
    const res = await api().post('/api/admin/media').send({ dataUrl: PNG_1PX });
    expect(res.status).toBe(401);
    expect(await prisma.mediaAsset.count()).toBe(0);
  });

  it('非 data URL → 400，且不落库', async () => {
    const res = await api()
      .post('/api/admin/media')
      .set('Authorization', `Bearer ${merchantToken}`)
      .send({ dataUrl: 'https://p0.meituan.net/retailsp/23e.jpg' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MEDIA_BAD_DATA_URL');
    expect(await prisma.mediaAsset.count()).toBe(0);
  });

  it('SVG 被拒绝', async () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`;
    const res = await api()
      .post('/api/admin/media')
      .set('Authorization', `Bearer ${merchantToken}`)
      .send({ dataUrl: svg });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MEDIA_BAD_MIME');
  });

  it('超过 1.5MB 拒绝', async () => {
    const res = await api()
      .post('/api/admin/media')
      .set('Authorization', `Bearer ${merchantToken}`)
      .send({ dataUrl: fakeJpeg(MEDIA_MAX_BYTES + 1024) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MEDIA_TOO_LARGE');
    expect(await prisma.mediaAsset.count()).toBe(0);
  });

  it('x-forwarded-* 优先：网关后也能拼出 https 绝对地址', async () => {
    const res = await api()
      .post('/api/admin/media')
      .set('Authorization', `Bearer ${merchantToken}`)
      .set('x-forwarded-host', 'mall-admin-web.example.com')
      .set('x-forwarded-proto', 'https')
      .send({ dataUrl: PNG_1PX });
    expect(res.body.data.url).toBe(`https://mall-admin-web.example.com/api/media/${res.body.data.id}`);
  });

  it('刚好 1.5MB 可以过', async () => {
    const res = await api()
      .post('/api/admin/media')
      .set('Authorization', `Bearer ${merchantToken}`)
      .send({ dataUrl: fakeJpeg(MEDIA_MAX_BYTES) });
    expect(res.status).toBe(200);
    expect(res.body.data.byteSize).toBe(MEDIA_MAX_BYTES);
  });
});

describe('GET /api/media/:id', () => {
  it('公开可读，返回原始字节与长缓存头', async () => {
    const up = await api()
      .post('/api/admin/media')
      .set('Authorization', `Bearer ${merchantToken}`)
      .send({ dataUrl: PNG_1PX });

    // 故意不带 Authorization：前端 <img src> 就是这个情形
    const res = await api().get(`/api/media/${up.body.data.id}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body.length).toBe(Buffer.from(PNG_1PX.split(',')[1], 'base64').length);
  });

  it('不存在的 id → 404', async () => {
    const res = await api().get('/api/media/999999');
    expect(res.status).toBe(404);
  });

  it('非法 id → 400', async () => {
    const res = await api().get('/api/media/abc');
    expect(res.status).toBe(400);
  });
});
