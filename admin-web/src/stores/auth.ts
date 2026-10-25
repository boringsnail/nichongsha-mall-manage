import { defineStore } from 'pinia';

export interface MerchantInfo {
  id: number;
  username: string;
  nickname?: string;
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem('admin_token') || '',
    merchant: JSON.parse(localStorage.getItem('admin_merchant') || 'null') as MerchantInfo | null,
  }),
  actions: {
    setAuth(token: string, merchant: MerchantInfo) {
      this.token = token;
      this.merchant = merchant;
      localStorage.setItem('admin_token', token);
      localStorage.setItem('admin_merchant', JSON.stringify(merchant));
    },
    logout() {
      this.token = '';
      this.merchant = null;
      localStorage.removeItem('admin_token');
      localStorage.removeItem('admin_merchant');
    },
  },
});