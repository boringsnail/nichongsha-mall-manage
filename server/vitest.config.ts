import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/env.setup.ts'],
    // 测试间共享同一数据库，串行执行避免冲突
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});