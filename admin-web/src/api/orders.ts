import { api } from './http';

export type OrderStatus = 'PENDING_PAYMENT' | 'PAID' | 'SHIPPED' | 'COMPLETED' | 'CANCELLED';

export interface AdminOrderRow {
  orderNo: string;
  user: { openid: string; nickname: string | null };
  totalAmount: number;
  freight: number;
  status: OrderStatus;
  remark: string | null;
  createdAt: string;
  itemCount: number;
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
  items: { productName: string; specName: string; coverImage: string; price: number; quantity: number }[];
}

export interface Page<T> {
  list: T[];
  total: number;
  page: number;
  size: number;
}

export function adminListOrders(params: { status?: OrderStatus; page?: number; size?: number }): Promise<Page<AdminOrderRow>> {
  return api.get<Page<AdminOrderRow>>('/admin/orders', { params });
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
