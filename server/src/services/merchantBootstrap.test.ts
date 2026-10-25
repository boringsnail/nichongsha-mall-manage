import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db.js';
import { merchantLogin } from './authService.js';
import { ensureMerchantAccount, readAdminBootstrapConfig } from './merchantBootstrap.js';

beforeEach(async () => {
  await prisma.merchant.deleteMany();
});

describe('ensureMerchantAccount（管控台账号自举）', () => {
  it('空库时创建账号，且能直接登录', async () => {
    const result = await ensureMerchantAccount('shopadmin', 'Str0ng-Pass-2026');
    expect(result).toEqual({ action: 'created', username: 'shopadmin' });

    const login = await merchantLogin('shopadmin', 'Str0ng-Pass-2026');
    expect(login.token).toBeTruthy();
    expect(login.merchant.username).toBe('shopadmin');
    expect(login.merchant.nickname).toBe('掌柜');
  });

  it('密码一致 → unchanged，且不重写库（哈希不变）', async () => {
    await ensureMerchantAccount('shopadmin', 'Str0ng-Pass-2026');
    const before = await prisma.merchant.findUniqueOrThrow({ where: { username: 'shopadmin' } });

    expect((await ensureMerchantAccount('shopadmin', 'Str0ng-Pass-2026')).action).toBe('unchanged');

    const after = await prisma.merchant.findUniqueOrThrow({ where: { username: 'shopadmin' } });
    expect(after.passwordHash).toBe(before.passwordHash);
  });

  it('密码变化 → updated，旧密码立即失效', async () => {
    await ensureMerchantAccount('shopadmin', 'Old-Pass-123456');
    expect((await ensureMerchantAccount('shopadmin', 'New-Pass-654321')).action).toBe('updated');

    await expect(merchantLogin('shopadmin', 'Old-Pass-123456')).rejects.toMatchObject({ status: 401 });
    expect((await merchantLogin('shopadmin', 'New-Pass-654321')).token).toBeTruthy();
  });

  it('只影响目标账号，不碰其它商家', async () => {
    await ensureMerchantAccount('a', 'Pass-aaaa-1111');
    await ensureMerchantAccount('b', 'Pass-bbbb-2222');
    await ensureMerchantAccount('a', 'Pass-aaaa-3333');

    expect((await merchantLogin('b', 'Pass-bbbb-2222')).token).toBeTruthy();
    expect((await merchantLogin('a', 'Pass-aaaa-3333')).token).toBeTruthy();
  });

  it('自定义昵称生效，空白昵称回落默认值', async () => {
    await ensureMerchantAccount('with-nick', 'Pass-nick-1234', '你宠啥旗舰店');
    expect((await merchantLogin('with-nick', 'Pass-nick-1234')).merchant.nickname).toBe('你宠啥旗舰店');
    await ensureMerchantAccount('blank-nick', 'Pass-nick-5678', '   ');
    expect((await merchantLogin('blank-nick', 'Pass-nick-5678')).merchant.nickname).toBe('掌柜');
  });
});

describe('readAdminBootstrapConfig', () => {
  it('两个都没配 → null（跳过自举）', () => {
    expect(readAdminBootstrapConfig({})).toBeNull();
    expect(readAdminBootstrapConfig({ ADMIN_USERNAME: '  ', ADMIN_PASSWORD: '' })).toBeNull();
  });

  it('只配一个 → 报错，避免建出无密码/无名账号', () => {
    expect(() => readAdminBootstrapConfig({ ADMIN_USERNAME: 'x' })).toThrow(/必须同时配置/);
    expect(() => readAdminBootstrapConfig({ ADMIN_PASSWORD: 'p' })).toThrow(/必须同时配置/);
  });

  it('生产环境强制至少 8 位', () => {
    expect(() => readAdminBootstrapConfig({ ADMIN_USERNAME: 'x', ADMIN_PASSWORD: 'short' }, true)).toThrow(
      /至少 8 位/,
    );
    expect(readAdminBootstrapConfig({ ADMIN_USERNAME: 'x', ADMIN_PASSWORD: 'longenough' }, true)).toEqual({
      username: 'x',
      password: 'longenough',
    });
  });

  it('非生产环境不强制长度（兼容本地种子口令）', () => {
    expect(readAdminBootstrapConfig({ ADMIN_USERNAME: '商家', ADMIN_PASSWORD: '商家123' }, false)).toEqual({
      username: '商家',
      password: '商家123',
    });
  });

  it('用户名去首尾空白，密码原样保留', () => {
    expect(readAdminBootstrapConfig({ ADMIN_USERNAME: ' admin ', ADMIN_PASSWORD: ' p w ' }, false)).toEqual({
      username: 'admin',
      password: ' p w ',
    });
  });
});
