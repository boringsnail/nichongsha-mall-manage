/**
 * 微信开放接口（api.weixin.qq.com）的统一请求入口。
 *
 * 【为什么不能直接 fetch https://api.weixin.qq.com】
 * 微信云托管默认开启「开放接口服务」（云调用）：它会在业务容器内**旁加载**一个代理，
 * 把 api.weixin.qq.com 解析到容器内地址并挂上**一次性自签名证书**。
 * 于是容器里用 HTTPS 调这个域名会稳定报：
 *   TypeError: fetch failed | DEPTH_ZERO_SELF_SIGNED_CERT | self-signed certificate
 *
 * 官方给了两条路：
 *   1. 容器内用 **HTTP** 协议访问 api.weixin.qq.com（推荐，性能更好）；
 *   2. 仍用 HTTPS，但让运行时信任 /app/cert/certificate.crt
 *      （Node 需设置 NODE_EXTRA_CA_CERTS，见 Dockerfile）。
 *
 * 这里两条都做：默认 HTTPS（本地开发、非云托管环境照常工作），
 * 一旦因为证书问题失败，就自动降级为 HTTP 并记住这个选择，后续请求不再重试失败路径。
 *
 * 注意：这个降级只针对 api.weixin.qq.com。api.mch.weixin.qq.com（微信支付）
 * 不经过该代理，必须继续走 HTTPS，因此不要用本模块请求支付接口。
 */

const WX_HOST = 'api.weixin.qq.com';

/** 说明当前是否已降级到 HTTP，排障时可从日志看出走了哪条链路 */
let httpFallback = false;

export function isUsingHttpFallback(): boolean {
  return httpFallback;
}

/** 这些错误码/文案都表示「TLS 握手阶段不信任对端证书」，与业务无关 */
const TLS_ERROR_HINTS = [
  'self-signed certificate',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'unable to verify the first certificate',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'certificate has expired',
];

function isTlsTrustError(error: unknown): boolean {
  const e = error as { message?: string; cause?: { code?: string; message?: string } };
  const text = [e?.message, e?.cause?.code, e?.cause?.message].filter(Boolean).join(' ').toLowerCase();
  return TLS_ERROR_HINTS.some((hint) => text.includes(hint.toLowerCase()));
}

/**
 * 请求微信开放接口。
 * @param pathWithQuery 形如 `/wxa/sec/order/get_order?access_token=xxx`
 */
export async function wxFetch(pathWithQuery: string, init: RequestInit = {}): Promise<Response> {
  const path = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`;
  const scheme = httpFallback ? 'http' : 'https';

  try {
    return await fetch(`${scheme}://${WX_HOST}${path}`, init);
  } catch (error) {
    if (!httpFallback && isTlsTrustError(error)) {
      // 云托管容器内云调用的典型表现：改用 HTTP 即可，由旁加载的代理接管鉴权
      httpFallback = true;
      console.warn(
        `[wx-http] HTTPS 访问 ${WX_HOST} 证书不被信任（云托管云调用自签名证书），` +
          `已自动降级为 HTTP。如需继续用 HTTPS，请在镜像中设置 NODE_EXTRA_CA_CERTS=/app/cert/certificate.crt`,
      );
      return fetch(`http://${WX_HOST}${path}`, init);
    }
    throw error;
  }
}
