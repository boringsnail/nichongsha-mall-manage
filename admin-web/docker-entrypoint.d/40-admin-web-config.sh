#!/bin/sh
# 生成 nginx 站点配置（由 nginx 官方镜像的 /docker-entrypoint.sh 自动执行）。
#
# 解决两个真实故障：
#
# 1) 容器启动即退出。原实现用 CMD 里的一句 sh -c 判断 API_UPSTREAM，
#    未配置时 exit 1，容器直接死掉，云托管探针只能看到
#    "Readiness probe failed: dial tcp ...:8080: connect: connection refused"，
#    完全看不出真实原因。现在缺失时仍照常启动 nginx，仅 /api/ 返回 502，
#    页面可打开、日志里能读到明确的处理指引。
#
# 2) 后端返回 404（路径被改写）。nginx 的 proxy_pass 若带 URI 部分
#    （例如用户习惯性地配成 https://host/），会用该 URI 替换 location 前缀，
#    导致 /api/admin/users 被改成 /admin/users。这里强制去掉末尾斜杠。
set -e

CONF=/etc/nginx/conf.d/default.conf
PORT="${PORT:-8080}"

# 去掉所有空白（防止控制台粘贴带入换行）与末尾斜杠
API_UPSTREAM="$(printf '%s' "${API_UPSTREAM:-}" | tr -d '[:space:]')"
API_UPSTREAM="${API_UPSTREAM%/}"

if [ -n "$API_UPSTREAM" ]; then
    echo "[admin-web] /api/ 反向代理 -> ${API_UPSTREAM}"
    cat > "$CONF" <<EOF
server {
    listen ${PORT};
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    location = /healthz {
        access_log off;
        default_type text/plain;
        return 200 "ok\n";
    }

    location /api/ {
        proxy_pass ${API_UPSTREAM};
        proxy_http_version 1.1;
        proxy_set_header Host \$proxy_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_ssl_server_name on;
        proxy_connect_timeout 10s;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
        add_header X-Content-Type-Options nosniff always;
        add_header X-Frame-Options DENY always;
        add_header Referrer-Policy strict-origin-when-cross-origin always;
    }
}
EOF
else
    echo "[admin-web][warn] 未配置 API_UPSTREAM：页面可访问，但 /api/ 接口将返回 502。" >&2
    echo "[admin-web][warn] 请在云托管控制台「服务设置 → 环境变量」添加 API_UPSTREAM=<后端服务公网域名>。" >&2
    cat > "$CONF" <<EOF
server {
    listen ${PORT};
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    location = /healthz {
        access_log off;
        default_type text/plain;
        return 200 "ok\n";
    }

    location /api/ {
        default_type application/json;
        return 502 '{"code":502,"message":"后端地址未配置：请在云托管控制台设置环境变量 API_UPSTREAM"}';
    }

    location / {
        try_files \$uri \$uri/ /index.html;
        add_header X-Content-Type-Options nosniff always;
        add_header X-Frame-Options DENY always;
        add_header Referrer-Policy strict-origin-when-cross-origin always;
    }
}
EOF
fi

# 配置自检：语法问题在这里暴露，而不是等 nginx 启动失败后只剩探针报错
nginx -t
