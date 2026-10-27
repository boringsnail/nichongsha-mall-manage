import type { CapacitorConfig } from '@capacitor/cli';

/**
 * 商家调度台 · 原生壳
 *
 * 业务代码一行都不在这里：webDir 指向 admin-web 的构建产物，
 * 每次改完前端跑 `npm run build:web` 就会把 dist 拷进 android/app/src/main/assets/public。
 */
const config: CapacitorConfig = {
  appId: 'cn.nichongsha.admin',
  appName: '你宠啥',
  webDir: '../admin-web/dist-app',
  // 安卓上页面跑在 https://localhost（安全上下文，才能用 Clipboard / Notification 等 API）
  android: {
    androidScheme: 'https',
    // 禁止 http 明文：所有接口都是 https，混入 http 会被系统拦掉
    allowMixedContent: false,
  },
  ios: {
    contentInset: 'always',
    limitsNavigationsToAppBoundDomains: false,
  },
  plugins: {
    // 状态栏交给页面自己控制：深浅主题切换时同步改图标颜色
    StatusBar: {
      overlaysWebView: false,
      style: 'DARK',
      backgroundColor: '#f2f4f7',
    },
  },
};

export default config;
