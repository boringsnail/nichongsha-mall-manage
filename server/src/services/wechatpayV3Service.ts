import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { HttpError } from '../utils/HttpError.js';

// 微信支付 APIv3 直连（普通商户）
// 与云托管「云调用」的区别：直连由商户自己的证书签名，不经过平台服务商链路，
// 因此**不受「小程序提供实物交易服务 → 不支持云调用支付」的限制**。
//
// 需要的配置（商户平台 → 账户中心 → API安全）：
//   WXPAY_MCHID              商户号
//   WXPAY_SERIAL_NO          商户 API 证书序列号
//   WXPAY_PRIVATE_KEY        商户 API 证书私钥（apiclient_key.pem 内容，支持 \n 转义）
//   WXPAY_API_V3_KEY         APIv3 密钥（32 位）
//   WXPAY_PLATFORM_PUBLIC_KEY(_ID)  微信支付公钥（验签回调用；也可用 WXPAY_PLATFORM_CERT）
//   WXPAY_NOTIFY_URL         支付结果通知地址（公网 HTTPS）
//
// 官方文档：https://pay.weixin.qq.com/doc/v3/merchant/4012791856（JSAPI 下单）

const API_BASE = 'https://api.mch.weixin.qq.com';
const NOTIFY_PATH_FALLBACK = '/api/pay/notify';
const REFUND_NOTIFY_PATH_FALLBACK = '/api/pay/refund-notify';

/** 小程序 wx.requestPayment 所需参数（APIv3 使用 signType=RSA） */
export interface PaymentParams {
  appId: string;
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: string;
  paySign: string;
}

interface JsapiPrepayResponse {
  prepay_id?: string;
}

/** 把环境变量里的 PEM 还原成标准格式（支持字面量 \n） */
function normalizePem(value: string): string {
  return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
}

function requireConfig(): {
  mchid: string;
  serialNo: string;
  privateKey: crypto.KeyObject;
  appId: string;
  notifyUrl: string;
} {
  const mchid = env.pay.direct.mchid;
  const serialNo = env.pay.direct.serialNo;
  const pem = env.pay.direct.privateKey;
  const appId = env.pay.subAppId;
  if (!mchid || !serialNo || !pem || !appId) {
    throw new HttpError(
      503,
      'PAY_NOT_CONFIGURED',
      '微信支付直连未配置完整：需要 WXPAY_MCHID / WXPAY_SERIAL_NO / WXPAY_PRIVATE_KEY（以及 WX_APPID）',
    );
  }
  let privateKey: crypto.KeyObject;
  try {
    privateKey = crypto.createPrivateKey(normalizePem(pem));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new HttpError(503, 'PAY_NOT_CONFIGURED', `WXPAY_PRIVATE_KEY 不是合法的 PEM 私钥：${reason}`);
  }
  const notifyUrl = env.pay.direct.notifyUrl || `${env.pay.publicBaseUrl}${NOTIFY_PATH_FALLBACK}`;
  if (!/^https:\/\//.test(notifyUrl)) {
    throw new HttpError(503, 'PAY_NOT_CONFIGURED', `支付回调地址必须是公网 HTTPS：当前为 ${notifyUrl || '(空)'}`);
  }
  return { mchid, serialNo, privateKey, appId, notifyUrl };
}

/** 构造 APIv3 签名请求头 */
function buildAuthorization(
  method: string,
  urlPath: string,
  body: string,
  creds: { mchid: string; serialNo: string; privateKey: crypto.KeyObject },
): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(message), creds.privateKey).toString('base64');
  return (
    `WECHATPAY2-SHA256-RSA2048 mchid="${creds.mchid}",` +
    `nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${creds.serialNo}",signature="${signature}"`
  );
}

