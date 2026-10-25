import { env } from '../config/env.js';
import { HttpError } from '../utils/HttpError.js';

// 小程序服务端接口 access_token 缓存
// 微信侧 access_token 有效期 7200s 且**全局唯一**（新旧互踢），因此必须缓存复用，
// 并提前刷新；并发拿取时复用同一个 Promise，避免同时刷新导致互踢。
//
// 【为什么必须用 stable_token 而不是 cgi-bin/token】
// 1. 云托管容器的出口 IP 是动态的公网 IP，通常不在「小程序 IP 白名单」里，
//    调 cgi-bin/token 会稳定返回 40164（invalid ip），导致发货对账、
//    发货信息上报等全部静默失败——表现为「商家在微信后台发了货，我们这边永远显示待发货」。
// 2. stable_token 走独立凭据池，不会被其他程序（例如同 AppID 的 C 端服务）刷新顶掉，
//    也不会互相踢下线；调用方无需配置 IP 白名单。
// 这是线上订单状态不同步的直接原因，故不再回退到 cgi-bin/token。

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

/**
 * 取 access_token。
 * @param forceRefresh 为 true 时忽略本地缓存并向微信强制刷新（用于收到 40001/42001 后重试）
 */
export async function getAccessToken(forceRefresh = false): Promise<string> {
  const now = Date.now();
  if (!forceRefresh && cached && cached.expiresAt > now) return cached.token;
  if (!forceRefresh && inflight) return inflight;

  const appid = env.wxAppid;
  const secret = env.wxSecret;
  if (!appid || !secret) {
    throw new HttpError(503, 'WX_NOT_CONFIGURED', '未配置 WX_APPID / WX_APPSECRET，无法获取 access_token');
  }

  const task = (async () => {
    const url = 'https://api.weixin.qq.com/cgi-bin/stable_token';
    let data: { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credential', appid, secret, force_refresh: forceRefresh }),
      });
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
  })();

  inflight = task.finally(() => {
    inflight = null;
  });
  return inflight;
}
