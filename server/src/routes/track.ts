import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { prisma } from '../db.js';
import { verifyToken } from '../auth/jwt.js';

// 埋点事件白名单：只接受已知事件，避免客户端写入任意 eventType 污染统计
export const EVENT_TYPES = [
  'app_launch',    // 小程序启动（含会话建立）
  'product_view',  // 商品详情浏览
  'add_cart',      // 加入购物车
  'create_order',  // 创建订单
  'pay_success',   // 支付成功
] as const;

export const trackRouter = Router();

const bodySchema = z.object({
  eventType: z.enum(EVENT_TYPES),
  sessionId: z.string().min(1).max(64).optional(),
  productId: z.coerce.number().int().positive().optional(),
  skuId: z.coerce.number().int().positive().optional(),
  orderNo: z.string().max(32).optional(),
  amount: z.coerce.number().int().nonnegative().optional(),
});

// ---- 简易滑动窗口限流：单 IP 每分钟 N 条，防止埋点接口被刷爆 ----
// 阈值可经 TRACK_RATE_LIMIT 覆盖（测试用），生产默认 600
const WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

function maxPerWindow(): number {
  const n = Number(process.env.TRACK_RATE_LIMIT ?? 600);
  return Number.isFinite(n) && n > 0 ? n : 600;
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const limit = maxPerWindow();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= limit) {
    hits.set(ip, list);
    return true;
  }
  list.push(now);
  hits.set(ip, list);
  // 顺带清理空桶，避免 Map 无限增长
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.length === 0) hits.delete(k);
  }
  return false;
}

/**
 * 仅供测试使用：清空限流窗口
 * 限流器按 IP 累计，而测试全部走 127.0.0.1，会互相污染，故显式重置。
 */
export function __resetRateLimiter() {
  hits.clear();
}

/**
 * POST /api/track
 * 小程序行为埋点上报。
 * - 公开接口（未登录访客也要能上报），登录态可选：带 token 时关联 userId
 * - 上报失败绝不能影响用户主流程，因此前端应 fire-and-forget
 */
trackRouter.post(
  '/',
  validate({ body: bodySchema }),
  asyncHandler(async (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (rateLimited(ip)) {
      // 埋点超限静默丢弃，不报错打扰端上
      return res.json({ code: 0, data: { accepted: false } });
    }

    const b = req.body as z.infer<typeof bodySchema>;

    // 可选登录：解析失败不报错，按游客处理
    let userId: number | undefined;
    let openid: string | undefined;
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token) {
      try {
        const auth = verifyToken(token);
        if (auth.role === 'user') {
          userId = auth.uid;
          const u = await prisma.user.findUnique({ where: { id: auth.uid }, select: { openid: true } });
          openid = u?.openid;
        }
      } catch {
        /* 忽略：埋点不因登录态失效而失败 */
      }
    }

    await prisma.userEvent.create({
      data: {
        eventType: b.eventType,
        sessionId: b.sessionId ?? null,
        userId: userId ?? null,
        openid: openid ?? null,
        productId: b.productId ?? null,
        skuId: b.skuId ?? null,
        orderNo: b.orderNo ?? null,
        amount: b.amount ?? null,
      },
    });

    res.json({ code: 0, data: { accepted: true } });
  })
);
