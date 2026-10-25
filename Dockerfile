# CloudBase Cloud Hosting builds from the repository root. The API project lives
# in server/, so every COPY source is rooted there while the build context stays
# at the repository root.

FROM node:20-slim AS deps
WORKDIR /app
COPY server/package.json server/package-lock.json ./
COPY server/prisma ./prisma
RUN npm ci

FROM node:20-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY server/ ./
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
RUN npx prisma generate
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8080
# 微信云托管「开放接口服务」（云调用）会在容器内给 api.weixin.qq.com 挂一张一次性自签名证书，
# 证书落在 /app/cert/certificate.crt。Node 自带根证书库，需要显式追加，否则容器内调
# 小程序开放接口会报 DEPTH_ZERO_SELF_SIGNED_CERT（表现为发货状态永远同步不过来）。
# 该文件只在云托管容器内存在；本地/其他环境不存在时 Node 只会打印一条 warning，不影响启动。
ENV NODE_EXTRA_CA_CERTS=/app/cert/certificate.crt
WORKDIR /app
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r app \
    && useradd -r -g app app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/prisma ./prisma
USER app
EXPOSE 8080
CMD ["node", "dist/src/start.js"]