async function requestV3<T>(
  method: 'GET' | 'POST',
  urlPath: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  const creds = requireConfig();
  const body = payload ? JSON.stringify(payload) : '';
  const authorization = buildAuthorization(method, urlPath, body, creds);
  const url = `${API_BASE}${urlPath}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: authorization,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'nichongsha-server/1.0 (wechatpay-v3-direct)',
      },
      body: body || undefined,
    });
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`[wxpay-v3] ${method} ${urlPath} 网络层失败（容器需可访问 api.mch.weixin.qq.com）:`, reason);
    throw new HttpError(502, 'PAY_UNAVAILABLE', '微信支付服务不可用（详见容器日志 [wxpay-v3]）');
  }

  const text = await res.text();
  if (!res.ok) {
    console.error(`[wxpay-v3] ${method} ${urlPath} 失败 http=${res.status}: ${text.slice(0, 400)}`);
    let detail = text.slice(0, 200);
    try {
      const parsed = JSON.parse(text) as { message?: string; code?: string };
      // 同时保留 code 与 message：调用方需要靠 code（如 ORDER_NOT_EXIST）
      // 区分「微信侧查无此单」和「网络/鉴权失败」，前者才能安全判定为未支付。
      detail = [parsed.code, parsed.message].filter(Boolean).join(' ') || detail;
    } catch {
      /* 保留原始文本 */
    }
    throw new HttpError(502, 'PAY_UNAVAILABLE', `微信支付失败：${detail}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** JSAPI 统一下单：返回小程序 wx.requestPayment 所需参数 */
export async function jsapiPrepay(input: {
  orderNo: string;
  totalFee: number;
  body: string;
  openid: string;
  /** 微信侧支付截止时间（RFC3339）。与本地超时取消时间对齐，避免「订单已取消但预支付单还能付」 */
  timeExpire?: string;
}): Promise<PaymentParams> {
  const creds = requireConfig();
  const payload: Record<string, unknown> = {
    appid: creds.appId,
    mchid: creds.mchid,
    description: input.body.slice(0, 120),
    out_trade_no: input.orderNo,
    notify_url: creds.notifyUrl,
    amount: { total: input.totalFee, currency: 'CNY' },
    payer: { openid: input.openid },
  };
  if (input.timeExpire) payload.time_expire = input.timeExpire;

  const data = await requestV3<JsapiPrepayResponse>('POST', '/v3/pay/transactions/jsapi', payload);

  const prepayId = data.prepay_id;
  if (!prepayId) {
    console.error('[wxpay-v3] JSAPI 下单未返回 prepay_id:', JSON.stringify(data).slice(0, 300));
    throw new HttpError(502, 'PAY_UNAVAILABLE', '微信支付下单失败：未返回 prepay_id');
  }

  const timeStamp = Math.floor(Date.now() / 1000).toString();
  const nonceStr = crypto.randomBytes(16).toString('hex');
  const pkg = `prepay_id=${prepayId}`;
  const paySign = crypto
    .sign('RSA-SHA256', Buffer.from(`${creds.appId}\n${timeStamp}\n${nonceStr}\n${pkg}\n`), creds.privateKey)
    .toString('base64');

  return { appId: creds.appId, timeStamp, nonceStr, package: pkg, signType: 'RSA', paySign };
}

/** 主动查单（用于回调兜底与防伪造） */
export async function queryOrderByOutTradeNo(
  orderNo: string,
): Promise<{ paid: boolean; transactionId?: string; notExist?: boolean }> {
  const creds = requireConfig();
  const urlPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}?mchid=${encodeURIComponent(creds.mchid)}`;
  try {
    const data = await requestV3<{ trade_state?: string; transaction_id?: string }>('GET', urlPath);
    return { paid: data.trade_state === 'SUCCESS', transactionId: data.transaction_id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 微信侧查无此单 = 预支付单从未创建成功，必然未支付。
    // 这一条必须与「网络/鉴权失败」区分开：前者可以安全取消订单，后者不能。
    if (message.includes('ORDER_NOT_EXIST') || message.includes('订单不存在')) {
      return { paid: false, notExist: true };
    }
    throw error;
  }
}

/**
 * 关闭未支付的预支付单。
 *
 * 为什么必须关：本地把订单置为「已取消」只是改我们自己的库，微信侧的预支付单
 * 仍然可以被付款。用户手上有一次调起收银台的机会（或页面没关），付了钱订单却是
 * 关闭的——钱收了货不发，只能人工退款。关单之后该 out_trade_no 再也付不进来。
 *
 * 已支付 / 已关闭 / 查无此单 都视为「无需再关」，不算失败。
 */
export async function closeOrderByOutTradeNo(orderNo: string): Promise<{ ok: boolean; error?: string }> {
  const creds = requireConfig();
  const urlPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}/close`;
  try {
    await requestV3('POST', urlPath, { mchid: creds.mchid });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ORDER_CLOSED|ORDER_PAID|ORDER_NOT_EXIST|订单已关闭|订单已支付|订单不存在/.test(message)) {
      return { ok: true };
    }
    return { ok: false, error: message };
  }
}

/**
 * 校验并解密「退款结果通知」。
 *
 * 与支付通知的差异：退款通知的 resource 是**微信加密报文**，明文里只有
 * 商户退款单号、退款状态、退款金额等字段（没有密文嵌套），因此可以复用同一套
 * 验签 + AES-256-GCM 解密逻辑。
 */
export function verifyAndDecryptRefundNotify(
  rawBody: string,
  headers: NotifyHeaders,
): {
  outRefundNo?: string;
  refundId?: string;
  outTradeNo?: string;
  refundStatus?: string;
  /** 退款金额（分） */
  refundFee?: number;
} {
  const data = verifyAndDecryptNotify(rawBody, headers);
  const amount = (data.amount ?? {}) as { refund?: number; payer_refund?: number };
  return {
    outRefundNo: data.out_refund_no ? String(data.out_refund_no) : undefined,
    refundId: data.refund_id ? String(data.refund_id) : undefined,
    outTradeNo: data.out_trade_no ? String(data.out_trade_no) : undefined,
    refundStatus: data.refund_status ? String(data.refund_status) : undefined,
    refundFee: typeof amount.refund === 'number' ? amount.refund : undefined,
  };
}

