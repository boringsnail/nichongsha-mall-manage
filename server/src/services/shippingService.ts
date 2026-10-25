import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { getAccessToken } from './wechatAccessToken.js';
import {
  wxFetch,
  withAccessToken,
  isUsingHttpFallback,
  isCloudCallMode,
  enableCloudCallMode,
} from './wechatHttp.js';

// 订单发货管理（微信「发货信息管理」）
// 背景：小程序提供**实物交易服务**时，微信要求接入订单发货管理并上传发货信息，
// 否则会被限制交易能力（我们遇到的 268500896「暂不支持云调用支付」即源于此）。
// 接口：POST https://api.weixin.qq.com/wxa/sec/order/upload_shipping_info?access_token=...
// 文档：https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/order-shipping/order-shipping.html

/** 常见快递公司名称 → 微信物流公司编码（未命中则原样透传，微信侧会校验） */
const EXPRESS_COMPANY_CODES: Record<string, string> = {
  顺丰: 'SF',
  顺丰速运: 'SF',
  中通: 'ZTO',
  中通快递: 'ZTO',
  圆通: 'YTO',
  圆通速递: 'YTO',
  韵达: 'YUNDA',
  韵达快递: 'YUNDA',
  申通: 'STO',
  申通快递: 'STO',
  极兔: 'JT',
  极兔速递: 'JT',
  邮政: 'YZPY',
  邮政EMS: 'EMS',
  EMS: 'EMS',
  京东: 'JD',
  京东物流: 'JD',
  德邦: 'DBL',
  德邦快递: 'DBL',
  百世: 'HTKY',
  百世快递: 'HTKY',
  宅急送: 'ZJS',
  天天: 'HHTT',
  天天快递: 'HHTT',
  丰网: 'FWX',
};

export function resolveExpressCompany(nameOrCode: string): string {
  const key = nameOrCode.trim();
  return EXPRESS_COMPANY_CODES[key] ?? key;
}

/**
 * 物流模式，取值对齐微信 upload_shipping_info.logistics_type。
 *
 * 商家除了发快递，还会「同城跑腿送过去」或「让用户到店自提」。这两种场景没有快递单号，
 * 如果只支持快递，商家就只能在后台瞎填一个假单号——既污染数据，用户侧物流也显示不对。
 */
export const LOGISTICS_TYPE = {
  /** 实体物流配送（快递公司） */
  EXPRESS: 1,
  /** 同城配送（跑腿/自送） */
  LOCAL_DELIVERY: 2,
  /** 虚拟商品（话费、点卡等，本项目不使用） */
  VIRTUAL: 3,
  /** 用户自提 */
  PICKUP: 4,
} as const;

export type LogisticsType = (typeof LOGISTICS_TYPE)[keyof typeof LOGISTICS_TYPE];

/** 管控台/小程序展示用的文案 */
export const LOGISTICS_TYPE_LABEL: Record<number, string> = {
  1: '快递发货',
  2: '同城配送',
  3: '虚拟商品',
  4: '用户自提',
};

/** 只有快递发货强制要求物流公司与单号 */
export function requiresExpressInfo(type: number): boolean {
  return type === LOGISTICS_TYPE.EXPRESS;
}

export interface ShippingUploadResult {
  ok: boolean;
  skipped?: string;
  error?: string;
}

/** access_token 失效类错误码：40001 凭据无效 / 40014 不合法 / 42001 已过期 */
const TOKEN_INVALID_ERRCODES = new Set([40001, 40014, 42001]);

