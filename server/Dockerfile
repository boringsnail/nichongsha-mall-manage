# 你宠啥 · 后端 —— 微信云托管（TSE）部署镜像
# 多阶段构建：安装依赖 → Prisma 生成 + tsc 编译 → 精简运行时
# 云托管会自动注入 PORT 环境变量；容器内监听 0.0.0.0

# ---------- 1. 安装依赖 ----------
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# ---------- 2. 生成 Prisma Client + 编译 ----------
FROM node:20-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Prisma 引擎需要 openssl 动态库
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
RUN npx prisma generate
RUN npm run build
# 移除 devDependencies，缩减镜像
RUN npm prune --omit=dev

# ---------- 3. 运行时 ----------
FROM node:20-slim
ENV NODE_ENV=production
# 默认监听 8080，与 container.config.json 的 containerPort 对齐；云托管/部署方可用 PORT 覆盖
ENV PORT=8080
# 微信云托管「开放接口服务」（云调用）会在容器内给 api.weixin.qq.com 挂一张一次性自签名证书，
# 证书落在 /app/cert/certificate.crt，需要让 Node 信任它，否则容器内调小程序开放接口会报
# DEPTH_ZERO_SELF_SIGNED_CERT（表现为订单发货状态永远同步不过来）。
# 该文件只在云托管容器内存在；不存在时 Node 仅打印 warning，不影响启动。
ENV NODE_EXTRA_CA_CERTS=/app/cert/certificate.crt
WORKDIR /app
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/* \
    && groupadd -r app && useradd -r -g app app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --chown=app:app package.json ./package.json
COPY --chown=app:app prisma ./prisma
USER app
EXPOSE 8080
# 启动时执行 prisma migrate deploy（幂等：已应用的迁移跳过），再启动服务
CMD ["node", "dist/src/start.js"]
