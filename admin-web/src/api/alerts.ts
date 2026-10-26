import { api } from './http';

export interface AlertOrder {
  orderNo: string;
  totalAmount: number;
  itemCount: number;
  buyer: string;
  createdAt: string;
}

export interface AlertAfterSale {
  afterSaleNo: string;
  orderNo: string;
  refundAmount: number;
  type: string;
  reasonText: string;
  createdAt: string;
}

export interface AdminAlerts {
  serverTime: string;
  lookbackHours: number;
  orders: AlertOrder[];
  afterSales: AlertAfterSale[];
  pendingShipCount: number;
  pendingAfterSaleCount: number;
}

/** 订单 / 售后强提醒的数据源（前端每 20 秒轮询一次） */
export function adminListAlerts(): Promise<AdminAlerts> {
  return api.get<AdminAlerts>('/admin/alerts');
}