/** 验签用的微信支付平台公钥（支持「微信支付公钥」或平台证书两种配置） */
function platformPublicKey(serial: string): crypto.KeyObject | undefined {
  const { platformPublicKey, platformPublicKeyId, platformCert } = env.pay.direct;
  if (platformPublicKey && platformPublicKeyId && platformPublicKeyId === serial) {
    try {
      return crypto.createPublicKey(normalizePem(platformPublicKey));
    } catch {
      return undefined;
    }
  }
  if (platformCert) {
    try {
      return crypto.createPublicKey(normalizePem(platformCert));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface NotifyHeaders {
  timestamp?: string;
  nonce?: string;
  signature?: string;
  serial?: string;
}

// ---------- 退款（APIv3） ----------

export interface RefundResult {
  /** 微信退款单号 */
  refundId?: string;
  /** 商户退款单号 */
  outRefundNo?: string;
  /** SUCCESS=退款成功 / PROCESSING=退款处理中 / ABNORMAL=退款异常 / CLOSED=退款关闭 */
  status?: string;
}

/**
 * 申请退款。
 *
 * 关键点：
 * 1. out_refund_no 必须幂等——同一笔售后重试要用**同一个** out_refund_no，
 *    否则微信会认为多次退款，可能重复退钱。
 * 2. amount.refund 是「本次退款金额」，amount.total 是「原订单金额」，
 *    两者都以分计。部分退款时 total 仍然填原订单金额。
 * 3. notify_url 与支付回调分开，便于区分处理逻辑。
 */
export async function applyRefund(input: {
  orderNo: string;
  /** 商户退款单号（幂等键），建议用售后单号 */
  outRefundNo: string;
  /** 原订单金额（分） */
  totalFee: number;
  /** 本次退款金额（分） */
  refundFee: number;
  reason?: string;
  notifyUrl?: string;
}): Promise<RefundResult> {
  const creds = requireConfig();
  const payload: Record<string, unknown> = {
    out_trade_no: input.orderNo,
    out_refund_no: input.outRefundNo,
    reason: (input.reason || '售后退款').slice(0, 80),
    amount: { refund: input.refundFee, total: input.totalFee, currency: 'CNY' },
  };
  const notify = input.notifyUrl || env.pay.direct.refundNotifyUrl || `${env.pay.publicBaseUrl}${REFUND_NOTIFY_PATH_FALLBACK}`;
  payload.notify_url = notify;

  const data = await requestV3<{
    refund_id?: string;
    out_refund_no?: string;
    status?: string;
  }>('POST', '/v3/refund/domestic/refunds', payload);

  return { refundId: data.refund_id, outRefundNo: data.out_refund_no, status: data.status };
}

/** 查询退款单（回调丢失时的兜底） */
export async function queryRefund(outRefundNo: string): Promise<RefundResult> {
  const data = await requestV3<{
    refund_id?: string;
    out_refund_no?: string;
    status?: string;
  }>('GET', `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`);
  return { refundId: data.refund_id, outRefundNo: data.out_refund_no, status: data.status };
}

/**
 * 校验并解密支付结果通知（APIv3）：
 *   1) 用微信支付平台公钥验签（timestamp\nnonce\nbody\n）
 *   2) 用 APIv3 密钥做 AES-256-GCM 解密 resource
 * 任一步失败即拒绝，避免伪造回调把订单改成已支付。
 */
export function verifyAndDecryptNotify(rawBody: string, headers: NotifyHeaders): Record<string, unknown> {
  const { timestamp, nonce, signature, serial } = headers;
  if (!timestamp || !nonce || !signature || !serial) {
    throw new HttpError(400, 'PAY_NOTIFY_INVALID', '回调缺少签名头');
  }
  const publicKey = platformPublicKey(serial);
  if (!publicKey) {
    throw new HttpError(
      503,
      'PAY_NOT_CONFIGURED',
      `未配置与回调证书序列号匹配的微信支付平台公钥（serial=${serial}）`,
    );
  }
  const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
  const ok = crypto.verify('RSA-SHA256', Buffer.from(message), publicKey, Buffer.from(signature, 'base64'));
  if (!ok) throw new HttpError(400, 'PAY_NOTIFY_INVALID', '回调验签失败');

  const parsed = JSON.parse(rawBody) as {
    resource?: { algorithm?: string; ciphertext?: string; nonce?: string; associated_data?: string };
  };
  const resource = parsed.resource;
  if (!resource?.ciphertext || !resource.nonce) {
    throw new HttpError(400, 'PAY_NOTIFY_INVALID', '回调缺少 resource');
  }
  const key = Buffer.from(env.pay.direct.apiV3Key, 'utf8');
  if (key.length !== 32) {
    throw new HttpError(503, 'PAY_NOT_CONFIGURED', 'WXPAY_API_V3_KEY 必须是 32 位');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(resource.nonce, 'utf8'));
  if (resource.associated_data) {
    decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
  }
  // 密文末尾 16 字节是 GCM tag
  const ciphertext = Buffer.from(resource.ciphertext, 'base64');
  const authTag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return JSON.parse(plain) as Record<string, unknown>;
}
