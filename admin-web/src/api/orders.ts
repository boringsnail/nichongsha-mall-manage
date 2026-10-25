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

export function adminShipOrder(orderNo: string, data: { logisticsCompany: string; trackingNo: string }): Promise<AdminOrderDetail> {
  return api.post<AdminOrderDetail>(`/admin/orders/${orderNo}/ship`, data);
}
