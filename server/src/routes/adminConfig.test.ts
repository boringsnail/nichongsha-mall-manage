import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../db';
import { signMerchantToken } from '../auth/jwt';
import { hashPassword } from '../auth/password';
import { refreshConfigCache } from '../services/configService';

/**
 * 配置管理（公告 + 退款自动同意时长）。
 *
 * 这组配置是商家在后台自己改的，不走环境变量；改完必须立刻对
 * ①后台配置页 ②C 端公告接口 ③售后超时判定 三处同时生效，
 * 所以每个用例写完都顺手断言另外两处，避免只改了一半。
 */

let merchantToken: string;

beforeEach(async () => {
  await prisma.appConfig.deleteMany();
  await prisma.merchant.deleteMany();

  const m = await prisma.merchant.create({
    data: { username: 'merchant', passwordHash: await hashPassword('x') },
  });
  merchantToken = signMerchantToken(m.id);
  // 每个用例都从「库里没有配置」开始，让缓存重新走一遍默认值
  await refreshConfigCache();
});

const auth = () => ({ Authorization: `Bearer ${merchantToken}` });

describe('配置管理 · 读取', () => {
  it('没有配置行时返回默认值：公告关闭、自动同意关闭、48 小时', async () => {
    const res = await request(createApp()).get('/api/admin/config').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.announcement).toMatchObject({ enabled: false, title: '', content: '' });
    expect(res.body.data.afterSale).toMatchObject({ autoApproveEnabled: false, autoApproveHours: 48 });
  });

  it('未登录不能读配置', async () => {
    const res = await request(createApp()).get('/api/admin/config');
    expect(res.status).toBe(401);
  });
});

describe('配置管理 · 公告', () => {
  it('保存后后台能读回，C 端公告接口也同时可见', async () => {
    const saved = await request(createApp()).put('/api/admin/config').set(auth()).send({
      announcement: { enabled: true, title: '双十一直播', content: '晚 8 点全场 8 折' },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.announcement).toMatchObject({
      enabled: true,
      title: '双十一直播',
      content: '晚 8 点全场 8 折',
    });

    const pub = await request(createApp()).get('/api/announcement');
    expect(pub.status).toBe(200);
    expect(pub.body.data).toEqual({ title: '双十一直播', content: '晚 8 点全场 8 折' });
  });

  it('关闭公告后 C 端返回 null（小程序据此不渲染），内容仍保留在后台', async () => {
    await request(createApp())
      .put('/api/admin/config')
      .set(auth())
      .send({ announcement: { enabled: true, title: '标题', content: '内容' } });
    await request(createApp()).put('/api/admin/config').set(auth()).send({ announcement: { enabled: false } });

    const pub = await request(createApp()).get('/api/announcement');
    expect(pub.body.data).toBeNull();

    const back = await request(createApp()).get('/api/admin/config').set(auth());
    expect(back.body.data.announcement).toMatchObject({ enabled: false, title: '标题', content: '内容' });
  });

  it('只开开关不写内容时 C 端仍返回 null，避免弹出空白公告', async () => {
    await request(createApp()).put('/api/admin/config').set(auth()).send({ announcement: { enabled: true } });
    const pub = await request(createApp()).get('/api/announcement');
    expect(pub.body.data).toBeNull();
  });

  it('标题超 40 字、内容超 500 字被拒', async () => {
    const longTitle = await request(createApp())
      .put('/api/admin/config')
      .set(auth())
      .send({ announcement: { title: 'a'.repeat(41) } });
    expect(longTitle.status).toBe(400);

    const longContent = await request(createApp())
      .put('/api/admin/config')
      .set(auth())
      .send({ announcement: { content: 'a'.repeat(501) } });
    expect(longContent.status).toBe(400);
  });
});

describe('配置管理 · 退款自动同意时长', () => {
  it('保存时长与开关后能读回', async () => {
    const res = await request(createApp())
      .put('/api/admin/config')
      .set(auth())
      .send({ afterSale: { autoApproveEnabled: true, autoApproveHours: 72 } });
    expect(res.status).toBe(200);
    expect(res.body.data.afterSale).toMatchObject({ autoApproveEnabled: true, autoApproveHours: 72 });
  });

  it('时长超出 1~720 被拒（防止填 0 变成「立刻退款」）', async () => {
    for (const hours of [0, -1, 721, 1.5]) {
      const res = await request(createApp())
        .put('/api/admin/config')
        .set(auth())
        .send({ afterSale: { autoApproveHours: hours } });
      expect(res.status, `hours=${hours} 应被拒`).toBe(400);
    }
  });

  it('保存公告不会把售后规则冲掉（两块各自单独保存）', async () => {
    await request(createApp())
      .put('/api/admin/config')
      .set(auth())
      .send({ afterSale: { autoApproveEnabled: true, autoApproveHours: 24 } });
    await request(createApp())
      .put('/api/admin/config')
      .set(auth())
      .send({ announcement: { enabled: true, title: 't', content: 'c' } });

    const res = await request(createApp()).get('/api/admin/config').set(auth());
    expect(res.body.data.afterSale).toMatchObject({ autoApproveEnabled: true, autoApproveHours: 24 });
    expect(res.body.data.announcement).toMatchObject({ enabled: true, title: 't' });
  });

  it('空对象被拒，避免一次无意义的写库', async () => {
    const res = await request(createApp()).put('/api/admin/config').set(auth()).send({});
    expect(res.status).toBe(400);
  });

  it('环境变量那一组只读参数仍然会回给前端做展示', async () => {
    const res = await request(createApp()).get('/api/admin/config').set(auth());
    expect(res.body.data.env).toEqual(
      expect.objectContaining({
        escalateDays: expect.any(Number),
        returnDays: expect.any(Number),
        alertHour: expect.any(Number),
      })
    );
  });
});
