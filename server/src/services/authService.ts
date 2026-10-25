import { prisma } from '../db.js';
import { signMerchantToken, signUserToken } from '../auth/jwt.js';
import { verifyPassword } from '../auth/password.js';
import { HttpError, unauthorized } from '../utils/HttpError.js';
import { env } from '../config/env.js';

// 微信登录：配置了 AppID/Secret 走真实 code2Session，否则 mock openid（仅开发期）
export async function loginWithCode(code: string, deviceId?: string) {
  let openid: string;

  if (env.wxAppid && env.wxSecret) {
    const jsCode = code.trim();
    // 生产/体验版必须用小程序的真实 wx.login() code；收到开发期的设备号时明确提示，
    // 否则会拿设备号去问微信，只能得到含糊的 errcode。
    if (jsCode.startsWith('dev-')) {
      throw unauthorized('登录 code 非法：请在小程序里用 wx.login() 获取 code 后再登录');
    }

    const url =
      'https://api.weixin.qq.com/sns/jscode2session' +
      `?appid=${encodeURIComponent(env.wxAppid)}&secret=${encodeURIComponent(env.wxSecret)}` +
      `&js_code=${encodeURIComponent(jsCode)}&grant_type=authorization_code`;

    let data: { openid?: string; errcode?: number; errmsg?: string };
    try {
      const res = await fetch(url);
      data = (await res.json()) as typeof data;
    } catch (error) {
      // 容器无法访问外网 / DNS 失败 / 超时等。以前这里会变成不透明的 500，
      // 排查时只能看到「服务器开小差了」，故明确区分并留下日志。
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error('[wx-login] 调用 code2Session 网络层失败（容器可能无法访问外网）:', reason);
      throw new HttpError(
        502,
        'WX_UNAVAILABLE',
        '微信登录服务不可用：服务端无法访问 api.weixin.qq.com（详见容器日志 [wx-login]）',
      );
    }

    if (!data.openid) {
      console.error(`[wx-login] code2Session 返回错误：errcode=${data.errcode ?? '?'} errmsg=${data.errmsg ?? '?'}`);
      throw unauthorized('微信登录失败：' + (data.errmsg || '未知错误'));
    }
    openid = data.openid;
  } else {
    // 生产环境未配置微信登录属于配置事故（启动时已被 env.ts 拦截），此处兜底拒绝
    if (!env.devMode) throw unauthorized('微信登录未配置，请检查 WX_APPID/WX_APPSECRET');
    // mock openid 锚定设备标识：同设备再次登录命中同一账号（code 每次 wx.login 都变）
    openid = `dev-${deviceId || code}`;
  }

  const user = await prisma.user.upsert({
    where: { openid },
    update: {},
    create: { openid },
  });

  return {
    token: signUserToken(user.id),
    user: { id: user.id, nickname: user.nickname, avatarUrl: user.avatarUrl },
  };
}

/**
 * 微信云托管登录：小程序用 wx.cloud.callContainer 调服务时，平台会注入 x-wx-openid；
 * 直接用它 upsert 用户并签发会话。**无需出网调 code2Session、无需 AppSecret**，
 * 因此不受容器出网策略影响（这正是审核期「登录失败/白屏」的根治方案）。
 */
export async function loginWithOpenid(openid: string) {
  const user = await prisma.user.upsert({ where: { openid }, update: {}, create: { openid } });
  return {
    token: signUserToken(user.id),
    user: { id: user.id, nickname: user.nickname, avatarUrl: user.avatarUrl },
  };
}

// 商家登录
export async function merchantLogin(username: string, password: string) {
  const m = await prisma.merchant.findUnique({ where: { username } });
  if (!m || !(await verifyPassword(password, m.passwordHash))) {
    throw unauthorized('账号或密码错误');
  }
  return {
    token: signMerchantToken(m.id),
    merchant: { id: m.id, username: m.username, nickname: m.nickname },
  };
}