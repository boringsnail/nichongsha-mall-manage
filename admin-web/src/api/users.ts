import { api } from './http';
import type { Page } from './orders';

export interface AdminUserRow {
  id: number;
  openid: string;
  nickname: string | null;
  avatarUrl: string | null;
  phone: string | null;
  receiverName: string | null;
  createdAt: string;
  orderCount: number;
  paidOrderCount: number;
  /** 累计成交额（分） */
  totalSpent: number;
  lastPaidAt: string | null;
  addressCount?: number;
}

export interface AdminUserAddress {
  id: number;
  receiverName: string;
  phone: string;
  province: string;
  city: string;
  district: string;
  detail: string;
  isDefault: boolean;
}

export interface AdminUserOrder {
  orderNo: string;
  status: string;
  /** 订单金额（分） */
  totalAmount: number;
  createdAt: string;
  paidAt: string | null;
  itemCount: number;
  goodsSummary: string;
}

export interface AdminUserDetail {
  id: number;
  openid: string;
  nickname: string | null;
  avatarUrl: string | null;
  phone: string | null;
  createdAt: string;
  orderCount: number;
  paidOrderCount: number;
  totalSpent: number;
  lastPaidAt: string | null;
  avgOrderValue: number;
  addresses: AdminUserAddress[];
  recentOrders: AdminUserOrder[];
}

export function adminListUsers(params: {
  keyword?: string;
  sort?: 'recent' | 'spend';
  page?: number;
  size?: number;
}): Promise<Page<AdminUserRow>> {
  return api.get<Page<AdminUserRow>>('/admin/users', { params });
}

export function adminGetUser(id: number): Promise<AdminUserDetail> {
  return api.get<AdminUserDetail>(`/admin/users/${id}`);
}
