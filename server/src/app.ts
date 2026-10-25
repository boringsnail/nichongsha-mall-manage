import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { requireAuth } from './middleware/auth.js';
import { authRouter, adminAuthRouter } from './routes/auth.js';
import { userRouter } from './routes/user.js';
import { cartRouter } from './routes/cart.js';
import { ordersRouter } from './routes/orders.js';
import { adminCategoriesRouter } from './routes/adminCategories.js';
import { adminProductsRouter } from './routes/adminProducts.js';
import { adminSkusRouter } from './routes/adminSkus.js';
import { adminOrdersRouter } from './routes/adminOrders.js';
import { adminAfterSalesRouter } from './routes/adminAfterSales.js';
import { adminUsersRouter } from './routes/adminUsers.js';
import { afterSalesRouter } from './routes/afterSales.js';
import { adminStatsRouter } from './routes/adminStats.js';
import { productsRouter, categoriesRouter } from './routes/products.js';
import { trackRouter } from './routes/track.js';
import { payRouter } from './routes/pay.js';

export function createApp() {
  const app = express();
  // 允许 admin-web 和小程序后端通信；上线前将 ADMIN_ORIGINS 改为实际域名
  const ADMIN_ORIGINS = process.env.ADMIN_ORIGINS
    ? process.env.ADMIN_ORIGINS.split(',').map((o) => o.trim())
    : ['http://localhost:5173'];
  const MINIPROGRAM_ORIGINS = process.env.MINIPROGRAM_ORIGINS
    ? process.env.MINIPROGRAM_ORIGINS.split(',').map((o) => o.trim())
    : [];
  const allOrigins = [...ADMIN_ORIGINS, ...MINIPROGRAM_ORIGINS];
  app.use(cors({
    origin: allOrigins.length > 0 ? (origin, cb) => {
      // 小程序请求 origin 为 devtools:// 等，开发期放行
      if (!origin) return cb(null, true);
      if (allOrigins.includes(origin) || origin.endsWith('.wechat.com')) return cb(null, true);
      // 开发期不校验
      if (process.env.NODE_ENV !== 'production') return cb(null, true);
      cb(new Error('不允许的跨域请求'));
    } : true,
    credentials: true,
  }));
  // 商品批量导入可能一次带上千行 JSON，默认 100kb 不够；
  // 同时保留原始报文体：微信支付 APIv3 回调验签必须用未经重新序列化的原始 body。
  app.use(
    express.json({
      limit: '2mb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    }),
  );

  app.get('/api/health', (_req, res) => {
    res.json({ code: 0, data: { status: 'ok' } });
  });

  // 云托管/容器平台的健康检查默认探活路径常常是 `/`，探到非 2xx 会判定「启动检查失败 → 部署失败」。
  // 这里给根路径与 /healthz 一个轻量 200，避免进程明明在监听却被判失败。
  app.get('/', (_req, res) => {
    res.json({ code: 0, data: { service: 'nichongsha-api', status: 'ok' } });
  });
  app.get('/healthz', (_req, res) => {
    res.type('text/plain').send('ok\n');
  });

  app.use('/api/auth', authRouter);
  app.use('/api/track', trackRouter);
  // 微信支付结果回调：由云托管平台内部推送，不带用户态；安全性由回调内主动查单保证
  app.use('/api/pay', payRouter);
  app.use('/api/user', requireAuth('user'), userRouter);
  app.use('/api/cart', requireAuth('user'), cartRouter);
  app.use('/api/orders', requireAuth('user'), ordersRouter);
  app.use('/api/after-sales', requireAuth('user'), afterSalesRouter);
  app.use('/api/categories', categoriesRouter);
  app.use('/api/products', productsRouter);
  app.use('/api/admin/auth', adminAuthRouter);
  app.use('/api/admin/categories', requireAuth('merchant'), adminCategoriesRouter);
  app.use('/api/admin/products', requireAuth('merchant'), adminProductsRouter);
  app.use('/api/admin/skus', requireAuth('merchant'), adminSkusRouter);
  app.use('/api/admin/orders', requireAuth('merchant'), adminOrdersRouter);
  app.use('/api/admin/after-sales', requireAuth('merchant'), adminAfterSalesRouter);
  app.use('/api/admin/users', requireAuth('merchant'), adminUsersRouter);
  app.use('/api/admin/stats', requireAuth('merchant'), adminStatsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}