import { api } from './http';
import type { MerchantInfo } from '@/stores/auth';

export interface AdminLoginResult {
  token: string;
  merchant: MerchantInfo;
}

export function adminLogin(username: string, password: string): Promise<AdminLoginResult> {
  return api.post<AdminLoginResult>('/admin/auth/login', { username, password });
}
