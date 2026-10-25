import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db.js';

// 云端登录 500 事件的回归：微信 code2Session 失败必须给出可诊断的状态码与原因，
// 而不是不透明的 SERVER_ERROR。
async function appWithWxCredentials() {
  vi.resetModules();
  vi.stubEnv('WX_APPID', 'wxce86198b133baa5e');
  vi.stubEnv('WX_APPSECRET', '6514918f4240695d870a1cc1058c3abd');
  const { createApp } = await import('../app');
  return createApp();
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  await prisma.user.deleteMany({ where: { openid: { in: ['openid-ok'] } } });
});

describe('微信登录 code2Session 异常处理', () => {
  it('容器访问不到微信 → 502 WX_UNAVAILABLE（不再是不透明的 500）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    const app = await appWithWxCredentials();
    const res = await request(app).post('/api/auth/login').send({ code: 'real-code-from-wx-login' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('WX_UNAVAILABLE');
    expect(res.body.message).toContain('api.weixin.qq.com');
  });

  it('微信返回 errcode → 401 且透出微信的原因', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ errcode: 40029, errmsg: 'invalid code' }) })));
    const app = await appWithWxCredentials();
    const res = await request(app).post('/api/auth/login').send({ code: 'bad-code' });
    expect(res.status).toBe(401);
    expect(res.body.message).toContain('invalid code');
  });

  it('配了微信凭据时收到 dev- 设备号 → 401 且提示改用 wx.login', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ openid: 'o-should-not-be-used' }) })));
    const app = await appWithWxCredentials();
    const res = await request(app).post('/api/auth/login').send({ code: 'dev-abc', deviceId: 'dev-abc' });
    expect(res.status).toBe(401);
    expect(res.body.message).toContain('wx.login');
  });

  it('正常 openid → 200 且返回 token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ openid: 'openid-ok' }) })));
    const app = await appWithWxCredentials();
    const res = await request(app).post('/api/auth/login').send({ code: 'good-code' });
    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeTruthy();
  });

  it('code2Session URL 对 appid/secret/code 做百分号编码（脏字符不再导致 URL 异常）', async () => {
    const fetchMock = vi.fn(async (_url: string) => ({ json: async () => ({ openid: 'openid-ok' }) }));
    vi.stubGlobal('fetch', fetchMock);
    const app = await appWithWxCredentials();
    await request(app).post('/api/auth/login').send({ code: 'code with space&x=1' });
    const calledUrl = String(fetchMock.mock.calls[0]?.[0] ?? '');
    expect(calledUrl).toContain('js_code=code%20with%20space%26x%3D1');
  });

  // 生产版登录：微信云托管 callContainer 会注入 x-wx-openid / x-wx-source，服务端直接建会话（零出网）
  it('平台注入身份头 → 无需 code 直接建会话', async () => {
    const app = await appWithWxCredentials();
    const res = await request(app)
      .post('/api/auth/login')
      .set('x-wx-openid', 'openid-from-platform')
      .set('x-wx-source', 'wxcloudrun-callcontainer')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeTruthy();
    const user = await prisma.user.findUnique({ where: { openid: 'openid-from-platform' } });
    expect(user).toBeTruthy();
  });

  it('只有 x-wx-openid、没有 x-wx-source → 不信任，缺 code 则 400（防伪造）', async () => {
    const app = await appWithWxCredentials();
    const res = await request(app).post('/api/auth/login').set('x-wx-openid', 'spoofed-openid').send({});
    expect(res.status).toBe(400);
    expect(await prisma.user.findUnique({ where: { openid: 'spoofed-openid' } })).toBeNull();
  });
});
