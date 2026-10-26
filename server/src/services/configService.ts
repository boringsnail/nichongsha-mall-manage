import { prisma } from '../db.js';

/**
 * 键值配置（AppConfig 表）+ 内存缓存。
 *
 * 为什么要有缓存：售后列表每行都要判断「是否超时」，`afterSaleReviewHours()` 是同步函数、
 * 每页要被调几十次；如果每次都查库，等于给列表页加几十次 round-trip。
 * 这里在启动时和写入后各刷一次，读取全部走内存。
 *
 * 缓存未加载时（例如单测直接 import 了 afterSaleService）会退回环境变量，
 * 保证行为与改造前一致，不会因为「忘了刷缓存」而算出 0 小时。
 */

export const CONFIG_KEYS = {
  announcementEnabled: 'announcement.enabled',
  announcementTitle: 'announcement.title',
  announcementContent: 'announcement.content',
  autoApproveEnabled: 'afterSale.autoApproveEnabled',
  autoApproveHours: 'afterSale.autoApproveHours',
} as const;

/** 默认值集中在这里：加配置项只改这一处，不用写迁移 */
export const CONFIG_DEFAULTS: Record<string, string> = {
  [CONFIG_KEYS.announcementEnabled]: '0',
  [CONFIG_KEYS.announcementTitle]: '',
  [CONFIG_KEYS.announcementContent]: '',
  // 默认关闭：用户明确要求过「超过时限只要商户没确认就不能退款」，
  // 想开启必须到配置页手动打开，避免升级版本后行为突变。
  [CONFIG_KEYS.autoApproveEnabled]: '0',
  [CONFIG_KEYS.autoApproveHours]: '48',
};

export const CONFIG_LIMITS = {
  titleMax: 40,
  contentMax: 500,
  hoursMin: 1,
  hoursMax: 720,
} as const;

let cache: Map<string, string> | null = null;
let loading: Promise<void> | null = null;

function toBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function toPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

/** 从库里把配置读进内存；并发调用只会真正执行一次 */
export async function refreshConfigCache(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    try {
      const rows = await prisma.appConfig.findMany();
      const next = new Map<string, string>();
      for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) next.set(key, value);
      for (const row of rows) next.set(row.key, row.value);
      cache = next;
    } catch (error) {
      // 配置表还没迁移（新库首启）时不要让整个服务起不来，退回默认值
      console.warn('[config] 读取配置失败，暂用默认值：', error instanceof Error ? error.message : error);
      cache = new Map(Object.entries(CONFIG_DEFAULTS));
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** 只读访问：缓存没准备好时返回 undefined，由调用方决定回退值 */
export function peekConfig(key: string): string | undefined {
  return cache?.get(key);
}

export function configBool(key: string, fallback: boolean): boolean {
  return toBool(peekConfig(key), fallback);
}

export function configInt(key: string, fallback: number): number {
  return toPositiveInt(peekConfig(key), fallback);
}

export interface AnnouncementView {
  enabled: boolean;
  title: string;
  content: string;
  updatedAt: string | null;
}

export interface AfterSaleRuleView {
  /** 到点是否自动同意并退款；关闭时到点只标红提醒 */
  autoApproveEnabled: boolean;
  /** 既是「超时标红」阈值，也是「自动同意」阈值，单位小时 */
  autoApproveHours: number;
  updatedAt: string | null;
}

export interface AppConfigView {
  announcement: AnnouncementView;
  afterSale: AfterSaleRuleView;
  /** 只读：来自环境变量的其余售后参数，配置页展示用 */
  env: {
    escalateDays: number;
    returnDays: number;
    alertHour: number;
    autoApproveFromEnv: boolean;
    reviewHoursFromEnv: number;
  };
}

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envBool(name: string): boolean {
  const v = (process.env[name] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export async function getAppConfig(): Promise<AppConfigView> {
  if (!cache) await refreshConfigCache();
  const rows = await prisma.appConfig.findMany({
    where: {
      key: {
        in: [CONFIG_KEYS.announcementTitle, CONFIG_KEYS.announcementContent, CONFIG_KEYS.autoApproveHours],
      },
    },
    select: { key: true, updatedAt: true },
  });
  const updatedAt = new Map(rows.map((r) => [r.key, r.updatedAt.toISOString()]));

  return {
    announcement: {
      enabled: configBool(CONFIG_KEYS.announcementEnabled, false),
      title: peekConfig(CONFIG_KEYS.announcementTitle) ?? '',
      content: peekConfig(CONFIG_KEYS.announcementContent) ?? '',
      updatedAt: updatedAt.get(CONFIG_KEYS.announcementTitle) ?? updatedAt.get(CONFIG_KEYS.announcementContent) ?? null,
    },
    afterSale: {
      autoApproveEnabled: configBool(CONFIG_KEYS.autoApproveEnabled, false),
      autoApproveHours: configInt(CONFIG_KEYS.autoApproveHours, 48),
      updatedAt: updatedAt.get(CONFIG_KEYS.autoApproveHours) ?? null,
    },
    env: {
      escalateDays: envNumber('AFTER_SALE_ESCALATE_DAYS', 3),
      returnDays: envNumber('AFTER_SALE_RETURN_DAYS', 7),
      alertHour: envNumber('AFTER_SALE_ALERT_HOUR', 9),
      autoApproveFromEnv: envBool('AFTER_SALE_AUTO_APPROVE'),
      reviewHoursFromEnv: envNumber('AFTER_SALE_REVIEW_HOURS', 48),
    },
  };
}

export interface AppConfigPatch {
  announcement?: { enabled?: boolean; title?: string; content?: string };
  afterSale?: { autoApproveEnabled?: boolean; autoApproveHours?: number };
}

/** 写入：只 upsert 传进来的键，其余保持不动；写完立刻刷缓存，接口返回即生效 */
export async function updateAppConfig(patch: AppConfigPatch): Promise<AppConfigView> {
  const pairs: Array<[string, string]> = [];

  if (patch.announcement) {
    const a = patch.announcement;
    if (a.enabled !== undefined) pairs.push([CONFIG_KEYS.announcementEnabled, a.enabled ? '1' : '0']);
    if (a.title !== undefined) pairs.push([CONFIG_KEYS.announcementTitle, a.title.trim()]);
    if (a.content !== undefined) pairs.push([CONFIG_KEYS.announcementContent, a.content.trim()]);
  }
  if (patch.afterSale) {
    const s = patch.afterSale;
    if (s.autoApproveEnabled !== undefined) pairs.push([CONFIG_KEYS.autoApproveEnabled, s.autoApproveEnabled ? '1' : '0']);
    if (s.autoApproveHours !== undefined) pairs.push([CONFIG_KEYS.autoApproveHours, String(Math.round(s.autoApproveHours))]);
  }

  for (const [key, value] of pairs) {
    await prisma.appConfig.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  await refreshConfigCache();
  return getAppConfig();
}

/** C 端公告：只暴露展示所需字段，且关闭时返回 null */
export async function getPublicAnnouncement(): Promise<{ title: string; content: string } | null> {
  if (!cache) await refreshConfigCache();
  if (!configBool(CONFIG_KEYS.announcementEnabled, false)) return null;
  const title = (peekConfig(CONFIG_KEYS.announcementTitle) ?? '').trim();
  const content = (peekConfig(CONFIG_KEYS.announcementContent) ?? '').trim();
  if (!title && !content) return null;
  return { title, content };
}
