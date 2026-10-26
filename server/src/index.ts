import { createApp } from './app.js';
import { env } from './config/env.js';
import {
  cancelExpiredOrders,
  reconcilePendingPayments,
  reconcileFulfillment,
  autoCompleteShippedOrders,
  orderExpireMinutes,
  autoConfirmDays,
} from './services/orderService.js';
import { autoProgressAfterSales, alertOverdueAfterSales, reconcileRefundingAfterSales } from './services/afterSaleService.js';
import { refreshConfigCache } from './services/configService.js';

const HOST = process.env.HOST ?? '0.0.0.0';
const app = createApp();

// 先把后台配置读进内存：售后超时判定、自动同意开关、C 端公告都读这份缓存。
// 不阻塞监听——读失败会退回默认值，只是日志里多一条 warn。
refreshConfigCache()
  .then(() => console.log('[config] 后台配置已加载'))
  .catch(() => {});

const server = app.listen(env.port, HOST, () => {
  console.log(`[nichongsha-server] listening on http://${HOST}:${env.port}`);
});

/**
 * 额外端口监听（**默认关闭**）。
 *
 * 微信云托管的平台限制：一个服务只能开启一个监听端口（见《微信云托管开发常识》：
 * 「不支持一个服务开启多个监听端口」）。因此默认只监听 env.port（Dockerfile 里为 8080），
 * 由控制台「服务设置 → 端口」与之保持一致即可。
 *
 * 仅在自建容器/特殊探针环境确有需要时，用 EXTRA_LISTEN_PORTS=80,3000 显式打开；
 * 额外端口监听失败只告警，不影响主端口。
 */
const extraPorts = (process.env.EXTRA_LISTEN_PORTS ?? '')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((port) => Number.isInteger(port) && port > 0 && port !== env.port);

for (const port of extraPorts) {
  const extra = app.listen(port, HOST, () => {
    console.log(`[nichongsha-server] 兼容监听 http://${HOST}:${port}（平台探针端口兜底）`);
  });
  extra.on('error', (error: NodeJS.ErrnoException) => {
    console.warn(
      `[warn] 额外监听端口 ${port} 失败（${error.code ?? error.message}），不影响主端口 ${env.port}；` +
      `若平台探针打的是 ${port}，请把云托管服务的「端口」改成 ${env.port}。`,
    );
  });
}

// 端口相关失败自解释：容器平台探针端口与监听端口不一致时，日志里只会看到
// 「Liveness probe failed: dial tcp ...:XX connect: connection refused」，
// 极难定位。这里把 EACCES/EADDRINUSE 变成明确指引。
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EACCES') {
    console.error(
      `[fatal] 无法监听端口 ${env.port}：当前环境不允许绑定该端口（通常是 1024 以下需要额外权限）。` +
      '请把云托管服务的「端口」改成 8080（与 Dockerfile 的 ENV PORT=8080 一致）。',
    );
  } else if (error.code === 'EADDRINUSE') {
    console.error(`[fatal] 端口 ${env.port} 已被占用，请检查是否有重复实例或改用其他 PORT`);
  } else {
    console.error(`[fatal] 监听端口 ${env.port} 失败：${error.message}`);
  }
  process.exit(1);
});

// ---------- 过期未支付订单自动取消（回滚库存） ----------
// 时长与前端倒计时同源：orderExpireMinutes()（ORDER_EXPIRE_MINUTES，默认 30 分钟）。
// 扫单只是兜底——用户打开详情/列表时，读接口本身就会把到期的单当场关掉。
const EXPIRE_MINUTES = orderExpireMinutes();
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
console.log(`[sweep] 未支付订单超时关闭时长：${EXPIRE_MINUTES} 分钟`);

// 启动时先补一轮（覆盖进程停机期间到期的订单）
cancelExpiredOrders(EXPIRE_MINUTES).then((n) => {
  if (n > 0) console.log(`[sweep] 启动扫单取消 ${n} 笔超时订单`);
}).catch(() => {});

const sweepTimer = setInterval(() => {
  cancelExpiredOrders(EXPIRE_MINUTES).catch(() => {});
}, SWEEP_INTERVAL_MS);
sweepTimer.unref();

