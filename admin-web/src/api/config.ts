import { api } from './http';

export interface AnnouncementConfig {
  enabled: boolean;
  title: string;
  content: string;
  updatedAt: string | null;
}

export interface AfterSaleRuleConfig {
  /** 到点自动同意并退款；关闭时到点只标红提醒 */
  autoApproveEnabled: boolean;
  /** 既是「超时标红」阈值，也是「自动同意」阈值 */
  autoApproveHours: number;
  updatedAt: string | null;
}

export interface AppConfig {
  announcement: AnnouncementConfig;
  afterSale: AfterSaleRuleConfig;
  /** 只读：来自环境变量的其余售后参数 */
  env: {
    escalateDays: number;
    returnDays: number;
    alertHour: number;
    autoApproveFromEnv: boolean;
    reviewHoursFromEnv: number;
  };
}

export interface AppConfigPatch {
  announcement?: { enabled?: boolean; title?: string; content?: string };
  afterSale?: { autoApproveEnabled?: boolean; autoApproveHours?: number };
}

export function getAppConfig(): Promise<AppConfig> {
  return api.get<AppConfig>('/admin/config');
}

/** 部分更新：只传要改的那一块，另一块不受影响 */
export function saveAppConfig(patch: AppConfigPatch): Promise<AppConfig> {
  return api.put<AppConfig>('/admin/config', patch);
}
