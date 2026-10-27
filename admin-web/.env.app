# 原生 App（Capacitor）构建专用：WebView 里没有 nginx 反代，必须写绝对地址。
# Web 端仍用 /api 相对路径（见 http.ts），两者互不影响。
VITE_API_BASE=https://mall-admin-web-326900-12-1504359859.sh.run.tcloudbase.com/api
