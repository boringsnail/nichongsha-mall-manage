# 你宠啥商家管理后台

Vue 3 + Vite 管理后台，提供商品、分类、库存、订单和营业数据管理。此仓库可直接通过 Dockerfile 部署为微信云托管服务。

## 本地开发

```sh
npm ci
npm run dev
```

本地 `/api` 请求由 Vite 代理到 `http://localhost:3000`。请先启动商城 API 服务。

## 微信云托管部署

1. 将本仓库授权给微信云托管后创建代码仓库部署。
2. **目标目录选择 `admin-web`（本目录）**，Dockerfile 名称填写 `Dockerfile`。
   > ⚠️ 不要选仓库根目录：根目录没有 `package.json`（本 Dockerfile 第一条就是
   > `COPY package.json package-lock.json ./`，会直接构建失败）；而且根目录的
   > `Dockerfile` 是**后端**镜像，根 `.dockerignore` 里也明确排除了 `admin-web`。
3. 容器监听端口填写 `8080`。
4. 设置运行时环境变量 `API_UPSTREAM`，值为商城 API 服务的 HTTPS 域名 origin，例如 `https://<api-service-domain>`；不要在末尾添加 `/api`，也不要带结尾 `/`。未设置时容器会直接退出（启动脚本有显式守卫）。
5. 部署后检查 `GET /healthz` 返回 `200`，再访问登录页和 `/api` 接口。

后台把 `/api/...` 请求转发到 `API_UPSTREAM`。因为转发发生在 nginx 服务端，浏览器视角始终同源，**这条容器路径不需要**在 API 服务里配 `ADMIN_ORIGINS`——只有走「静态网站 + 构建时 `VITE_API_BASE`」那条路径才需要（浏览器会直连 API 域名）。数据库、微信密钥和 JWT 密钥只配置在 API 服务，不放在本仓库或后台服务。

生产环境建议绑定已备案的自定义域名，并通过云托管控制台开启 HTTPS 与公网访问策略。后台登录仍由 API 服务鉴权。
