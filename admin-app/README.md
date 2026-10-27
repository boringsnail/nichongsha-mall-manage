# admin-app · 你宠啥商家调度台（iOS / Android 原生壳）

Capacitor 7 混合工程。**这里没有业务代码** —— 界面全部来自 `../admin-web`，
本目录只负责把 Web 产物打进原生安装包，并桥接系统能力（状态栏等）。

## 目录

```
admin-app/
├─ capacitor.config.ts     appId / 应用名 / webDir / 状态栏
├─ android/                Android 工程（Gradle + 签名）
│  ├─ keystore/            发布签名（不入库，见下）
│  └─ keystore.properties  签名口令（不入库）
└─ ios/                    执行 `npx cap add ios` 后生成（需 macOS + Xcode）
```

## 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| JDK | **21** | AGP 8.7 不支持 JDK 27，会报 class file 版本错误 |
| Android SDK | platform 35 + build-tools 35.0.0 | `sdkmanager "platforms;android-35" "build-tools;35.0.0"` |
| Node | 22 | 与 admin-web 一致 |

`android/local.properties` 里写 `sdk.dir=<你的 SDK 路径>`（不入库）。

## 构建

```bash
# 1. 打 App 专用前端产物（接口地址走 .env.app 的绝对地址）
cd ../admin-web && npm run build:app      # 输出到 admin-web/dist-app

# 2. 同步进原生工程
cd ../admin-app && npx cap sync android

# 3. 出包
cd android && ./gradlew assembleRelease
# 产物：android/app/build/outputs/apk/release/app-release.apk
```

日常改完前端只需重跑 1~3；改了原生依赖（`package.json`）才需要 `npx cap sync` 之外的额外操作。

## 签名

`android/keystore/nichongsha-admin.jks` + `android/keystore.properties` **不进 git**，
需要单独备份（丢了就无法给已安装的 App 做覆盖升级）。

- alias：`nichongsha`
- 有效期：10000 天
- 证书指纹（SHA-256）：`F2:19:CA:9A:AA:34:CF:4B:31:38:FB:11:89:92:7E:EF:39:D0:34:0F:9E:9D:67:0C:A8:39:F1:6A:33:EE:F2:87`

## 接口地址

App 内没有 nginx 反代，接口必须是绝对地址 —— 见 `admin-web/.env.app` 的 `VITE_API_BASE`。
换域名时改这一个文件即可，Web 端不受影响（Web 仍用相对路径 `/api`）。

## 后端要求

App 的 WebView 来源固定是 `https://localhost`（Android）/ `capacitor://localhost`（iOS），
与后端永远跨域。`server/src/utils/origins.ts` 已放行这几个值，**部署后端时别漏掉**，
否则 App 内所有请求都会被 403 拦掉（表现为登录页「服务器开小差了」）。

## iOS

```bash
npx cap add ios
npx cap open ios        # 需要 Xcode；证书/描述文件在 Xcode 里配
```

未做 iOS 分发（用户选择先只做 Android）。
