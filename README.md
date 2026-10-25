# 你宠啥商城管理端

商城管理后台，包含前端管理界面和后端管理接口。

## 目录结构

```
├── admin-web/          # 管理端前端 (Vue 3 + Ant Design Vue)
├── server/             # 管理端后端 (Express + Prisma)
│   ├── src/
│   │   ├── routes/     # API 路由
│   │   ├── services/   # 业务逻辑
│   │   └── config/     # 配置
│   └── prisma/         # 数据库模型
├── Dockerfile          # 后端 Docker 构建配置
└── admin-web/Dockerfile  # 前端 Docker 构建配置
```

## 快速开始

### 后端

```bash
cd server
npm install
npm run build
npm start
```

### 前端

```bash
cd admin-web
npm install
npm run dev
```

## 环境变量

| 变量名 | 说明 |
|--------|------|
| DATABASE_URL | MySQL 数据库连接串 |
| JWT_SECRET | JWT 密钥 |
| WX_APPID | 微信 AppID |
| WX_APPSECRET | 微信 AppSecret |
| PORT | 服务端口 (默认 8080) |

## 部署

项目包含完整的 Docker 配置，支持微信云托管部署。