/** 发一次请求并解析 JSON；非 JSON 响应（云调用代理报错时常见）要保留原文便于定位 */
async function sendOnce<T>(apiPath: string, payload: unknown, token: string | null): Promise<T> {
  const res = await wxFetch(withAccessToken(apiPath, token), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`微信接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
  }
}

/**
 * 调用微信开放接口。三级兜底，覆盖三种运行环境：
 *
 *   1. 云调用免鉴权（微信云托管）：容器内由「开放接口服务」注入鉴权，不自己换 token；
 *   2. 自建 token（本地开发 / 非云托管）：走 stable_token，HTTPS；
 *   3. token 被同 AppID 的其他服务顶掉（40001/40014/42001）：强制刷新后重试一次。
 */
async function postWx<T extends { errcode?: number; errmsg?: string }>(
  apiPath: string,
  payload: unknown,
): Promise<T> {
  if (isCloudCallMode()) return sendOnce<T>(apiPath, payload, null);

  let token: string;
  try {
    token = await getAccessToken();
  } catch (error) {
    // 拿不到 token 基本就是「容器内云调用接管了鉴权」，直接切免鉴权模式
    enableCloudCallMode(error instanceof Error ? error.message : String(error));
    return sendOnce<T>(apiPath, payload, null);
  }

  const data = await sendOnce<T>(apiPath, payload, token);
  if (!TOKEN_INVALID_ERRCODES.has(Number(data.errcode))) return data;

  console.warn(`[wx] ${apiPath} access_token 失效（errcode=${data.errcode}），强制刷新后重试`);
  try {
    const fresh = await getAccessToken(true);
    return await sendOnce<T>(apiPath, payload, fresh);
  } catch (error) {
    enableCloudCallMode(error instanceof Error ? error.message : String(error));
    return sendOnce<T>(apiPath, payload, null);
  }
}

/** 从地址快照里取收件人手机号，作为 contact.receiver_contact（顺丰必填项） */
function receiverContactOf(addressSnapshot: string): string | undefined {
  try {
    const addr = JSON.parse(addressSnapshot) as { phone?: string; receiverName?: string };
    const phone = (addr.phone ?? '').trim();
    return phone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 发货信息上报：把商家填写的发货信息上传微信。
 *
 * 微信的 logistics_type 决定 shipping_list 里哪些字段必填：
 *   1 快递   → tracking_no + express_company 必填
 *   2 同城   → 无快递单号，两者都可空
 *   4 自提   → 无快递单号，两者都可空（提货码可选放在 tracking_no）
 * item_desc 任何模式下都必填（错误码 10060008）。
 *
 * 注意：同一支付单修改「发货模式/物流模式」会被微信视为重新发货，且仅有一次机会，
 * 所以类型在发货时就定好，后续不要随手改。
 */
export async function uploadShippingInfo(orderNo: string): Promise<ShippingUploadResult> {
  if (!env.wxAppid || !env.wxSecret) {
    return { ok: false, skipped: '未配置 WX_APPID / WX_APPSECRET' };
  }

  const order = await prisma.order.findUnique({
    where: { orderNo },
    include: { user: { select: { openid: true } }, items: true },
  });
  if (!order) return { ok: false, error: '订单不存在' };

  const logisticsType = order.logisticsType ?? LOGISTICS_TYPE.EXPRESS;
  if (requiresExpressInfo(logisticsType) && (!order.trackingNo || !order.logisticsCompany)) {
    return { ok: false, skipped: '快递发货缺少物流公司或单号' };
  }
  if (!order.paymentNo && !order.orderNo) {
    return { ok: false, skipped: '缺少可用于关联微信支付单的信息' };
  }

  const itemDesc = order.items
    .map((i) => `${i.productName} ${i.specName} ×${i.quantity}`)
    .join('；')
    .slice(0, 120);

  // 快递：单号+快递公司编码；同城/自提：单号非必填（自提时若填了提货码就带上去）
  const shippingItem: Record<string, unknown> = {
    item_desc: itemDesc || '宠物用品',
  };
  if (logisticsType === LOGISTICS_TYPE.EXPRESS) {
    shippingItem.tracking_no = order.trackingNo;
    shippingItem.express_company = resolveExpressCompany(order.logisticsCompany ?? '');
  } else if (order.trackingNo) {
    shippingItem.tracking_no = order.trackingNo;
  }
  const contact = receiverContactOf(order.addressSnapshot);
  if (contact) shippingItem.contact = { receiver_contact: contact };

  const payload = {
    // order_number_type: 1=商户单号（需 mchid） 2=微信支付单号
    order_key: order.paymentNo
      ? { order_number_type: 2, transaction_id: order.paymentNo }
      : { order_number_type: 1, mchid: env.pay.direct.mchid || env.pay.subMchId, out_trade_no: order.orderNo },
    logistics_type: logisticsType,
    // 非快递不允许分拆发货（错误码 10060006），统一发货即可
    delivery_mode: 1,
    shipping_list: [shippingItem],
    upload_time: new Date().toISOString().replace('Z', '+08:00'),
    payer: { openid: order.user.openid },
  };

  try {
    const data = await postWx<{ errcode?: number; errmsg?: string }>(
      '/wxa/sec/order/upload_shipping_info',
      payload,
    );
    if (data.errcode !== 0) {
      console.error(`[wx-shipping] 发货信息上报失败：errcode=${data.errcode} errmsg=${data.errmsg}`);
      return { ok: false, error: `微信返回 ${data.errcode}: ${data.errmsg ?? ''}` };
    }
    const mode = LOGISTICS_TYPE_LABEL[logisticsType] ?? String(logisticsType);
    console.log(
      `[wx-shipping] 发货信息上报成功：${orderNo}（${mode}）` +
        `${order.trackingNo ? ` ${order.logisticsCompany ?? ''}/${order.trackingNo}` : ''}`,
    );
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[wx-shipping] 发货信息上报异常：${orderNo}`, reason);
    return { ok: false, error: reason };
  }
}

