import type { Request } from 'express';

/**
 * CORS 来源判定（与 app.ts 解耦，便于单测）。
 *
 * 背景：历史实现只认 `ADMIN_ORIGINS` 白名单，生产环境未配置时默认只放行
 * `http://localhost:5173`。前端一旦换域名（云托管默认域名、自定义域名、新增前端服务），
 * 浏览器的 POST 会带 `Origin` 而被拒，且错误以 500 抛出，现象是登录页「服务器开小差了」。
 *
 * 现在按三条判定放行：
 *   ① 命中白名单（ADMIN_ORIGINS / MINIPROGRAM_ORIGINS）
 *   ② 与请求同源——前端经 nginx 反代访问后端时，`Origin` 是前端域名，而 `Host`
 *      已被 nginx 改写成后端域名，因此优先读 `X-Forwarded-Host`
 *   ③ `*.wechat.com`（小程序开发者工具、servicewechat.com 等）
 */

/** 逗号分隔的来源列表：去空白、去末尾斜杠、统一小写；空串视为未配置 */
export function parseOrigins(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const list = raw
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, '').toLowerCase())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/** 取主机名（忽略协议与端口）；非法值返回空串 */
export function hostnameOf(value: string | undefined): string {
  if (!value) return '';
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isAllowedOrigin(origin: string, req: Request, allOrigins: string[]): boolean {
  const normalized = origin.replace(/\/+$/, '').toLowerCase();
  if (allOrigins.includes(normalized)) return true;
  // 微信侧来源：小程序开发者工具（servicewechat.com）与 *.wechat.com
  if (normalized === 'https://servicewechat.com' || normalized.endsWith('.wechat.com')) return true;
  const forwardedHost = req.headers['x-forwarded-host'];
  const requestHost = hostnameOf(
    Array.isArray(forwardedHost) ? forwardedHost[0] : (forwardedHost ?? req.headers.host),
  );
  const originHost = hostnameOf(normalized);
  return Boolean(originHost) && originHost === requestHost;
}
