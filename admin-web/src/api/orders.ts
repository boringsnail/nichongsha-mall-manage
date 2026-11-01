import { api } from './http';

export type OrderStatus = 'PENDING_PAYMENT' | 'PAID' | 'SHIPPED' | 'COMPLETED' | 'CANCELLED';

export interface AdminOrderRow {
  orderNo: string;
  user: { openid: string; nickname: string | null };
  totalAmount: number;
  freight: number;
  /** 我们付给骑手/快递的配送成本（分），商家在订单里录入，只影响净营业额 */
  deliveryCost: number;
  /** 已退款金额（分） */
  refundedAmount: number;
  status: OrderStatus;
  remark: string | null;
  createdAt: string;
  itemCount: number;
  /** 订单最新一笔售后的状态，无售后为 null */
  afterSaleStatus?: string | null;
  hasAfterSale?: boolean;
  /** 是否已上传配送照片（列表只给标记，不塞图片地址） */
  hasDeliveryPhoto?: boolean;
}

export interface AdminOrderDetail extends Omit<AdminOrderRow, 'itemCount'> {
  paidAt: string | null;
  shippedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  logisticsCompany: string | null;
  trackingNo: string | null;
  /** 物流模式：1 快递发货 / 2 同城配送 / 3 虚拟商品 / 4 用户自提 */
  logisticsType: number;
  address: { receiverName: string; phone: string; province: string; city: string; district: string; detail: string };
  /** 配送照片（绝对地址，最多 3 张）：发货/送达时拍的存证，小程序订单详情里给顾客看 */
  deliveryPhotos: string[];
  items: { productName: string; specName: string; coverImage: string; price: number; quantity: number }[];
}

export interface Page<T> {
  list: T[];
  total: number;
  page: number;
  size: number;
}

/** 订单列表的附加信息：自动同步本轮更新了几笔、服务端时间 */
export interface OrderListPage extends Page<AdminOrderRow> {
  synced?: number;
  serverTime?: string;
}

export function adminListOrders(params: {
  status?: OrderStatus;
  page?: number;
  size?: number;
  /** 传 1 让服务端顺手和微信对一次账（单笔 30 秒节流，前端可以放心 5 秒一刷） */
  autoSync?: 1;
}): Promise<OrderListPage> {
  return api.get<OrderListPage>('/admin/orders', { params });
}

export function adminGetOrder(orderNo: string): Promise<AdminOrderDetail> {
  return api.get<AdminOrderDetail>(`/admin/orders/${orderNo}`);
}

/** 物流模式，取值对齐微信 upload_shipping_info.logistics_type */
export const LOGISTICS_TYPE = {
  EXPRESS: 1,
  LOCAL_DELIVERY: 2,
  VIRTUAL: 3,
  PICKUP: 4,
} as const;

export interface ShipInput {
  logisticsType: number;
  /** 快递必填；同城配送/自提由后端写死为配送方式文案 */
  logisticsCompany?: string;
  /** 快递必填；自提时可选填提货码 */
  trackingNo?: string;
  /** 发货时顺手拍的配送照片（选填，最多 3 张） */
  photos?: string[];
}

export function adminShipOrder(orderNo: string, data: ShipInput): Promise<AdminOrderDetail> {
  return api.post<AdminOrderDetail>(`/admin/orders/${orderNo}/ship`, data);
}

export interface WxSyncResult {
  orderNo: string;
  changed: boolean;
  before: OrderStatus;
  status: OrderStatus;
  shippedAt: string | null;
  logisticsCompany: string | null;
  trackingNo: string | null;
  /** 本地无变化时附带微信侧原始状态，用于区分「微信还没发货」与「拉取失败」 */
  wxState: {
    ok: boolean;
    orderState: number | null;
    trackingNo: string | null;
    error: string | null;
  } | null;
}

export interface WxSyncBatchResult {
  checked: number;
  updated: number;
  failed: number;
}

/** 手动把单笔订单的微信侧履约状态拉回本地 */
export function adminSyncOrderFromWechat(orderNo: string): Promise<WxSyncResult> {
  return api.post<WxSyncResult>(`/admin/orders/${orderNo}/sync-wx`);
}

/** 批量对账：近 60 天「已支付 / 已发货」订单逐笔与微信核对 */
export function adminSyncOrdersFromWechat(): Promise<WxSyncBatchResult> {
  return api.post<WxSyncBatchResult>('/admin/orders/sync-wx');
}

export interface DeliveryCostResult {
  orderNo: string;
  deliveryCost: number;
  /** 修改前的值，方便前端做撤销提示 */
  previous: number;
}

/**
 * 录入配送成本（我们付给骑手/快递的钱，单位分）。
 * 只写 deliveryCost 这一列，不动订单金额与运费 —— 顾客付的 freight 是收入侧，这里是成本侧。
 */
export function adminSetDeliveryCost(orderNo: string, deliveryCost: number): Promise<DeliveryCostResult> {
  return api.put<DeliveryCostResult>(`/admin/orders/${orderNo}/delivery-cost`, { deliveryCost });
}

export interface DeliveryPhotosResult {
  orderNo: string;
  /** 保存后的照片列表 */
  deliveryPhotos: string[];
  /** 保存前的照片列表，方便前端做撤销提示 */
  previous: string[];
}

/**
 * 录入配送照片（整组替换，传 [] 即清空）。
 * 和配送成本分开一个接口：成本是「钱」，照片是「履约凭证」，补传时机完全不同。
 */
export function adminSetDeliveryPhotos(orderNo: string, photos: string[]): Promise<DeliveryPhotosResult> {
  return api.put<DeliveryPhotosResult>(`/admin/orders/${orderNo}/delivery-photos`, { photos });
}