/** 查询小程序是否已被纳入「订单发货管理」（用于排障：被管理时交易能力受限，必须上报发货） */
export async function isTradeManaged(): Promise<boolean | null> {
  if (!env.wxAppid || !env.wxSecret) return null;
  try {
    // 云调用模式下无需 access_token；自建模式下走 stable_token
    const data = await postWx<{ errcode?: number; is_trade_managed?: boolean }>(
      '/wxa/sec/order/is_trade_managed',
      {},
    );
    return data.errcode === 0 ? Boolean(data.is_trade_managed) : null;
  } catch {
    return null;
  }
}

/**
 * 微信侧订单状态（order_state）：
 *   1 待发货 / 2 已发货 / 3 确认收货 / 4 交易完成 / 5 已退款 / 6 已关闭
 */
export const WX_ORDER_STATE = {
  TO_SHIP: 1,
  SHIPPED: 2,
  RECEIVED: 3,
  FINISHED: 4,
  REFUNDED: 5,
  CLOSED: 6,
} as const;

export interface WechatOrderInfo {
  ok: boolean;
  orderState?: number;
  transactionId?: string;
  /** 微信侧录入的物流单号（商家在微信后台录发货时填写，可能为空） */
  trackingNo?: string;
  /** 微信侧物流公司编码（如 SF / ZTO） */
  expressCompany?: string;
  error?: string;
}

/** 微信侧 shipping 结构（只取我们需要的字段） */
interface WxShipping {
  delivery_mode?: number;
  logistics_type?: number;
  tracking_no?: string;
  express_company?: string;
  finish_shipping?: boolean;
}

/**
 * 查询微信侧订单状态。
 *
 * 为什么需要：商家在微信后台「订单发货管理 → 发货信息录入」里录发货，只会更新微信侧的
 * 订单状态（用户「我-小店与卡包-小程序购物订单」里能看到），**不会回写商家自己的库**。
 * 只靠本地状态机就会出现「商家已发货、小程序仍显示待发货」。
 * 同理，微信侧 T+10 自动确认收货也不会回写。必须主动拉取。
 */
