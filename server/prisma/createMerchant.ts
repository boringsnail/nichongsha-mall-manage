// 手动创建/重置管控台商家账号（与容器启动时的自举逻辑共用同一实现）
//
// 用法：
//   ADMIN_USERNAME=merchant ADMIN_PASSWORD='你的强密码' npm run create-merchant
// 或复制 server/.env.local 里的值：
//   set -a && source .env.local && set +a && npm run create-merchant
import 'dotenv/config';
import { ensureMerchantAccount, readAdminBootstrapConfig } from '../src/services/merchantBootstrap.js';
import { prisma } from '../src/db.js';

const config = readAdminBootstrapConfig();
if (!config) {
  console.error('用法：ADMIN_USERNAME=xxx ADMIN_PASSWORD=yyy npm run create-merchant');
  process.exit(1);
}

try {
  const result = await ensureMerchantAccount(config.username, config.password);
  const label = {
    created: '已创建',
    updated: '密码已更新',
    unchanged: '已存在（密码一致，未改动）',
  }[result.action];
  console.log(`[create-merchant] 商家账号「${result.username}」${label}`);
} finally {
  await prisma.$disconnect();
}
