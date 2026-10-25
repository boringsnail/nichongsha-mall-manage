import { spawn, spawnSync } from 'node:child_process';
import { env, isDbConfigDebugEnabled } from './config/env.js';

// Prisma CLI 需要标准 URL；云托管支持 DATABASE_URL，或 DB_HOST/DB_PORT
// 配合 DB_USER/DB_PASS/DB_NAME，由 env 配置模块统一转换。
process.env.DATABASE_URL = env.databaseUrl;

// 启动即打印「用哪个账号连哪个库、配置来自哪组变量」——容器日志里就能定位配置问题（不含密码）
// 数据库排障信息默认不打印（含账号名/配置来源/变量设置情况，都不会输出密码）。
// 需要在容器日志里定位数据库配置时，加环境变量 DB_CONFIG_DEBUG=1 重新部署。
if (isDbConfigDebugEnabled()) {
  console.log(
    `[nichongsha-server] 数据库账号 ${env.databaseUser}@${env.databaseTarget}` +
    `（配置来源：${env.databaseSource}，NODE_ENV=${process.env.NODE_ENV ?? 'development'}）`,
  );
  console.log(`[nichongsha-server] 数据库变量：${env.envPresence}`);
}
// 配置异常（账号与库名相同、新旧变量并存、密码首尾带空白等）仍然照常告警
for (const warning of env.databaseWarnings) {
  console.warn(`[warn] ${warning}`);
}

/** Prisma 常见错误码 → 可执行的排查提示（避免日志只剩一行错误码） */
function migrationHints(output: string): string[] {
  const hints: string[] = [];
  if (/P1000/.test(output)) {
    hints.push(
      `数据库认证失败（P1000）：账号或密码不对。当前使用的账号是「${env.databaseUser}」` +
      '（注意 Prisma 这条报错里引号中的名字是"账号"，不是库名），' +
      '请核对云数据库控制台里的账号密码；同时检查是否有残留的旧 DATABASE_URL/DB_USER 覆盖了新值。',
    );
    if (env.databaseUser === env.databaseName) {
      hints.push(
        `账号「${env.databaseUser}」与库名完全相同，几乎可以确定是把库名填进了 DB_USER；` +
        '云数据库控制台里的真实账号通常是 root，把它填到 DB_USER（或改用完整 DATABASE_URL）即可。',
      );
    }
  }
  if (/P1001|Can't reach database server/i.test(output)) {
    hints.push('连不上数据库（P1001）：确认 DB_HOST/DB_PORT 是同一 VPC 的内网地址，且云数据库允许该服务访问。');
  }
  if (/P1010|denied access on the database/i.test(output)) {
    hints.push('账号能登录但无权访问该库：确认 DB_NAME 与云数据库里实际创建的库名一致，或在控制台给该账号授权。');
  }
  if (/P1003|does not exist/i.test(output)) {
    hints.push('目标库不存在：多半是库名不对，用云开发控制台 → 数据库 里看到的库名配置 DB_NAME。');
  }
  if (/P3009/.test(output)) {
    hints.push('库里残留失败迁移记录（P3009）：执行一次 `npx prisma migrate resolve --rolled-back 20261011000000_init` 后重新部署。');
  }
  if (/P3018/.test(output)) {
    hints.push('迁移执行失败（P3018）：看上面 "Database error code" 那一行；若是 "Table ... already exists"，说明库里已有半成品表，需人工确认后再决定 resolve 还是清库。');
  }
  return hints;
}

// stdio 用 pipe 而不是 inherit：先收下来再逐个输出，便于扫描错误码给出排查提示
const migration = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  env: process.env,
  encoding: 'utf8',
});
if (migration.stdout) process.stdout.write(migration.stdout);
if (migration.stderr) process.stderr.write(migration.stderr);

if (migration.error) {
  console.error(`[fatal] 无法启动 Prisma 数据库迁移：${migration.error.message}`);
  process.exit(1);
}
if (migration.status !== 0) {
  const output = `${migration.stdout ?? ''}\n${migration.stderr ?? ''}`;
  for (const hint of migrationHints(output)) console.error(`[fatal] ${hint}`);
  process.exit(migration.status ?? 1);
}

// ---------- 商家（管控台）账号自举：只在配了 ADMIN_USERNAME/ADMIN_PASSWORD 时执行 ----------
// 空库上线时用来自举第一个管控台账号，或改密码时重新部署一次即可。
// 只写 Merchant 一张表，不碰任何业务数据；不需要了就把这两个变量删掉。
{
  const { readAdminBootstrapConfig } = await import('./services/merchantBootstrap.js');
  let adminConfig: { username: string; password: string } | null = null;
  try {
    adminConfig = readAdminBootstrapConfig();
  } catch (error) {
    console.error(`[fatal] 商家账号自举配置有误：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  if (adminConfig) {
    try {
      const [{ ensureMerchantAccount }, { prisma }] = await Promise.all([
        import('./services/merchantBootstrap.js'),
        import('./db.js'),
      ]);
      const result = await ensureMerchantAccount(adminConfig.username, adminConfig.password);
      const label = {
        created: '已创建',
        updated: '密码已更新',
        unchanged: '已存在（密码一致，未改动）',
      }[result.action];
      console.log(`[bootstrap] 商家账号「${result.username}」${label}；不需要自举后请删除 ADMIN_USERNAME/ADMIN_PASSWORD`);
      await prisma.$disconnect();
    } catch (error) {
      console.error(`[fatal] 商家账号自举失败：${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }
}

const server = spawn(process.execPath, ['dist/src/index.js'], {
  env: process.env,
  stdio: 'inherit',
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.kill(signal));
}
server.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