export async function getWechatOrderState(orderNo: string): Promise<WechatOrderInfo> {
  if (!env.wxAppid || !env.wxSecret) return { ok: false, error: '未配置 WX_APPID / WX_APPSECRET' };
  const mchid = env.pay.direct.mchid || env.pay.subMchId;
  if (!mchid) return { ok: false, error: '未配置商户号' };
  try {
    const data = await postWx<{
      errcode?: number;
      errmsg?: string;
      order?: { order_state?: number; transaction_id?: string; shipping?: WxShipping };
    }>(
      '/wxa/sec/order/get_order',
      // merchant_id 必须是数字，传字符串会 40097 invalid args
      { merchant_id: Number(mchid), merchant_trade_no: orderNo },
    );
    if (data.errcode !== 0) {
      return { ok: false, error: `${data.errcode}: ${data.errmsg ?? ''}` };
    }
    const shipping = data.order?.shipping;
    const trackingNo = (shipping?.tracking_no || '').trim();
    return {
      ok: true,
      orderState: data.order?.order_state,
      transactionId: data.order?.transaction_id,
      // logistics_type 为 2/3/4（虚拟商品、无需物流、同城配送）时通常没有单号，不能当异常
      trackingNo: trackingNo || undefined,
      expressCompany: shipping?.express_company || undefined,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface WxDiagnoseResult {
  appidConfigured: boolean;
  secretConfigured: boolean;
  mchid: string | null;
  /** 小程序开放接口是否已降级为 HTTP（云托管云调用链路的正常表现） */
  wxHttpFallback: boolean;
  /** 是否处于云调用免鉴权模式（容器内由开放接口服务注入鉴权，无需 access_token） */
  cloudCallMode: boolean;
  /** 出网探测：容器能不能连上微信的各个域名（DNS + TCP + TLS 一起验） */
  network: { host: string; ok: boolean; detail: string }[];
  token: { ok: boolean; error?: string };
  order: WechatOrderInfo;
}

/**
 * 出网探测：分别打一下小程序接口域名与支付域名。
 *
 * 为什么需要：云托管容器的出网策略/内网 DNS 一旦变化，报错只是一句
 * 「fetch failed」，看不出是 DNS 挂了、还是连不通、还是证书问题。
 * 这里把每个域名的底层错误原文带出来，一次就能定位。
 */
async function probeHosts(): Promise<{ host: string; ok: boolean; detail: string }[]> {
  const probes: { host: string; run: () => Promise<Response> }[] = [
    {
      host: 'api.weixin.qq.com（小程序开放接口）',
      run: () => wxFetch('/', { method: 'GET', signal: AbortSignal.timeout(8000) }),
    },
    {
      host: 'api.mch.weixin.qq.com（微信支付）',
      run: () => fetch('https://api.mch.weixin.qq.com/', { method: 'HEAD', signal: AbortSignal.timeout(8000) }),
    },
  ];

  const results = [];
  for (const probe of probes) {
    const started = Date.now();
    try {
      const res = await probe.run();
      results.push({ host: probe.host, ok: true, detail: `HTTP ${res.status}，耗时 ${Date.now() - started}ms` });
    } catch (error) {
      const e = error as { name?: string; message?: string; cause?: { code?: string; message?: string } };
      const detail = [e.name, e.message, e.cause?.code, e.cause?.message].filter(Boolean).join(' | ');
      results.push({ host: probe.host, ok: false, detail: detail || String(error) });
    }
  }
  return results;
}

/**
 * 微信接口自检。
 *
 * 线上排障时最痛的是「同步点了没反应」——既看不到 token 是否拿到，也看不到
 * get_order 返回了什么。这个接口把链路逐段暴露出来（全部只读，不含密钥）：
 *   1. 三个关键环境变量是否配好
 *   2. 容器能不能出网访问微信域名
 *   3. 能不能拿到 access_token（拿不到会把 errcode 带回来）
 *   4. get_order 的真实返回
 */
export async function diagnoseWechatOrder(orderNo: string): Promise<WxDiagnoseResult> {
  const mchid = env.pay.direct.mchid || env.pay.subMchId || null;

  let token: { ok: boolean; error?: string };
  try {
    await getAccessToken();
    token = { ok: true };
  } catch (error) {
    token = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  return {
    appidConfigured: Boolean(env.wxAppid),
    secretConfigured: Boolean(env.wxSecret),
    mchid,
    wxHttpFallback: isUsingHttpFallback(),
    cloudCallMode: isCloudCallMode(),
    network: await probeHosts(),
    token,
    order: await getWechatOrderState(orderNo),
  };
}
