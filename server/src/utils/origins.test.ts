import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { hostnameOf, isAllowedOrigin, parseOrigins } from './origins';

const FRONTEND = 'https://mall-admin-web-326900-12-1504359859.sh.run.tcloudbase.com';

/** 只关心 headers 的最小 Request 替身 */
const req = (headers: Record<string, string>) => ({ headers } as unknown as Request);

describe('CORS 来源判定', () => {
  it('白名单命中即放行（大小写、末尾斜杠容错）', () => {
    expect(isAllowedOrigin(FRONTEND, req({}), [FRONTEND])).toBe(true);
    expect(isAllowedOrigin(`${FRONTEND}/`, req({}), [FRONTEND])).toBe(true);
    expect(isAllowedOrigin('https://Admin-Web.test', req({}), ['https://admin-web.test'])).toBe(true);
  });

  it('经 nginx 反代时用 X-Forwarded-Host 判同源', () => {
    const forwarded = req({ 'x-forwarded-host': 'mall-admin-web-326900-12-1504359859.sh.run.tcloudbase.com' });
    expect(isAllowedOrigin(FRONTEND, forwarded, [])).toBe(true);
  });

  it('Host 被改写成后端域名且无 X-Forwarded-Host 时判为跨域', () => {
    const backendOnly = req({ host: 'mall-admin-server-326900-12-1504359859.sh.run.tcloudbase.com' });
    expect(isAllowedOrigin(FRONTEND, backendOnly, [])).toBe(false);
  });

  it('陌生来源拒绝，微信侧来源放行', () => {
    expect(isAllowedOrigin('https://evil.com', req({ host: 'api.test' }), [])).toBe(false);
    expect(isAllowedOrigin('https://servicewechat.com', req({}), [])).toBe(true);
    expect(isAllowedOrigin('https://open.wechat.com', req({}), [])).toBe(true);
  });

  it('混合应用 WebView 的固定来源放行（否则 App 内全部 403）', () => {
    expect(isAllowedOrigin('https://localhost', req({ host: 'api.test' }), [])).toBe(true);
    expect(isAllowedOrigin('capacitor://localhost', req({ host: 'api.test' }), [])).toBe(true);
    expect(isAllowedOrigin('ionic://localhost', req({ host: 'api.test' }), [])).toBe(true);
    // 本机起的调试服务不是 WebView，仍按白名单处理
    expect(isAllowedOrigin('http://localhost:5173', req({ host: 'api.test' }), [])).toBe(false);
    expect(isAllowedOrigin('http://localhost:5173', req({ host: 'api.test' }), ['http://localhost:5173'])).toBe(true);
  });

  it('parseOrigins：去空白/末尾斜杠/小写，空串视为未配置', () => {
    expect(parseOrigins(' https://A.com/ , https://b.com ')).toEqual(['https://a.com', 'https://b.com']);
    expect(parseOrigins('')).toBeUndefined();
    expect(parseOrigins('  ,  ')).toBeUndefined();
    expect(parseOrigins(undefined)).toBeUndefined();
  });

  it('hostnameOf：忽略协议与端口，非法值返回空串', () => {
    expect(hostnameOf('https://a.com:8443/x')).toBe('a.com');
    expect(hostnameOf('a.com:8080')).toBe('a.com');
    expect(hostnameOf('not a url')).toBe('');
    expect(hostnameOf(undefined)).toBe('');
  });
});
