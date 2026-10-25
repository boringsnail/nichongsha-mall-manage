import { api } from './http';
import type { Page } from './orders';

export type AfterSaleType = 'REFUND_ONLY' | 'RETURN_REFUND';

export type AfterSaleStatus =
  | 'PENDING'
  | 'AGREED'
  | 'WAIT_RETURN'
  | 'RETURNING'
  | 'REFUNDING'
  | 'COMPLETED'
  | 'REJECTED'
  | 'CANCELLED';

export interface AfterSaleItem {
  productName: string;
  specName: string;
  coverImage: string;
  price: number;
  quantity: number;
}

export interface AfterSaleRow {
  afterSaleNo: string;
  orderNo: string;
  type: AfterSaleType;
  status: AfterSaleStatus;
  /** 原因枚举值 */
  reason: string;
  /** 原因中文文案（后端已翻译） */
  reasonText: string;
  description: string | null;
  /** 用户上传的凭证图（最多 6 张） */
  images: string[];
  /** 申请退款金额（分） */
  refundAmount: number;
  /** 已退金额（分） */
  refundedAmount: number;
  /** 微信退款单号 */
  refundNo: string | null;
  rejectReason: string | null;
  returnLogisticsCompany: string | null;
  returnTrackingNo: string | null;
  agreedAt: string | null;
  returnedAt: string | null;
  receivedAt: string | null;
  refundedAt: string | null;
  rejectedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  /** 待处理且已超过商家处理时限（仅提醒，不会自动退款） */
  overdue?: boolean;
  /** 订单实付金额（分） */
  orderTotal?: number;
  orderStatus?: string;
  user?: { openid: string; nickname: string | null };
  items?: AfterSaleItem[];
}

export interface AfterSalePage extends Page<AfterSaleRow> {
  /** 各状态数量（全量口径），用于标签页待办数 */
  counts: Partial<Record<AfterSaleStatus, number>>;
  /** 待处理中已超时的笔数（仅提醒，不会自动退款） */
  overdueCount?: number;
  /** 商家处理提醒时限（小时）：超时只在界面标红，不会自动同意 */
  reviewHours: number;
  /** 买家寄回时限（天）：超时自动关闭；0 表示不自动关闭 */
  returnDays: number;
  /** 是否开启了「超时自动同意退款」（默认关闭） */
  autoApprove?: boolean;
}

export function adminListAfterSales(params: {
  status?: AfterSaleStatus;
  keyword?: string;
  page?: number;
  size?: number;
}): Promise<AfterSalePage> {
  return api.get<AfterSalePage>('/admin/after-sales', { params });
}

export function adminGetAfterSale(afterSaleNo: string): Promise<AfterSaleRow> {
  return api.get<AfterSaleRow>(`/admin/after-sales/${afterSaleNo}`);
}

/** 同意：仅退款会立刻发起原路退款；退货退款进入「待买家退货」 */
export function adminApproveAfterSale(afterSaleNo: string): Promise<AfterSaleRow> {
  return api.post<AfterSaleRow>(`/admin/after-sales/${afterSaleNo}/approve`);
}

export function adminRejectAfterSale(afterSaleNo: string, reason: string): Promise<AfterSaleRow> {
  return api.post<AfterSaleRow>(`/admin/after-sales/${afterSaleNo}/reject`, { reason });
}

/** 确认收到退货并退款（仅退货退款、状态为「退货中」） */
export function adminReceiveAfterSale(afterSaleNo: string): Promise<AfterSaleRow> {
  return api.post<AfterSaleRow>(`/admin/after-sales/${afterSaleNo}/receive`);
}