// ---------- 支付对账：主动查单补落（回调延迟/丢失时的兜底） ----------
// 每 2 分钟扫一轮最近 2 小时内仍「待支付」的订单，向微信支付查单，已支付则落库。
// 只依赖回调会出现「用户已付款、订单仍待支付」，这是最严重的资损场景。
const RECONCILE_INTERVAL_MS = 2 * 60 * 1000;
const reconcileTimer = setInterval(() => {
  reconcilePendingPayments().catch(() => {});
}, RECONCILE_INTERVAL_MS);
reconcileTimer.unref();

// ---------- 履约对账：把微信侧的「已发货 / 已收货 / 交易完成」拉回本地 ----------
// 商家在微信后台「订单发货管理」录发货只会更新微信侧，不回调我们；微信 T+10 自动确认
// 收货同样不回写。不主动拉就会出现「商家已发货、用户侧一直显示待发货」。
// 每 5 分钟扫一轮近 60 天的待发货/已发货订单（单轮上限 50 笔，单笔 30 秒节流）。
const FULFILL_INTERVAL_MS = 5 * 60 * 1000;
const fulfillTimer = setInterval(() => {
  reconcileFulfillment().catch(() => {});
}, FULFILL_INTERVAL_MS);
fulfillTimer.unref();

// ---------- 自动确认收货：发货满 N 天（默认 10，与微信 T+10 对齐）置为已完成 ----------
// 微信侧的自动确认只更新微信侧、不回写本地；没接入发货管理的单在微信侧更不会自动确认。
// 用户也常常不主动点「确认收货」，本地必须自己兜住，否则订单永远停在待收货。
// 每 10 分钟扫一轮；用户打开订单详情时也会按同一口径当场判定。
const AUTO_CONFIRM_DAYS = autoConfirmDays();
const AUTO_CONFIRM_INTERVAL_MS = 10 * 60 * 1000;
console.log(`[auto-confirm] 发货后自动确认收货天数：${AUTO_CONFIRM_DAYS} 天`);
const autoConfirmTimer = setInterval(() => {
  autoCompleteShippedOrders().then((n) => {
    if (n > 0) console.log(`[auto-confirm] 本轮自动确认收货 ${n} 笔`);
  }).catch(() => {});
}, AUTO_CONFIRM_INTERVAL_MS);
autoConfirmTimer.unref();

// ---------- 售后：超时提醒 + 退款对账 ----------
// ① 商家超时未处理（默认 48h）→ 只标红提醒，**不自动同意、不自动退款**（必须商家确认）
// ② 买家超时未寄回（默认 7 天）→ 售后自动关闭（不涉及资金）
// ③ 卡在「退款中」的售后主动查一次微信，补落退款回调丢失的
// ④ 超过升级阈值（默认 3 天）仍未处理 → 每天固定时刻外发一次汇总提醒（可选 webhook）
// 每 10 分钟一轮。
const AFTER_SALE_INTERVAL_MS = 10 * 60 * 1000;
const afterSaleTimer = setInterval(() => {
  autoProgressAfterSales().then((n) => {
    if (n > 0) console.log(`[after-sale] 本轮自动关闭 ${n} 笔超时未退货售后`);
  }).catch(() => {});
  // 每日一次，内部自行去重；没配 webhook 就退化成日志
  alertOverdueAfterSales().catch(() => {});
  reconcileRefundingAfterSales().catch(() => {});
}, AFTER_SALE_INTERVAL_MS);
afterSaleTimer.unref();

// ---------- 优雅关闭：SIGTERM/SIGINT 时清理定时器并关闭 HTTP 连接 ----------
function gracefulShutdown(signal: string) {
  console.log(`\n[shutdown] ${signal} 收到，停止扫单定时器并关闭服务...`);
  clearInterval(sweepTimer);
  clearInterval(reconcileTimer);
  clearInterval(fulfillTimer);
  clearInterval(autoConfirmTimer);
  clearInterval(afterSaleTimer);
  server.close(() => {
    console.log('[shutdown] 服务已关闭');
    process.exit(0);
  });
  // 兜底：10 秒内未关闭则强制退出
  setTimeout(() => process.exit(1), 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
