FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:stable-alpine

# 容器内端口，与云托管「服务设置 → 端口」保持一致
ENV PORT=8080

# 站点配置在容器启动时由下面的脚本生成。
# 不走 /etc/nginx/templates：那里由 nginx 镜像自带的 envsubst 处理，
# 若沿用模板机制，API_UPSTREAM 为空时 nginx 会因 proxy_pass 无值而启动失败。
COPY docker-entrypoint.d/40-admin-web-config.sh /docker-entrypoint.d/40-admin-web-config.sh
RUN chmod +x /docker-entrypoint.d/40-admin-web-config.sh

# 基线配置：即使入口脚本没有执行，nginx 也能起来并响应 /healthz。
# 上面的脚本会在启动时把它覆盖为带反向代理的版本。
RUN printf 'server {\n\
    listen 8080;\n\
    server_name _;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
    location = /healthz { access_log off; default_type text/plain; return 200 "ok\\n"; }\n\
    location / { try_files $uri $uri/ /index.html; }\n\
}\n' > /etc/nginx/conf.d/default.conf

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080

# 显式声明入口脚本：它会依次执行 /docker-entrypoint.d/*.sh（含上面的配置生成），
# 再 exec 传入的命令。写出来是为了不依赖镜像未来的默认行为变化。
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
