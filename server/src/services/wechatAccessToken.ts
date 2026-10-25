import { env } from '../config/env.js';
import { HttpError } from '../utils/HttpError.js';

// 小程序服务端接口 access_token 缓存
// 微信侧 access_token 有效期 7200s 且**全局唯一**（新旧互踢），因此必须缓存复用，
// 并提前刷新；并发拿取时复用同一个 Promise，避免同时刷新导致互踢。

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cached: CachedToken | null = null;
let inflight: Promise<string> | null = null;

const EARLY_REFRESH_MS = 5 * 60 * 1000; // 提前 5 分钟刷新

export function resetAccessTokenCache(): void {
  cached = null;
  inflight = null;
}

export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.token;
  if (inflight) return inflight;

  const appid = env.wxAppid;
  const secret = env.wxSecret;
  if (!appid || !secret) {
    throw new HttpError(503, 'WX_NOT_CONFIGURED', '未配置 WX_APPID / WX_APPSECRET，无法获取 access_token');
  }

  inflight = (async () => {
    const url =
      'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential' +
      `&appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}`;
    let data: { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };
    try {
      const res = await fetch(url, { method: 'GET' });
      data = (await res.json()) as typeof data;
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error('[wx-token] 获取 access_token 网络层失败:', reason);
      throw new HttpError(502, 'WX_UNAVAILABLE', '微信接口不可用（详见容器日志 [wx-token]）');
    }
    if (!data.access_token) {
      console.error(`[wx-token] 获取失败：errcode=${data.errcode} errmsg=${data.errmsg}`);
      throw new HttpError(502, 'WX_UNAVAILABLE', `获取 access_token 失败：${data.errmsg ?? '未知错误'}`);
    }
    const ttl = (data.expires_in ?? 7200) * 1000;
    cached = { token: data.access_token, expiresAt: Date.now() + Math.max(ttl - EARLY_REFRESH_MS, 60_000) };
    return cached.token;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}
