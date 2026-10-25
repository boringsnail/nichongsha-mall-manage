import { prisma } from '../db.js';
import { hashPassword, verifyPassword } from '../auth/password.js';

export type EnsureMerchantAction = 'created' | 'updated' | 'unchanged';

export interface EnsureMerchantResult {
  action: EnsureMerchantAction;
  username: string;
}

/** 生产环境防止把弱口令配上去；开发/测试环境不受限（本地种子用「商家123」这类短口令） */
export const MIN_ADMIN_PASSWORD_LENGTH = 8;

/**
 * 确保商家（管控台）账号存在，且密码与配置一致。
 *
 * 只操作 `Merchant` 一张表：不建分类/商品，不动任何业务数据，可重复执行。
 * 用途：云端库是空库时，靠环境变量 `ADMIN_USERNAME`/`ADMIN_PASSWORD` 在启动阶段
 * 自举出第一个管控台账号；改密码也走同一入口。
 */
export async function ensureMerchantAccount(
  username: string,
  password: string,
  nickname?: string,
): Promise<EnsureMerchantResult> {
  const existing = await prisma.merchant.findUnique({ where: { username } });
  if (!existing) {
    await prisma.merchant.create({
      data: {
        username,
        passwordHash: await hashPassword(password),
        nickname: nickname?.trim() || '掌柜',
      },
    });
    return { action: 'created', username };
  }

  // 密码已一致就不重复写库（避免每次启动都重算 bcrypt 并刷新 updatedAt 语义）
  if (await verifyPassword(password, existing.passwordHash)) {
    return { action: 'unchanged', username };
  }

  await prisma.merchant.update({
    where: { username },
    data: { passwordHash: await hashPassword(password) },
  });
  return { action: 'updated', username };
}

/** 读取并校验 ADMIN_USERNAME/ADMIN_PASSWORD（都没配置时返回 null，表示跳过自举） */
export function readAdminBootstrapConfig(
  source: Record<string, string | undefined> = process.env,
  requireStrong = process.env.NODE_ENV === 'production',
): { username: string; password: string } | null {
  const username = source.ADMIN_USERNAME?.trim();
  const password = source.ADMIN_PASSWORD;
  if (!username && !password) return null;
  if (!username || !password) {
    throw new Error('ADMIN_USERNAME 与 ADMIN_PASSWORD 必须同时配置（或都不配）');
  }
  if (requireStrong && password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new Error(`ADMIN_PASSWORD 至少 ${MIN_ADMIN_PASSWORD_LENGTH} 位（当前 ${password.length} 位）`);
  }
  return { username, password };
}
