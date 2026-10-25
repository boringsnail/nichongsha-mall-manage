/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * 后端 API 基地址。
   * - 本地开发（默认）：留空 → 走 '/api'，由 Vite devServer 代理到 http://localhost:3000
   * - 指向云端 API：构建时注入完整地址，例如
   *   VITE_API_BASE=https://your-service-xxxx.ap-shanghai.app.tcloudbase.com/api
   *   注意：该域名需在后端 ADMIN_ORIGINS 中放行，否则会被 CORS 拦截
   */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
