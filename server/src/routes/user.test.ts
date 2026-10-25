import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { prisma } from '../db';

// 清库，避免跨文件残留
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
});

async function login(code: string) {
  const res = await request(createApp()).post('/api/auth/dev-login').send({ code });
  expect(res.status).toBe(200);
  return res.body.data.token as string;
}

const addr = {
  receiverName: '张三',
  phone: '13800138000',
  province: '广东省',
  city: '深圳市',
  district: '南山区',
  detail: '科技园路 1 号',
};

describe('用户域 API', () => {
  it('未登录访问 profile → 401', async () => {
    const res = await request(createApp()).get('/api/user/profile');
    expect(res.status).toBe(401);
  });

  it('登录后 GET profile 返回用户（nickname 为空）', async () => {
    const token = await login('u11-a');
    const res = await request(createApp()).get('/api/user/profile').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.openid).toBe('dev-u11-a');
    expect(res.body.data.nickname).toBeNull();
  });

  it('PUT profile 更新昵称/头像/手机号', async () => {
    const token = await login('u11-b');
    const res = await request(createApp())
      .put('/api/user/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ nickname: '铲屎官小张', avatarUrl: 'http://img.example/avatar.png', phone: '13900139000' });
    expect(res.status).toBe(200);
    expect(res.body.data.nickname).toBe('铲屎官小张');
    expect(res.body.data.phone).toBe('13900139000');
  });

  it('PUT profile 非法 body → 400', async () => {
    const token = await login('u11-c');
    const res = await request(createApp())
      .put('/api/user/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ nickname: 123 });
    expect(res.status).toBe(400);
  });

  it('地址列表初始为空', async () => {
    const token = await login('u11-d');
    const res = await request(createApp()).get('/api/user/addresses').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('创建第一个地址自动设为默认', async () => {
    const token = await login('u11-e');
    const res = await request(createApp())
      .post('/api/user/addresses')
      .set('Authorization', `Bearer ${token}`)
      .send(addr);
    expect(res.status).toBe(200);
    expect(res.body.data.isDefault).toBe(true);
    expect(res.body.data.receiverName).toBe('张三');
  });

  it('创建第二个地址不默认；切默认后旧的复位', async () => {
    const token = await login('u11-f');
    const app = createApp();
    const a = await request(app).post('/api/user/addresses').set('Authorization', `Bearer ${token}`).send(addr);
    const b = await request(app)
      .post('/api/user/addresses')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...addr, receiverName: '李四', detail: '后海大道 2 号' });
    expect(b.body.data.isDefault).toBe(false);

    // 设 B 为默认 → A.isDefault 必须复位
    const setDefault = await request(app)
      .put(`/api/user/addresses/${b.body.data.id}/default`)
      .set('Authorization', `Bearer ${token}`);
    expect(setDefault.status).toBe(200);
    expect(setDefault.body.data.isDefault).toBe(true);

    const list = await request(app).get('/api/user/addresses').set('Authorization', `Bearer ${token}`);
    const map = Object.fromEntries(list.body.data.map((x: any) => [x.receiverName, x.isDefault]));
    expect(map['李四']).toBe(true);
    expect(map['张三']).toBe(false);
  });

  it('PUT 修改地址', async () => {
    const token = await login('u11-g');
    const app = createApp();
    const created = await request(app).post('/api/user/addresses').set('Authorization', `Bearer ${token}`).send(addr);
    const res = await request(app)
      .put(`/api/user/addresses/${created.body.data.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ receiverName: '张三丰', detail: '新地址' });
    expect(res.status).toBe(200);
    expect(res.body.data.receiverName).toBe('张三丰');
    expect(res.body.data.detail).toBe('新地址');
  });

  it('DELETE 地址', async () => {
    const token = await login('u11-h');
    const app = createApp();
    const created = await request(app).post('/api/user/addresses').set('Authorization', `Bearer ${token}`).send(addr);
    const del = await request(app)
      .delete(`/api/user/addresses/${created.body.data.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(200);
    const list = await request(app).get('/api/user/addresses').set('Authorization', `Bearer ${token}`);
    expect(list.body.data).toEqual([]);
  });

  it('操作他人地址 → 404（按 userId 隔离）', async () => {
    const token = await login('u11-i');
    const app = createApp();
    const other = await request(app).post('/api/user/addresses').set('Authorization', `Bearer ${token}`).send(addr);
    const otherToken = await login('u11-j');
    const res = await request(app)
      .delete(`/api/user/addresses/${other.body.data.id}`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(res.status).toBe(404);
  });

  it('创建地址缺字段 → 400', async () => {
    const token = await login('u11-k');
    const res = await request(createApp())
      .post('/api/user/addresses')
      .set('Authorization', `Bearer ${token}`)
      .send({ receiverName: '张三' });
    expect(res.status).toBe(400);
  });

  // m1：小程序地址编辑页会带 isDefault；创建时显式默认应抢占默认（解下其他）
  it('创建第二个地址 isDefault:true → 直接成为默认，旧的复位', async () => {
    const token = await login('u11-m1');
    const app = createApp();
    const a = await request(app).post('/api/user/addresses').set('Authorization', `Bearer ${token}`).send(addr);
    const b = await request(app)
      .post('/api/user/addresses')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...addr, receiverName: '李四', isDefault: true });
    expect(b.status).toBe(200);
    expect(b.body.data.isDefault).toBe(true);

    const list = await request(app).get('/api/user/addresses').set('Authorization', `Bearer ${token}`);
    const map = Object.fromEntries(list.body.data.map((x: any) => [x.receiverName, x.isDefault]));
    expect(map['李四']).toBe(true);
    expect(map['张三']).toBe(false);
  });

  // m1：PUT 更新带 isDefault:true → 原位默认
  it('PUT 地址 isDefault:true 生效', async () => {
    const token = await login('u11-m2');
    const app = createApp();
    const a = await request(app).post('/api/user/addresses').set('Authorization', `Bearer ${token}`).send(addr);
    const b = await request(app)
      .post('/api/user/addresses')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...addr, receiverName: '李四' });
    const setB = await request(app)
      .put(`/api/user/addresses/${b.body.data.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isDefault: true });
    expect(setB.status).toBe(200);
    expect(setB.body.data.isDefault).toBe(true);

    const list = await request(app).get('/api/user/addresses').set('Authorization', `Bearer ${token}`);
    const map = Object.fromEntries(list.body.data.map((x: any) => [x.receiverName, x.isDefault]));
    expect(map['李四']).toBe(true);
    expect(map['张三']).toBe(false);
  });
});
