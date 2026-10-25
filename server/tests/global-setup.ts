// 全局测试准备：重置测试数据库（globalSetup 在主进程执行一次）
import { execSync } from 'node:child_process';

export default async function setup() {
  // 删除并重建测试数据库
  execSync('mysql -u root -e "DROP DATABASE IF EXISTS nichongsha_test;"', { stdio: 'pipe' });
  execSync('mysql -u root -e "CREATE DATABASE nichongsha_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"', { stdio: 'pipe' });
  // 推送 schema 到测试库
  execSync('npx prisma db push --accept-data-loss --force-reset', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: 'mysql://root:@localhost:3306/nichongsha_test' },
  });
  console.log('[test] nichongsha_test 已重置并推送 schema');
}
